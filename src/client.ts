import { MendesConfig, assertConfigured } from "./config";

export interface RouteEvent {
  role: "code" | "vision" | "agentic";
  backend: "ollama" | "openrouter" | "opencode_zen";
  model: string;
  reason: string;
  tools_enabled?: boolean;
}

export interface HealthResponse {
  status: string;
  version: string;
  models: { code: string | null; vision: string | null; agentic: string | null };
  routing: string;
  gpu: {
    name: string;
    vram_used_mb: number;
    vram_total_mb: number;
    gpu_util_pct: number;
    temp_c: number;
  };
}

export type StreamEvent =
  | { event: "route"; data: RouteEvent }
  | { event: "token"; data: string }
  | { event: "tool_call"; data: unknown }
  | { event: "error"; data: string }
  | { event: "done"; data: string };

function explainNetworkError(err: unknown, cfg: MendesConfig): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const host = (() => {
    try {
      return new URL(cfg.tunnelUrl).host;
    } catch {
      return cfg.tunnelUrl || "(empty)";
    }
  })();
  const isNetwork =
    /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR_SOCKET|network|Could not resolve/i.test(
      msg,
    );
  if (!isNetwork) return err instanceof Error ? err : new Error(msg);
  return new Error(
    `Backend offline (${host}). Tunnel Cloudflared do Colab caiu ou expirou. ` +
      `Re-rode a célula do cloudflared no Colab, copie a nova URL, e cole em ` +
      `Settings → Mendes AI → Tunnel Url. [cause: ${msg}]`,
  );
}

export async function fetchHealth(cfg: MendesConfig): Promise<HealthResponse> {
  if (!cfg.tunnelUrl) throw new Error("tunnelUrl vazio");
  let r: Response;
  try {
    r = await fetch(`${cfg.tunnelUrl}/health`, {
      headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
    });
  } catch (e) {
    throw explainNetworkError(e, cfg);
  }
  if (!r.ok) throw new Error(`/health ${r.status}`);
  return (await r.json()) as HealthResponse;
}

export interface AskParams {
  prompt: string;
  fileContext?: string;
  imageDataB64?: string;
  signal?: AbortSignal;
}

export async function* streamAsk(
  cfg: MendesConfig,
  params: AskParams,
): AsyncGenerator<StreamEvent> {
  assertConfigured(cfg);
  let r: Response;
  try {
    r = await fetch(`${cfg.tunnelUrl}/vibe/ask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify({
        prompt: params.prompt,
        file_context: params.fileContext ?? null,
        image_data: params.imageDataB64 ?? null,
      }),
      signal: params.signal,
    });
  } catch (e) {
    throw explainNetworkError(e, cfg);
  }
  if (!r.ok || !r.body) {
    const txt = await r.text().catch(() => "");
    throw new Error(`/vibe/ask ${r.status}: ${txt.slice(0, 200)}`);
  }
  yield* parseSse(r.body);
}

export interface ChatTurnMessage {
  role: "user" | "assistant" | "system" | "tool";
  content?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface ChatParams {
  messages: ChatTurnMessage[];
  toolsEnabled: boolean;
  imageDataB64?: string;
  signal?: AbortSignal;
}

export async function* streamChat(
  cfg: MendesConfig,
  params: ChatParams,
): AsyncGenerator<StreamEvent> {
  assertConfigured(cfg);
  let r: Response;
  try {
    r = await fetch(`${cfg.tunnelUrl}/vibe/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify({
        messages: params.messages,
        tools_enabled: params.toolsEnabled,
        image_data: params.imageDataB64 ?? null,
      }),
      signal: params.signal,
    });
  } catch (e) {
    throw explainNetworkError(e, cfg);
  }
  if (!r.ok || !r.body) {
    const txt = await r.text().catch(() => "");
    throw new Error(`/vibe/chat ${r.status}: ${txt.slice(0, 200)}`);
  }
  yield* parseSse(r.body);
}

async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let pendingEvent = "";
  let dataLines: string[] | undefined;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.replace(/\r$/, "");
        if (!line) {
          // Blank line terminates one SSE event. Per spec, consecutive `data:`
          // lines are joined with "\n" — that is how newlines inside a streamed
          // token (e.g. Markdown code fences) survive the wire.
          if (pendingEvent && dataLines) {
            const ev = pendingEvent;
            yield toEvent(ev, dataLines.join("\n"));
            if (ev === "done") return;
          }
          pendingEvent = "";
          dataLines = undefined;
          continue;
        }
        if (line.startsWith(":")) continue; // comment / keep-alive
        if (line.startsWith("event:")) {
          pendingEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          let d = line.slice(5);
          if (d.startsWith(" ")) d = d.slice(1);
          (dataLines ??= []).push(d);
        }
      }
    }
    // Flush an event the server did not terminate with a blank line.
    if (pendingEvent && dataLines) {
      yield toEvent(pendingEvent, dataLines.join("\n"));
    }
  } finally {
    reader.releaseLock();
  }
}

function toEvent(name: string, data: string): StreamEvent {
  switch (name) {
    case "route":
      return { event: "route", data: JSON.parse(data) as RouteEvent };
    case "token":
      return { event: "token", data };
    case "tool_call":
      return { event: "tool_call", data: JSON.parse(data) };
    case "error":
      return { event: "error", data };
    case "done":
      return { event: "done", data };
    default:
      return { event: "error", data: `unknown event: ${name}` };
  }
}
