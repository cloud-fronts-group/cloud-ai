import * as vscode from "vscode";
import { streamAsk } from "../client";
import { getConfig } from "../config";

export async function explainSelection(
  output: vscode.OutputChannel,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showWarningMessage("Cloud: selecione algum código primeiro.");
    return;
  }

  const selected = editor.document.getText(editor.selection);
  const langId = editor.document.languageId;
  const fname = editor.document.fileName.split(/[\\/]/).pop() ?? "(buffer)";

  const prompt =
    `Explica o trecho abaixo de \`${fname}\` (${langId}). ` +
    `Seja objetivo: o que faz, por que importa, e quaisquer pegadinhas.\n\n` +
    "```" +
    langId +
    "\n" +
    selected +
    "\n```";

  output.show(true);
  output.appendLine("");
  output.appendLine(`── Cloud: Explain ${fname}:${editor.selection.start.line + 1} ──`);

  const ctrl = new AbortController();
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Cloud: explicando…",
      cancellable: true,
    },
    async (_p, token) => {
      token.onCancellationRequested(() => ctrl.abort());
      try {
        for await (const ev of streamAsk(getConfig(), {
          prompt,
          signal: ctrl.signal,
        })) {
          if (ev.event === "route") {
            output.appendLine(
              `[route] ${ev.data.backend}/${ev.data.model} (${ev.data.reason})`,
            );
          } else if (ev.event === "token") {
            output.append(ev.data);
          } else if (ev.event === "error") {
            output.appendLine(`\n[error] ${ev.data}`);
          } else if (ev.event === "done") {
            output.appendLine("\n[done]");
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          output.appendLine(`\n[fail] ${(e as Error).message}`);
          vscode.window.showErrorMessage(`Cloud: ${(e as Error).message}`);
        }
      }
    },
  );
}
