import * as vscode from "vscode";
import { fetchHealth } from "./client";
import { getConfig } from "./config";
import { explainSelection } from "./commands/explain";
import { refactorSelection } from "./commands/refactor";
import { generateAtCursor } from "./commands/generate";
import { ChatPanel } from "./chatPanel";
import { ChatViewProvider } from "./chatView";
import { StatusBar } from "./statusBar";

let statusBar: StatusBar | undefined;
let output: vscode.OutputChannel | undefined;

export function activate(ctx: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Cloud AI");
  ctx.subscriptions.push(output);

  statusBar = new StatusBar();
  ctx.subscriptions.push({ dispose: () => statusBar?.dispose() });
  statusBar.start();

  const chatViewProvider = new ChatViewProvider(
    ctx.extensionUri,
    ctx.globalState,
  );

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand("cloud.explain", () =>
      explainSelection(output!),
    ),
    vscode.commands.registerCommand("cloud.refactor", () =>
      refactorSelection(output!),
    ),
    vscode.commands.registerCommand("cloud.generate", () =>
      generateAtCursor(output!),
    ),
    vscode.commands.registerCommand("cloud.chat", () =>
      ChatPanel.show(ctx.extensionUri, ctx.globalState),
    ),
    vscode.commands.registerCommand("cloud.focusChat", () =>
      vscode.commands.executeCommand("cloud.chatView.focus"),
    ),
    vscode.commands.registerCommand("cloud.healthCheck", healthCheck),
  );

  // On first install, reveal the chat view automatically so the user can see
  // and use it right away — same UX as Copilot Chat / Claude Code.
  void revealChatOnFirstRun(ctx);

  output.appendLine(`[cloud] activated · tunnelUrl=${getConfig().tunnelUrl || "(empty)"}`);
}

const FIRST_RUN_KEY = "cloud.firstRunCompleted.v1";

async function revealChatOnFirstRun(
  ctx: vscode.ExtensionContext,
): Promise<void> {
  if (ctx.globalState.get<boolean>(FIRST_RUN_KEY)) return;
  await ctx.globalState.update(FIRST_RUN_KEY, true);
  // Give VS Code a moment to register the view, then focus it.
  setTimeout(() => {
    void vscode.commands.executeCommand("cloud.chatView.focus");
  }, 400);
}

export function deactivate(): void {
  statusBar?.dispose();
}

async function healthCheck(): Promise<void> {
  try {
    const h = await fetchHealth(getConfig());
    const vramPct = Math.round(
      (h.gpu.vram_used_mb / h.gpu.vram_total_mb) * 100,
    );
    vscode.window.showInformationMessage(
      `Cloud ${h.status} · ${h.gpu.name} · VRAM ${vramPct}% · code=${h.models.code ?? "—"}`,
    );
  } catch (e) {
    vscode.window.showErrorMessage(`Cloud offline: ${(e as Error).message}`);
  }
}

