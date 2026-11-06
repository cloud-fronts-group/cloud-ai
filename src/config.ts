import * as vscode from "vscode";

export interface MendesConfig {
  tunnelUrl: string;
  token: string;
  toolsEnabled: boolean;
  healthPollSeconds: number;
}

export function getConfig(): MendesConfig {
  const c = vscode.workspace.getConfiguration("mendes");
  return {
    tunnelUrl: (c.get<string>("tunnelUrl") ?? "").replace(/\/+$/, ""),
    token: c.get<string>("token") ?? "",
    toolsEnabled: c.get<boolean>("toolsEnabled") ?? false,
    healthPollSeconds: c.get<number>("healthPollSeconds") ?? 10,
  };
}

export function assertConfigured(cfg: MendesConfig): void {
  if (!cfg.tunnelUrl) {
    throw new Error(
      "mendes.tunnelUrl não configurado. Settings → Mendes AI → Tunnel Url",
    );
  }
  if (!cfg.token) {
    throw new Error("mendes.token não configurado.");
  }
}
