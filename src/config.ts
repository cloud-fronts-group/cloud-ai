import * as vscode from "vscode";

export interface CloudConfig {
  tunnelUrl: string;
  token: string;
  toolsEnabled: boolean;
  healthPollSeconds: number;
}

export function getConfig(): CloudConfig {
  const c = vscode.workspace.getConfiguration("cloud");
  return {
    tunnelUrl: (c.get<string>("tunnelUrl") ?? "").replace(/\/+$/, ""),
    token: c.get<string>("token") ?? "",
    toolsEnabled: c.get<boolean>("toolsEnabled") ?? false,
    healthPollSeconds: c.get<number>("healthPollSeconds") ?? 10,
  };
}

export function assertConfigured(cfg: CloudConfig): void {
  if (!cfg.tunnelUrl) {
    throw new Error(
      "cloud.tunnelUrl não configurado. Settings → Cloud AI → Tunnel Url",
    );
  }
  if (!cfg.token) {
    throw new Error("cloud.token não configurado.");
  }
}
