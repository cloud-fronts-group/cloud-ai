import * as vscode from "vscode";
import { streamAsk } from "../client";
import { getConfig } from "../config";

export async function generateAtCursor(
  output: vscode.OutputChannel,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage(vscode.l10n.t("Cloud: open a file first."));
    return;
  }

  const instruction = await vscode.window.showInputBox({
    title: "Cloud Generate",
    prompt: vscode.l10n.t("What should be generated at the cursor?"),
    placeHolder: vscode.l10n.t("e.g. a debounce function · a pytest test for UserService.create"),
    ignoreFocusOut: true,
  });
  if (!instruction) return;

  const langId = editor.document.languageId;
  const cursorPos = editor.selection.active;

  // 80 lines before the cursor, as a style hint
  const startLine = Math.max(0, cursorPos.line - 80);
  const ctxRange = new vscode.Range(
    new vscode.Position(startLine, 0),
    cursorPos,
  );
  const fileContext = editor.document.getText(ctxRange);

  const prompt =
    `Generate ${langId} code to insert at the current cursor position.\n` +
    `Instruction: ${instruction}\n\n` +
    `Strict rules:\n` +
    `- Return ONLY the code: no Markdown, no fences, no prose.\n` +
    `- Keep the indentation consistent with the context.\n` +
    `- Do not repeat imports already present in the context.`;

  const ctrl = new AbortController();
  let buffer = "";

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t("Cloud: generating…"),
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
  if (!ok) vscode.window.showErrorMessage(vscode.l10n.t("Cloud: the insert failed."));
}

function stripFences(s: string): string {
  const fence = /^```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n```\s*$/;
  const m = s.trim().match(fence);
  return (m ? m[1] : s).replace(/\n+$/, "");
}
