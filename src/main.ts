import { Notice, Plugin, TFile, TAbstractFile, debounce } from "obsidian";
import {
  OvhSyncSettings,
  DEFAULT_SETTINGS,
  OvhSyncSettingTab,
  getEndpoint,
  resolveCredentials,
} from "./settings";
import { S3Client } from "./s3/client";
import { SyncEngine } from "./sync/engine";
import { SyncMetadata, emptyMetadata } from "./sync/tracker";
import { StatusBar } from "./ui/status";

interface PluginData {
  settings: OvhSyncSettings;
  syncMetadata: SyncMetadata;
}

export default class OvhCloudSync extends Plugin {
  settings: OvhSyncSettings = DEFAULT_SETTINGS;
  private syncMetadata: SyncMetadata = emptyMetadata();
  private syncEngine!: SyncEngine;
  private statusBar!: StatusBar;
  private autoSyncTimer: number | null = null;
  private pendingChanges = new Set<string>();
  private processingChanges = false;
  private debouncedProcessChanges!: () => void;
  // Track files we're currently downloading to avoid re-uploading them
  private downloadingPaths = new Set<string>();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.statusBar = new StatusBar(this);

    const s3 = this.createS3Client();
    const excludePatterns = this.getExcludePatterns();

    this.syncEngine = new SyncEngine(
      this.app.vault,
      s3,
      excludePatterns,
      () => this.syncMetadata,
      (meta) => this.saveSyncMetadata(meta)
    );

    if (!this.isConfigured()) {
      this.statusBar.setDisconnected();
    }

    // Ribbon icon for manual sync
    this.addRibbonIcon("refresh-cw", "Sync with OVH Cloud", async () => {
      await this.runFullSync();
    });

    // Command palette
    this.addCommand({
      id: "full-sync",
      name: "Run full sync",
      callback: () => this.runFullSync(),
    });

    this.addCommand({
      id: "force-upload-all",
      name: "Force upload all files",
      callback: () => this.forceUploadAll(),
    });

    // Settings tab
    this.addSettingTab(new OvhSyncSettingTab(this.app, this));

    // Debounced change processor
    this.debouncedProcessChanges = debounce(
      () => this.processChanges(),
      this.settings.debounceDelay,
      true
    );

