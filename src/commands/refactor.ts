import * as vscode from "vscode";
import { streamAsk } from "../client";
import { getConfig } from "../config";

export async function refactorSelection(
  output: vscode.OutputChannel,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showWarningMessage(vscode.l10n.t("Cloud: select some code first."));
    return;
  }

  const instruction = await vscode.window.showInputBox({
    title: "Cloud Refactor",
    prompt: vscode.l10n.t("What should change?"),
    placeHolder: vscode.l10n.t("e.g. extract a pure function · rename x to userId · use async/await"),
    ignoreFocusOut: true,
  });
  if (!instruction) return;

  const selected = editor.document.getText(editor.selection);
  const langId = editor.document.languageId;

  const prompt =
    `Refactor the code below (${langId}). Instruction: ${instruction}\n\n` +
    `Strict rules:\n` +
    `- Return ONLY the new code: no Markdown, no fences, no prose.\n` +
    `- Keep exactly the starting indentation of the selection.\n` +
    `- Do not invent APIs or imports that were not there.\n\n` +
    `<code>\n${selected}\n</code>`;

  const ctrl = new AbortController();
  let buffer = "";

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t("Cloud: refactoring…"),
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
              `[refactor route] ${ev.data.backend}/${ev.data.model}`,
            );
          } else if (ev.event === "token") {
            buffer += ev.data;
          } else if (ev.event === "error") {
            throw new Error(ev.data);
          }
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        vscode.window.showErrorMessage(`Cloud refactor: ${(e as Error).message}`);
        return;
      }
    },
  );

  if (!buffer.trim()) return;

  const cleaned = stripFences(buffer);
  const ok = await vscode.window.showInformationMessage(
    `Aplicar refactor em ${editor.document.fileName.split(/[\\/]/).pop()}?`,
    { modal: false },
    "Aplicar",
    "Mostrar diff",
    "Cancelar",
  );

  if (ok === "Cancelar" || !ok) return;

  if (ok === "Mostrar diff") {
    const original = await vscode.workspace.openTextDocument({
      content: editor.document.getText(editor.selection),
      language: editor.document.languageId,
    });
    const proposed = await vscode.workspace.openTextDocument({
      content: cleaned,
      language: editor.document.languageId,
    });
    await vscode.commands.executeCommand(
      "vscode.diff",
      original.uri,
      proposed.uri,
      "Cloud: refactor preview",
    );
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(editor.document.uri, editor.selection, cleaned);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    vscode.window.showErrorMessage("Cloud: applyEdit falhou.");
  }
}

function stripFences(s: string): string {
  const fence = /^```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n```\s*$/;
  const m = s.trim().match(fence);
  return (m ? m[1] : s).replace(/\n+$/, "");
}
