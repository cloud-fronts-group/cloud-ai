import * as vscode from "vscode";
import { fetchHealth } from "./client";
import { getConfig } from "./config";

export class StatusBar {
  private item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = "cloud.healthCheck";
    this.item.text = "$(circle-slash) Cloud";
    this.item.show();
  }

  start(): void {
    void this.tick();
    const interval = (getConfig().healthPollSeconds || 10) * 1000;
    this.timer = setInterval(() => void this.tick(), interval);
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;
    const cfg = getConfig();
    if (!cfg.tunnelUrl || !cfg.token) {
      this.item.text = "$(circle-slash) Cloud";
      this.item.tooltip = "Configure cloud.tunnelUrl e cloud.token";
      return;
    }
    try {
      const h = await fetchHealth(cfg);
      const vramPct = Math.round(
        (h.gpu.vram_used_mb / h.gpu.vram_total_mb) * 100,
      );
      this.item.text = `$(pulse) Cloud ${vramPct}%`;
      this.item.tooltip =
        `${h.gpu.name}\n` +
        `VRAM ${h.gpu.vram_used_mb}/${h.gpu.vram_total_mb} MB (${vramPct}%)\n` +
        `Util ${h.gpu.gpu_util_pct}%  ·  ${h.gpu.temp_c}°C\n` +
        `code: ${h.models.code ?? "—"}\n` +
        `vision: ${h.models.vision ?? "—"}`;
    } catch (e) {
      this.item.text = "$(error) Cloud";
      this.item.tooltip = `offline: ${(e as Error).message}`;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.item.dispose();
  }
}
