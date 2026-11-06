import * as vscode from "vscode";
import { ToolArgs, bashDangerLevel, isSafe } from "./executors";

export class PermissionState {
  alwaysAllowedTools = new Set<string>();
  alwaysAllowedBashPrefixes = new Set<string>();

  reset(): void {
    this.alwaysAllowedTools.clear();
    this.alwaysAllowedBashPrefixes.clear();
  }
}

function previewArgs(name: string, args: ToolArgs): string {
  if (name === "write_file") {
    const content = String(args.content ?? "");
    const head = content.length > 600 ? content.slice(0, 600) + "..." : content;
    return `path: ${args.path}\ncontent (${content.length} chars):\n${head}`;
  }
  if (name === "edit_file") {
    const oldS = String(args.old_string ?? "");
    const newS = String(args.new_string ?? "");
    return (
      `path: ${args.path}\n` +
      `--- old (${oldS.length} chars):\n${oldS.slice(0, 400)}${oldS.length > 400 ? "..." : ""}\n` +
      `+++ new (${newS.length} chars):\n${newS.slice(0, 400)}${newS.length > 400 ? "..." : ""}`
    );
  }
  if (name === "bash") {
    return (
      `$ ${args.command}\n` +
      `# ${args.description ?? ""}\n` +
      `timeout: ${args.timeout_s ?? 30}s`
    );
  }
  return JSON.stringify(args, null, 2);
}

function bashWarning(cmd: string): string | null {
  const level = bashDangerLevel(cmd);
  if (level === "dangerous")
    return "⛔ COMANDO PERIGOSO detectado (rm -rf /, dd, fork bomb, mkfs, shutdown).";
  if (level === "caution")
    return "⚠ comando requer atenção (sudo, rm, force push, kill -9).";
  return null;
}

/**
 * Pergunta permissão ao usuário via modal. Retorna true se autorizado.
 * Para tools safe, retorna true imediatamente sem prompt.
 */
export async function askPermission(
  state: PermissionState,
  name: string,
  args: ToolArgs,
): Promise<boolean> {
  if (isSafe(name)) return true;
  if (state.alwaysAllowedTools.has(name)) return true;

  if (name === "bash") {
    const cmd = String(args.command ?? "");
    for (const prefix of state.alwaysAllowedBashPrefixes) {
      if (cmd.startsWith(prefix)) return true;
    }
  }

  const preview = previewArgs(name, args);
  const warning =
    name === "bash" ? bashWarning(String(args.command ?? "")) : null;
  const isUltraDangerous = warning?.startsWith("⛔") ?? false;

  const detail = warning ? `${preview}\n\n${warning}` : preview;
  const buttons: string[] = ["Accept"];
  if (!isUltraDangerous) buttons.push("Always");
  buttons.push("Deny");

  const choice = await vscode.window.showWarningMessage(
    `Mendes AI quer executar: ${name}`,
    { modal: true, detail },
    ...buttons,
  );

  if (choice === "Accept") return true;
  if (choice === "Always") {
    if (name === "bash") {
      const firstWord = String(args.command ?? "").trim().split(/\s+/)[0];
      if (firstWord) {
        state.alwaysAllowedBashPrefixes.add(firstWord);
        vscode.window.setStatusBarMessage(
          `Mendes: 'bash ${firstWord} …' sempre permitido nesta sessão`,
          5000,
        );
      }
    } else {
      state.alwaysAllowedTools.add(name);
      vscode.window.setStatusBarMessage(
        `Mendes: '${name}' sempre permitido nesta sessão`,
        5000,
      );
    }
    return true;
  }
  return false; // Deny ou modal fechado
}
