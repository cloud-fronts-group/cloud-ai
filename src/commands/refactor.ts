import * as vscode from "vscode";
import { streamAsk } from "../client";
import { getConfig } from "../config";

export async function refactorSelection(
  output: vscode.OutputChannel,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showWarningMessage("Mendes: selecione código primeiro.");
    return;
  }

  const instruction = await vscode.window.showInputBox({
    title: "Mendes Refactor",
    prompt: "O que mudar?",
    placeHolder: "ex.: extrai função pura · renomeia x para userId · usa async/await",
    ignoreFocusOut: true,
  });
  if (!instruction) return;

  const selected = editor.document.getText(editor.selection);
  const langId = editor.document.languageId;

  const prompt =
    `Refatora o código abaixo (${langId}). Instrução: ${instruction}\n\n` +
    `Regras estritas:\n` +
    `- Devolve APENAS o código novo, sem markdown, sem fences, sem prosa.\n` +
    `- Mantém exatamente a indentação inicial da seleção.\n` +
    `- Não inventes APIs nem imports que não estavam.\n\n` +
    `<código>\n${selected}\n</código>`;

  const ctrl = new AbortController();
  let buffer = "";

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Mendes: refatorando…",
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
        vscode.window.showErrorMessage(`Mendes refactor: ${(e as Error).message}`);
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
      "Mendes: refactor preview",
    );
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(editor.document.uri, editor.selection, cleaned);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    vscode.window.showErrorMessage("Mendes: applyEdit falhou.");
  }
}

function stripFences(s: string): string {
  const fence = /^```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n```\s*$/;
  const m = s.trim().match(fence);
  return (m ? m[1] : s).replace(/\n+$/, "");
}
