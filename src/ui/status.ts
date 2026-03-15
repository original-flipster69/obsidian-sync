import { Plugin } from "obsidian";

export class StatusBar {
  private el: HTMLElement;

  constructor(plugin: Plugin) {
    this.el = plugin.addStatusBarItem();
    this.el.addClass("ovh-sync-status");
    this.setIdle();
  }

  setIdle(): void {
    this.el.setText("OVH: idle");
  }

  setSyncing(): void {
    this.el.empty();
    const icon = this.el.createSpan({ cls: "sync-icon syncing" });
    icon.setText("⟳");
    this.el.createSpan({ text: " OVH: syncing..." });
  }

  setResult(uploaded: number, downloaded: number, errors: number): void {
    if (errors > 0) {
      this.el.setText(`OVH: ↑${uploaded} ↓${downloaded} ✗${errors}`);
    } else if (uploaded === 0 && downloaded === 0) {
      this.el.setText("OVH: up to date");
    } else {
      this.el.setText(`OVH: ↑${uploaded} ↓${downloaded}`);
    }
  }

  setError(msg: string): void {
    this.el.setText(`OVH: error`);
    this.el.setAttr("title", msg);
  }

  setDisconnected(): void {
    this.el.setText("OVH: not configured");
  }
}