    // File watchers for on-change sync
    this.registerEvent(
      this.app.vault.on("modify", (file) => this.onFileChange(file))
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => this.onFileChange(file))
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => this.onFileDelete(file))
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) =>
        this.onFileRename(file, oldPath)
      )
    );

    // Start auto-sync timer
    this.setupAutoSync();
  }

  onunload(): void {
    if (this.autoSyncTimer !== null) {
      window.clearInterval(this.autoSyncTimer);
    }
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as PluginData | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
    this.syncMetadata = data?.syncMetadata || emptyMetadata();

    // Fix stale metadata: if lastFullSync is set but no files are tracked,
    // a previous broken sync marked completion without uploading anything.
    // Reset so the next sync is treated as a proper first sync.
    if (
      this.syncMetadata.lastFullSync > 0 &&
      Object.keys(this.syncMetadata.files).length === 0
    ) {
      this.syncMetadata = emptyMetadata();
    }

    // Migrate legacy plaintext credentials to SecretStorage
    await this.migrateLegacyCredentials();
  }

  private async migrateLegacyCredentials(): Promise<void> {
    let migrated = false;

    if (this.settings.accessKey) {
      const secretName = "ovh-sync-access-key";
      this.app.secretStorage.setSecret(secretName, this.settings.accessKey);
      this.settings.accessKeySecret = secretName;
      delete this.settings.accessKey;
      migrated = true;
    }

    if (this.settings.secretKey) {
      const secretName = "ovh-sync-secret-key";
      this.app.secretStorage.setSecret(secretName, this.settings.secretKey);
      this.settings.secretKeySecret = secretName;
      delete this.settings.secretKey;
      migrated = true;
    }

    if (migrated) {
      await this.saveSettings();
      new Notice("OVH Cloud Sync: Credentials migrated to secure storage.");
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      syncMetadata: this.syncMetadata,
    } as PluginData);

    // Update engine with new settings
    if (this.syncEngine) {
      this.syncEngine.updateS3Client(this.createS3Client());
      this.syncEngine.updateExcludePatterns(this.getExcludePatterns());
    }
    this.setupAutoSync();
  }

  private async saveSyncMetadata(meta: SyncMetadata): Promise<void> {
    this.syncMetadata = meta;
    await this.saveData({
      settings: this.settings,
      syncMetadata: this.syncMetadata,
    } as PluginData);
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    const s3 = this.createS3Client();
    return s3.testConnection();
  }

  private createS3Client(): S3Client {
    const { accessKey, secretKey } = resolveCredentials(this.app, this.settings);
    return new S3Client({
      endpoint: getEndpoint(this.settings),
      region: this.settings.region,
      accessKey,
      secretKey,
      bucket: this.settings.bucket,
      prefix: this.settings.prefix,
    });
  }

  private getExcludePatterns(): string[] {
    return this.settings.excludePatterns
      .split("\n")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }

  private isConfigured(): boolean {
    const { accessKey, secretKey } = resolveCredentials(this.app, this.settings);
    return !!(accessKey && secretKey && this.settings.bucket);
  }

  private setupAutoSync(): void {
    if (this.autoSyncTimer !== null) {
      window.clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }

    if (this.settings.autoSyncInterval > 0 && this.isConfigured()) {
      const ms = this.settings.autoSyncInterval * 60 * 1000;
      this.autoSyncTimer = window.setInterval(() => {
        this.runFullSync();
      }, ms);
      this.registerInterval(this.autoSyncTimer);
    }
  }

  private hasCompletedFirstSync(): boolean {
    return this.syncMetadata.lastFullSync > 0;
  }

  private onFileChange(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    if (!this.isConfigured()) return;
    if (!this.hasCompletedFirstSync()) return;
    if (this.isExcluded(file.path)) return;
    if (this.syncEngine.isSyncing) return;
    if (this.downloadingPaths.has(file.path)) return;

    const tracked = this.syncMetadata.files[file.path];
    if (
      tracked &&
      Math.abs(file.stat.mtime - tracked.mtime) <= 1000 &&
      file.stat.size === tracked.size
    ) {
      return;
    }

    this.pendingChanges.add(file.path);
    this.debouncedProcessChanges();
  }

  private onFileDelete(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    if (!this.isConfigured()) return;
    if (!this.hasCompletedFirstSync()) return;
    if (this.isExcluded(file.path)) return;

    // If the file was tracked, delete it remotely
    if (this.syncMetadata.files[file.path]) {
      this.syncEngine.deleteRemoteFile(file.path).catch((e) => {
        console.error(`OVH Sync: failed to delete remote ${file.path}`, e);
      });
    }
  }

  private onFileRename(file: TAbstractFile, oldPath: string): void {
    if (!(file instanceof TFile)) return;
    if (!this.isConfigured()) return;
    if (!this.hasCompletedFirstSync()) return;

    // Delete old path remotely if tracked
    if (this.syncMetadata.files[oldPath]) {
      this.syncEngine.deleteRemoteFile(oldPath).catch((e) => {
        console.error(`OVH Sync: failed to delete remote ${oldPath}`, e);
      });
    }

    // Upload to new path
    if (!this.isExcluded(file.path)) {
      this.pendingChanges.add(file.path);
      this.debouncedProcessChanges();
    }
  }

  private async processChanges(): Promise<void> {
    if (this.processingChanges || this.pendingChanges.size === 0) return;

    this.processingChanges = true;
    const paths = [...this.pendingChanges];
    this.pendingChanges.clear();

    this.statusBar.setSyncing();

    let errors = 0;
    for (const path of paths) {
      try {
        await this.syncEngine.uploadFile(path);
      } catch (e) {
        errors++;
        console.error(`OVH Sync: failed to upload ${path}`, e);
      }
    }

    this.statusBar.setResult(paths.length - errors, 0, errors);
    this.processingChanges = false;

    // Process any changes that came in while we were syncing
    if (this.pendingChanges.size > 0) {
      this.debouncedProcessChanges();
    }
  }

  private async runFullSync(): Promise<void> {
    if (!this.isConfigured()) {
      new Notice("OVH Cloud Sync: Please configure your S3 credentials first.");
      return;
    }

    if (this.syncEngine.isSyncing) {
      new Notice("OVH Cloud Sync: Sync already in progress.");
      return;
    }

    this.statusBar.setSyncing();
    new Notice("OVH Cloud Sync: Starting sync...");

    const result = await this.syncEngine.fullSync();

    // Mark downloaded files so the on-change handler doesn't re-upload them.
    // Events may fire asynchronously after the sync finishes, so keep the
    // guard for a short window.
    for (const path of result.downloadedPaths) {
      this.downloadingPaths.add(path);
    }
    // Discard any change events that queued during the sync
    this.pendingChanges.clear();
    if (result.downloadedPaths.length > 0) {
      setTimeout(() => {
        for (const path of result.downloadedPaths) {
          this.downloadingPaths.delete(path);
        }
      }, 10000);
    }

    if (result.errors.length > 0) {
      const msg = `OVH Sync: ${result.errors.length} error(s). ${result.errors}`;
      new Notice(msg);
      for (const err of result.errors) {
        console.error("OVH Sync:", err);
      }
    } else {
      const parts: string[] = [];
      if (result.uploaded > 0) parts.push(`↑${result.uploaded}`);
      if (result.downloaded > 0) parts.push(`↓${result.downloaded}`);
      if (result.deletedLocal > 0) parts.push(`del local: ${result.deletedLocal}`);
      if (result.deletedRemote > 0) parts.push(`del remote: ${result.deletedRemote}`);
      if (result.conflicts > 0) parts.push(`conflicts: ${result.conflicts}`);
      if (result.skippedDeletes > 0) parts.push(`skipped deletes: ${result.skippedDeletes}`);
      if (parts.length === 0) parts.push("up to date");
      new Notice(`OVH Cloud Sync: ${parts.join(", ")}`);
    }

    this.statusBar.setResult(
      result.uploaded,
      result.downloaded,
      result.errors.length
    );
  }

  private async forceUploadAll(): Promise<void> {
    if (!this.isConfigured()) {
      new Notice("OVH Cloud Sync: Please configure your S3 credentials first.");
      return;
    }

    this.statusBar.setSyncing();
    new Notice("OVH Cloud Sync: Uploading all files...");

    const files = this.app.vault.getFiles().filter(
      (f) => !this.isExcluded(f.path)
    );

    let uploaded = 0;
    let errors = 0;

    for (const file of files) {
      try {
        await this.syncEngine.uploadFile(file.path);
        uploaded++;
      } catch (e) {
        errors++;
        console.error(`OVH Sync: failed to upload ${file.path}`, e);
      }
    }

    new Notice(`OVH Cloud Sync: Uploaded ${uploaded} files, ${errors} errors.`);
    this.statusBar.setResult(uploaded, 0, errors);
  }

  private isExcluded(path: string): boolean {
    return this.getExcludePatterns().some(
      (pattern) => pattern && path.startsWith(pattern)
    );
  }
}
