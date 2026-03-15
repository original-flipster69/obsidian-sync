import { Vault, TFile, Notice } from "obsidian";
import { S3Client } from "../s3/client";
import {
  SyncMetadata,
  LocalFile,
  RemoteFile,
  SyncAction,
  computeSyncActions,
  FileRecord,
} from "./tracker";

const MAX_DELETE_FRACTION = 0.5;
const MIN_DELETE_THRESHOLD = 5;

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  skippedDeletes: number;
  errors: string[];
  downloadedPaths: string[];
}

export class SyncEngine {
  private syncing = false;

  constructor(
    private vault: Vault,
    private s3: S3Client,
    private excludePatterns: string[],
    private getMetadata: () => SyncMetadata,
    private saveMetadata: (meta: SyncMetadata) => Promise<void>
  ) {}

  get isSyncing(): boolean {
    return this.syncing;
  }

  updateExcludePatterns(patterns: string[]): void {
    this.excludePatterns = patterns;
  }

  updateS3Client(client: S3Client): void {
    this.s3 = client;
  }

  private isExcluded(path: string): boolean {
    return this.excludePatterns.some(
      (pattern) => pattern && path.startsWith(pattern)
    );
  }

  async fullSync(): Promise<SyncResult> {
    if (this.syncing) {
      return { uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, skippedDeletes: 0, errors: ["Sync already in progress"], downloadedPaths: [] };
    }

    this.syncing = true;
    const result: SyncResult = {
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: 0,
      skippedDeletes: 0,
      errors: [],
      downloadedPaths: [],
    };

    try {
      const localFiles = this.getLocalFiles();
      const remoteFiles = await this.getRemoteFiles();
      const metadata = this.getMetadata();
      const isFirstSync = metadata.lastFullSync === 0;

      let actions = computeSyncActions(localFiles, remoteFiles, metadata);

      if (isFirstSync) {
        actions = actions.filter((a) => {
          if (a.type === "deleteRemote" || a.type === "deleteLocal") {
            result.skippedDeletes++;
            return false;
          }
          return true;
        });
        actions = actions.map((a) => {
          if (a.type === "conflict") {
            return { ...a, resolution: "download" as const };
          }
          return a;
        });
      }

      if (!isFirstSync) {
        const trackedCount = Object.keys(metadata.files).length;
        const deleteRemoteCount = actions.filter((a) => a.type === "deleteRemote").length;
        const deleteLocalCount = actions.filter((a) => a.type === "deleteLocal").length;

        const tooManyRemoteDeletes = trackedCount > MIN_DELETE_THRESHOLD &&
          deleteRemoteCount > trackedCount * MAX_DELETE_FRACTION;
        const tooManyLocalDeletes = trackedCount > MIN_DELETE_THRESHOLD &&
          deleteLocalCount > trackedCount * MAX_DELETE_FRACTION;

        if (tooManyRemoteDeletes || tooManyLocalDeletes) {
          const skippedTypes = new Set<string>();
          if (tooManyRemoteDeletes) skippedTypes.add("remote");
          if (tooManyLocalDeletes) skippedTypes.add("local");

          actions = actions.filter((a) => {
            if (a.type === "deleteRemote" && tooManyRemoteDeletes) {
              result.skippedDeletes++;
              return false;
            }
            if (a.type === "deleteLocal" && tooManyLocalDeletes) {
              result.skippedDeletes++;
              return false;
            }
            return true;
          });

          const msg = `Mass deletion prevented (${[...skippedTypes].join(" & ")}). ` +
            `Would have deleted ${deleteRemoteCount} remote / ${deleteLocalCount} local ` +
            `out of ${trackedCount} tracked files. Run "Force upload all" or manually delete to resolve.`;
          result.errors.push(msg);
          new Notice(`OVH Sync: ${msg}`, 10000);
        }
      }

      for (const action of actions) {
        try {
          await this.executeAction(action, metadata);
          switch (action.type) {
            case "upload":
              result.uploaded++;
              break;
            case "download":
              result.downloaded++;
              result.downloadedPaths.push(action.path);
              break;
            case "deleteLocal":
              result.deletedLocal++;
              break;
            case "deleteRemote":
              result.deletedRemote++;
              break;
            case "conflict":
              result.conflicts++;
              if (action.resolution === "upload") {
                result.uploaded++;
              } else {
                result.downloaded++;
                result.downloadedPaths.push(action.path);
              }
              break;
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result.errors.push(`${action.type} ${action.path}: ${msg}`);
        }
      }

      const localPaths = new Set(localFiles.map((f) => f.path));
      const remotePaths = new Set(remoteFiles.map((f) => f.path));
      for (const path of Object.keys(metadata.files)) {
        if (!localPaths.has(path) && !remotePaths.has(path)) {
          delete metadata.files[path];
        }
      }

      metadata.lastFullSync = Date.now();
      await this.saveMetadata(metadata);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`Sync failed: ${msg}`);
    } finally {
      this.syncing = false;
    }

    return result;
  }

