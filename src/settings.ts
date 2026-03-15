import { App, PluginSettingTab, Setting, SecretComponent } from "obsidian";
import type OvhCloudSync from "./main";

export const OVH_REGIONS = [
  { value: "gra", label: "Gravelines (GRA)" },
  { value: "sbg", label: "Strasbourg (SBG)" },
  { value: "de", label: "Frankfurt (DE)" },
  { value: "bhs", label: "Beauharnois (BHS)" },
  { value: "waw", label: "Warsaw (WAW)" },
  { value: "uk", label: "London (UK)" },
] as const;

export interface OvhSyncSettings {
  region: string;
  customEndpoint: string;
  accessKeySecret: string;
  secretKeySecret: string;
  bucket: string;
  prefix: string;
  autoSyncInterval: number;
  debounceDelay: number;
  excludePatterns: string;
  // Legacy fields for migration — cleared after migration
  accessKey?: string;
  secretKey?: string;
}

export const DEFAULT_SETTINGS: OvhSyncSettings = {
  region: "gra",
  customEndpoint: "",
  accessKeySecret: "",
  secretKeySecret: "",
  bucket: "",
  prefix: "",
  autoSyncInterval: 0,
  debounceDelay: 3000,
  excludePatterns: ".obsidian/workspace.json\n.obsidian/workspace-mobile.json\n.trash/",
};

export function getEndpoint(settings: OvhSyncSettings): string {
  if (settings.customEndpoint) return settings.customEndpoint.replace(/\/+$/, "");
  return `https://s3.${settings.region}.io.cloud.ovh.us`;
}

export function resolveCredentials(app: App, settings: OvhSyncSettings): { accessKey: string; secretKey: string } {
  const accessKey = settings.accessKeySecret
    ? app.secretStorage.getSecret(settings.accessKeySecret) || ""
    : "";
  const secretKey = settings.secretKeySecret
    ? app.secretStorage.getSecret(settings.secretKeySecret) || ""
    : "";
  return { accessKey, secretKey };
}

export class OvhSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: OvhCloudSync) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "OVH Cloud Sync Settings" });

    // Connection section
    containerEl.createEl("h3", { text: "Connection" });

    new Setting(containerEl)
      .setName("Region")
      .setDesc("OVH Cloud region for your Object Storage")
      .addDropdown((dropdown) => {
        for (const r of OVH_REGIONS) {
          dropdown.addOption(r.value, r.label);
        }
        dropdown.setValue(this.plugin.settings.region);
        dropdown.onChange(async (value) => {
          this.plugin.settings.region = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Custom endpoint")
      .setDesc("Override the S3 endpoint URL (leave empty to use the region default)")
      .addText((text) =>
        text
          .setPlaceholder("https://s3.gra.io.cloud.ovh.us")
          .setValue(this.plugin.settings.customEndpoint)
          .onChange(async (value) => {
            this.plugin.settings.customEndpoint = value;
            await this.plugin.saveSettings();
          })
      );

    const accessKeySetting = new Setting(containerEl)
      .setName("Access key")
      .setDesc("S3 access key (stored in Obsidian secure storage)")
      .addComponent((el) =>
        new SecretComponent(this.app, el)
          .setValue(this.plugin.settings.accessKeySecret)
          .onChange(async (secretName) => {
            this.plugin.settings.accessKeySecret = secretName;
            await this.plugin.saveSettings();
          })
      );

    const secretKeySetting = new Setting(containerEl)
      .setName("Secret key")
      .setDesc("S3 secret key (stored in Obsidian secure storage)")
      .addComponent((el) =>
        new SecretComponent(this.app, el)
          .setValue(this.plugin.settings.secretKeySecret)
          .onChange(async (secretName) => {
            this.plugin.settings.secretKeySecret = secretName;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Bucket")
      .setDesc("S3 bucket name")
      .addText((text) =>
        text
          .setPlaceholder("my-obsidian-vault")
          .setValue(this.plugin.settings.bucket)
          .onChange(async (value) => {
            this.plugin.settings.bucket = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Prefix")
      .setDesc("Optional path prefix within the bucket (e.g. 'vault1/')")
      .addText((text) =>
        text
          .setPlaceholder("vault1/")
          .setValue(this.plugin.settings.prefix)
          .onChange(async (value) => {
            this.plugin.settings.prefix = value;
            await this.plugin.saveSettings();
          })
      );

    const testSetting = new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Verify that the S3 credentials and bucket are valid")
      .addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          button.setButtonText("Testing...");
          button.setDisabled(true);
          testSetting.setDesc("Testing...");
          try {
            const result = await this.plugin.testConnection();
            if (result.ok) {
              button.setButtonText("Success!");
              testSetting.setDesc("Connection successful.");
            } else {
              button.setButtonText("Failed");
              testSetting.setDesc(`Connection failed: ${result.error}`);
            }
          } catch (e) {
            button.setButtonText("Error");
            testSetting.setDesc(`Error: ${e instanceof Error ? e.message : String(e)}`);
          }
          setTimeout(() => {
            button.setButtonText("Test");
            button.setDisabled(false);
          }, 5000);
        })
      );

    // Sync section
    containerEl.createEl("h3", { text: "Sync" });

    new Setting(containerEl)
      .setName("Auto-sync interval")
      .setDesc("Full sync interval in minutes (0 = disabled, on-change sync still works)")
      .addText((text) =>
        text
          .setPlaceholder("0")
          .setValue(String(this.plugin.settings.autoSyncInterval))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            this.plugin.settings.autoSyncInterval = isNaN(num) ? 0 : Math.max(0, num);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Debounce delay (ms)")
      .setDesc("Wait this long after a file change before syncing")
      .addText((text) =>
        text
          .setPlaceholder("3000")
          .setValue(String(this.plugin.settings.debounceDelay))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            this.plugin.settings.debounceDelay = isNaN(num) ? 3000 : Math.max(500, num);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Exclude patterns")
      .setDesc("File/folder paths to exclude from sync (one per line, prefix match)")
      .addTextArea((text) =>
        text
          .setPlaceholder(".obsidian/workspace.json")
          .setValue(this.plugin.settings.excludePatterns)
          .onChange(async (value) => {
            this.plugin.settings.excludePatterns = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
