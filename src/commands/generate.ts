import * as vscode from "vscode";
import { streamAsk } from "../client";
import { getConfig } from "../config";

export async function generateAtCursor(
  output: vscode.OutputChannel,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Cloud: abre um arquivo primeiro.");
    return;
  }

  const instruction = await vscode.window.showInputBox({
    title: "Cloud Generate",
    prompt: "O que gerar no cursor?",
    placeHolder: "ex.: função pra debounce · teste pytest pra UserService.create",
    ignoreFocusOut: true,
  });
  if (!instruction) return;

  const langId = editor.document.languageId;
  const cursorPos = editor.selection.active;

  // Pega 80 linhas de contexto antes do cursor pra dar pista do estilo
  const startLine = Math.max(0, cursorPos.line - 80);
  const ctxRange = new vscode.Range(
    new vscode.Position(startLine, 0),
    cursorPos,
  );
  const fileContext = editor.document.getText(ctxRange);

  const prompt =
    `Gera código ${langId} para inserir na posição atual do cursor.\n` +
    `Instrução: ${instruction}\n\n` +
    `Regras estritas:\n` +
    `- Devolve APENAS o código, sem markdown, sem fences, sem prosa.\n` +
    `- Mantém indentação coerente com o contexto.\n` +
    `- Não dupliques imports já presentes no contexto.`;

  const ctrl = new AbortController();
  let buffer = "";

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Cloud: gerando…",
      cancellable: true,
    },
    async (_p, token) => {
      token.onCancellationRequested(() => ctrl.abort());
      try {
        for await (const ev of streamAsk(getConfig(), {
          prompt,
          fileContext,
          signal: ctrl.signal,
        })) {
          if (ev.event === "route") {
            output.appendLine(
              `[generate route] ${ev.data.backend}/${ev.data.model}`,
            );
          } else if (ev.event === "token") {
            buffer += ev.data;
          } else if (ev.event === "error") {
            throw new Error(ev.data);
          }
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        vscode.window.showErrorMessage(`Cloud generate: ${(e as Error).message}`);
      }
    },
  );

  if (!buffer.trim()) return;

  const cleaned = stripFences(buffer);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(editor.document.uri, cursorPos, cleaned);
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) vscode.window.showErrorMessage("Cloud: insert falhou.");
}

function stripFences(s: string): string {
  const fence = /^```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n```\s*$/;
  const m = s.trim().match(fence);
  return (m ? m[1] : s).replace(/\n+$/, "");
}
