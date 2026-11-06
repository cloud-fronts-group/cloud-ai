import * as vscode from "vscode";
import { ChatTurnMessage, streamChat } from "./client";
import { getConfig } from "./config";
import {
  Skill,
  buildSkillPrompt,
  listSkills,
  loadSkills,
  parseSlashCommand,
} from "./skills/registry";
import { execute as execTool, ToolArgs } from "./tools/executors";
import { PermissionState, askPermission } from "./tools/permissions";

export interface InboundMessage {
  type: "send" | "stop" | "clear" | "ready" | "toggleTools";
  text?: string;
  toolsEnabled?: boolean;
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface OutboundMessage {
  type:
    | "route"
    | "token"
    | "done"
    | "error"
    | "reset"
    | "userEcho"
    | "config"
    | "replay"
    | "toolCall"
    | "toolResult";
  data?: string;
  meta?: unknown;
  toolsEnabled?: boolean;
  history?: ChatTurnMessage[];
}

const HISTORY_KEY = "cloud.chatHistory.v1";
const MAX_PERSIST_MESSAGES = 200;
const MAX_TOOL_LOOP_TURNS = 10;

/**
 * Lógica do chat (history, tool-loop, slash commands, persistência) extraída
 * para poder ser reutilizada tanto por um WebviewPanel (editor tab) quanto por
 * um WebviewView (sidebar). Opera sobre qualquer vscode.Webview.
 */
export class ChatRuntime {
  private readonly webview: vscode.Webview;
  private readonly extUri: vscode.Uri;
  private readonly state: vscode.Memento;
  private history: ChatTurnMessage[] = [];
  private currentCtrl: AbortController | undefined;
  private disposables: vscode.Disposable[] = [];
  private permState = new PermissionState();
  private pendingPrefix: ChatTurnMessage[] = [];
  private skills: Map<string, Skill>;

  constructor(
    webview: vscode.Webview,
    extUri: vscode.Uri,
    state: vscode.Memento,
  ) {
    this.webview = webview;
    this.extUri = extUri;
    this.state = state;
    this.history = state.get<ChatTurnMessage[]>(HISTORY_KEY, []);
    this.skills = loadSkills(extUri);

    this.webview.html = renderHtml(this.webview, this.extUri);
    this.disposables.push(
      this.webview.onDidReceiveMessage(
        (msg: InboundMessage) => void this.onMessage(msg),
      ),
    );
  }

  dispose(): void {
    this.currentCtrl?.abort();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private async onMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.post({ type: "config", toolsEnabled: getConfig().toolsEnabled });
        this.replayHistory();
        return;
      case "clear":
        this.history = [];
        this.permState.reset();
        await this.state.update(HISTORY_KEY, []);
        this.post({ type: "reset" });
        return;
      case "stop":
        this.currentCtrl?.abort();
        return;
      case "toggleTools": {
        const cfg = vscode.workspace.getConfiguration("cloud");
        await cfg.update(
          "toolsEnabled",
          !!msg.toolsEnabled,
          vscode.ConfigurationTarget.Global,
        );
        return;
      }
      case "send": {
        const text = (msg.text ?? "").trim();
        if (!text) return;
        await this.send(text);
        return;
      }
    }
  }

  private async send(text: string): Promise<void> {
    if (this.handleBuiltinSlash(text)) return;

    const parsed = parseSlashCommand(text, this.skills);
    let userContent = text;
    if (parsed) {
      const { systemMessage, userMessage } = buildSkillPrompt(parsed);
      this.pendingPrefix = [{ role: "system", content: systemMessage }];
      userContent = userMessage;
    }

    this.history.push({ role: "user", content: userContent });
    this.post({ type: "userEcho", data: text });

    try {
      for (let turn = 0; turn < MAX_TOOL_LOOP_TURNS; turn++) {
        const result = await this.runOneTurn();
        if (!result.ok) return;
        if (!result.toolCalls.length) {
          this.post({ type: "done" });
          await this.persistHistory();
          return;
        }
        const aborted = await this.executeToolCalls(result.toolCalls);
        if (aborted) {
          this.post({ type: "done" });
          await this.persistHistory();
          return;
        }
      }
      this.post({
        type: "error",
        data: `excedeu ${MAX_TOOL_LOOP_TURNS} turns de tool calls — parando para evitar loop infinito.`,
      });
      await this.persistHistory();
    } finally {
      this.pendingPrefix = [];
    }
  }

  private handleBuiltinSlash(text: string): boolean {
    const trimmed = text.trimStart().toLowerCase();
    if (trimmed === "/skills" || trimmed === "/help") {
      const skills = listSkills(this.extUri);
      const lines = [
        "**Skills disponíveis (slash commands):**",
        "",
        ...skills.map(
          (s) => `- \`/${s.command}\` — **${s.title}** — ${s.description}`,
        ),
        "",
        "Exemplos:",
        "- `/eda` — análise exploratória do dataset atual",
        "- `/drill ticket volume jumped 55% in June, dimensions: device, app_version, category`",
        "- `/question` — depois descreva o problema de negócio",
      ];
      this.post({ type: "userEcho", data: text });
      this.post({ type: "token", data: lines.join("\n") });
      this.post({ type: "done" });
      return true;
    }
    return false;
  }