  async uploadFile(path: string): Promise<void> {
    if (this.isExcluded(path)) return;

    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    const content = await this.vault.readBinary(file);
    const mtime = file.stat.mtime;

    const etag = await this.s3.putObject(path, content, {
      mtime: String(mtime),
    });

    const metadata = this.getMetadata();
    metadata.files[path] = {
      mtime,
      size: content.byteLength,
      etag,
    };
    await this.saveMetadata(metadata);
  }

  async deleteRemoteFile(path: string): Promise<void> {
    await this.s3.deleteObject(path);
    const metadata = this.getMetadata();
    delete metadata.files[path];
    await this.saveMetadata(metadata);
  }

  private getLocalFiles(): LocalFile[] {
    const files: LocalFile[] = [];
    for (const file of this.vault.getFiles()) {
      if (this.isExcluded(file.path)) continue;
      files.push({
        path: file.path,
        mtime: file.stat.mtime,
        size: file.stat.size,
      });
    }
    return files;
  }

  private async getRemoteFiles(): Promise<RemoteFile[]> {
    const objects = await this.s3.listAllObjects();
    const remoteFiles: RemoteFile[] = [];

    for (const obj of objects) {
      if (this.isExcluded(obj.key)) continue;

      let mtime = obj.lastModified.getTime();

      try {
        const head = await this.s3.headObject(obj.key);
        if (head?.metadata?.mtime) {
          mtime = parseInt(head.metadata.mtime, 10);
        }
      } catch {
      }

      remoteFiles.push({
        path: obj.key,
        mtime,
        size: obj.size,
        etag: obj.etag,
      });
    }

    return remoteFiles;
  }

  private async executeAction(
    action: SyncAction,
    metadata: SyncMetadata
  ): Promise<void> {
    switch (action.type) {
      case "upload":
      case "conflict": {
        const doUpload =
          action.type === "upload" ||
          (action.type === "conflict" && action.resolution === "upload");

        if (doUpload) {
          await this.uploadFileWithMeta(action.path, metadata);
        } else {
          await this.downloadFile(action.path, metadata);
        }
        break;
      }
      case "download":
        await this.downloadFile(action.path, metadata);
        break;
      case "deleteLocal":
        await this.deleteLocalFile(action.path, metadata);
        break;
      case "deleteRemote":
        await this.deleteRemoteAndTrack(action.path, metadata);
        break;
    }
  }

  private async uploadFileWithMeta(
    path: string,
    metadata: SyncMetadata
  ): Promise<void> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    const content = await this.vault.readBinary(file);
    const mtime = file.stat.mtime;

    const etag = await this.s3.putObject(path, content, {
      mtime: String(mtime),
    });

    metadata.files[path] = {
      mtime,
      size: content.byteLength,
      etag,
    };
  }

  private async downloadFile(
    path: string,
    metadata: SyncMetadata
  ): Promise<void> {
    const data = await this.s3.getObject(path);

    const existingFile = this.vault.getAbstractFileByPath(path);
    if (existingFile instanceof TFile) {
      await this.vault.modifyBinary(existingFile, data);
    } else {
      const dir = path.substring(0, path.lastIndexOf("/"));
      if (dir) {
        await this.ensureDir(dir);
      }
      await this.vault.createBinary(path, data);
    }

    const file = this.vault.getAbstractFileByPath(path) as TFile;
    const head = await this.s3.headObject(path);

    metadata.files[path] = {
      mtime: file.stat.mtime,
      size: data.byteLength,
      etag: head?.etag || "",
    };
  }

  private async deleteLocalFile(
    path: string,
    metadata: SyncMetadata
  ): Promise<void> {
    const file = this.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.vault.delete(file);
    }
    delete metadata.files[path];
  }

  private async deleteRemoteAndTrack(
    path: string,
    metadata: SyncMetadata
  ): Promise<void> {
    await this.s3.deleteObject(path);
    delete metadata.files[path];
  }

  private async ensureDir(dir: string): Promise<void> {
    const parts = dir.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? current + "/" + part : part;
      const existing = this.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.vault.createFolder(current);
      }
    }
  }
}
