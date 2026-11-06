import * as vscode from "vscode";
import { ChatRuntime } from "./chatRuntime";

/**
 * Chat aberto como aba do editor (Ctrl+Shift+M). Mantido para usuários que
 * preferem o chat em uma coluna do editor. O chat principal é a view do
 * sidebar registrada via ChatViewProvider.
 */
export class ChatPanel {
  private static current: ChatPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly runtime: ChatRuntime;

  static show(extUri: vscode.Uri, state: vscode.Memento): void {
    const col =
      vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Beside;
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal(col);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "cloudChat",
      "Cloud AI",
      col,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extUri, "media")],
      },
    );
    ChatPanel.current = new ChatPanel(panel, extUri, state);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extUri: vscode.Uri,
    state: vscode.Memento,
  ) {
    this.panel = panel;
    this.runtime = new ChatRuntime(panel.webview, extUri, state);
    this.panel.onDidDispose(() => this.dispose());
  }

  private dispose(): void {
    ChatPanel.current = undefined;
    this.runtime.dispose();
    this.panel.dispose();
  }
}