  private async runOneTurn(): Promise<{
    ok: boolean;
    toolCalls: PendingToolCall[];
  }> {
    this.currentCtrl?.abort();
    this.currentCtrl = new AbortController();

    let textBuf = "";
    const pending: PendingToolCall[] = [];

    try {
      const messagesToSend =
        this.pendingPrefix.length > 0
          ? [...this.pendingPrefix, ...this.history]
          : this.history;
      for await (const ev of streamChat(getConfig(), {
        messages: messagesToSend,
        toolsEnabled: getConfig().toolsEnabled,
        signal: this.currentCtrl.signal,
      })) {
        if (ev.event === "route") {
          this.post({ type: "route", meta: ev.data });
        } else if (ev.event === "token") {
          textBuf += ev.data;
          this.post({ type: "token", data: ev.data });
        } else if (ev.event === "tool_call") {
          const tc = ev.data as { id?: string; name?: string; arguments?: string };
          const id = tc.id ?? `call_${tc.name ?? "x"}_${Date.now()}`;
          pending.push({
            id,
            name: tc.name ?? "",
            arguments: tc.arguments ?? "{}",
          });
          this.post({
            type: "toolCall",
            data: JSON.stringify({ id, name: tc.name, arguments: tc.arguments }),
          });
        } else if (ev.event === "error") {
          this.post({ type: "error", data: ev.data });
          return { ok: false, toolCalls: [] };
        } else if (ev.event === "done") {
          // backend done with this turn
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        this.post({ type: "done" });
      } else {
        this.post({ type: "error", data: (e as Error).message });
      }
      return { ok: false, toolCalls: [] };
    }

    if (pending.length > 0) {
      this.history.push({
        role: "assistant",
        content: textBuf || undefined,
        tool_calls: pending.map((p) => ({
          id: p.id,
          type: "function",
          function: { name: p.name, arguments: p.arguments },
        })),
      });
    } else if (textBuf) {
      this.history.push({ role: "assistant", content: textBuf });
    }

    return { ok: true, toolCalls: pending };
  }

  private async executeToolCalls(calls: PendingToolCall[]): Promise<boolean> {
    for (const tc of calls) {
      let args: ToolArgs = {};
      try {
        args = tc.arguments ? (JSON.parse(tc.arguments) as ToolArgs) : {};
      } catch {
        const err = `ERRO: arguments JSON inválido em ${tc.name}: ${tc.arguments}`;
        this.history.push({ role: "tool", tool_call_id: tc.id, content: err });
        this.post({
          type: "toolResult",
          data: JSON.stringify({ id: tc.id, name: tc.name, content: err }),
        });
        continue;
      }

      const allowed = await askPermission(this.permState, tc.name, args);
      let resultText: string;
      if (!allowed) {
        resultText = "ERRO: usuário negou execução desta ferramenta.";
      } else {
        resultText = await execTool(tc.name, args);
      }

      this.history.push({
        role: "tool",
        tool_call_id: tc.id,
        content: resultText,
      });
      this.post({
        type: "toolResult",
        data: JSON.stringify({ id: tc.id, name: tc.name, content: resultText }),
      });
    }
    return false;
  }

  private async persistHistory(): Promise<void> {
    const trimmed = this.history.slice(-MAX_PERSIST_MESSAGES);
    if (trimmed.length !== this.history.length) this.history = trimmed;
    await this.state.update(HISTORY_KEY, trimmed);
  }

  private replayHistory(): void {
    if (this.history.length === 0) return;
    this.post({ type: "replay", history: this.history });
  }

  private post(m: OutboundMessage): void {
    void this.webview.postMessage(m);
  }
}

export function renderHtml(
  webview: vscode.Webview,
  extUri: vscode.Uri,
): string {
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extUri, "media", "chat.css"),
  );
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extUri, "media", "chat.js"),
  );
  const nonce = randomNonce();
  const csp =
    `default-src 'none'; ` +
    `style-src ${webview.cspSource} 'unsafe-inline'; ` +
    `script-src 'nonce-${nonce}'; ` +
    `img-src ${webview.cspSource} data:; ` +
    `font-src ${webview.cspSource};`;

  return `<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Cloud AI</title>
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <span class="dot"></span>
      <span>Cloud AI</span>
    </div>
    <div class="route" id="route">—</div>
    <div class="actions">
      <label class="toggle" title="Permitir tool calls">
        <input type="checkbox" id="tools" /> tools
      </label>
      <button id="clear" title="Limpar conversa">clear</button>
    </div>
  </header>
  <main id="messages" class="messages"></main>
  <footer class="composer">
    <textarea id="input" rows="2" placeholder="Mensagem… (/skills lista skills, Enter envia)"></textarea>
    <button id="mic" hidden title="Voice input (Web Speech)">🎙</button>
    <button id="send" title="Enviar (Enter)">▶</button>
    <button id="stop" hidden title="Parar geração">■</button>
  </footer>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function randomNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}
