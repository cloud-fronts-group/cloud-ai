import * as vscode from "vscode";
import { ChatRuntime } from "./chatRuntime";

/**
 * Provider da view de chat que aparece no sidebar (Activity Bar). É o ponto
 * de entrada principal da extensão — sempre disponível, persistente entre
 * sessões, e abre automaticamente quando o usuário clica no ícone do Cloud
 * AI na Activity Bar.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "cloud.chatView";
  private runtime: ChatRuntime | undefined;

  constructor(
    private readonly extUri: vscode.Uri,
    private readonly state: vscode.Memento,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extUri, "media")],
    };
    this.runtime = new ChatRuntime(view.webview, this.extUri, this.state);
    view.onDidDispose(() => {
      this.runtime?.dispose();
      this.runtime = undefined;
    });
  }
}
