# Cloud AI backend

The VS Code extension is only a client. It needs an HTTP server that speaks the
protocol below. The original author ran it inside a Colab notebook that was lost
with the original repository; `server.py` is a clean reference implementation
reconstructed from the client code (`src/client.ts`).

## Run it

**On Google Colab (the intended setup):** open [`cloud_colab.ipynb`](cloud_colab.ipynb)
([open in Colab](https://colab.research.google.com/github/cloud-fronts-group/cloud-ai/blob/main/backend/cloud_colab.ipynb)),
choose a GPU runtime and *Run all*. The last cell prints `CLOUD_URL` and `CLOUD_TOKEN`.

**Anywhere with Ollama:**

```bash
pip install -r backend/requirements.txt
ollama pull qwen3:30b && ollama pull gemma3:27b     # or smaller models, see below
CLOUD_TOKEN=change-me python backend/server.py     # listens on 0.0.0.0:8000
```

Then in VS Code → Settings → Cloud AI set `cloud.tunnelUrl` to `http://localhost:8000`
(or your tunnel URL) and `cloud.token` to the same token.

**Smoke test without any model** (starts a mock Ollama, runs the protocol end to end):

```bash
python backend/tests/smoke_test.py
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CLOUD_TOKEN` | random, printed at start | Bearer token the extension must send |
| `CLOUD_HOST` / `CLOUD_PORT` | `0.0.0.0` / `8000` | Bind address |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama server |
| `CLOUD_CODE_MODEL` | `qwen3:30b` | Text-only turns |
| `CLOUD_VISION_MODEL` | `gemma3:27b` | Turns with an image attached |
| `CLOUD_AGENTIC_MODEL` | same as code model | Turns with tools enabled (must support tool calling) |
| `CLOUD_NUM_CTX` | `16384` | Context window passed to Ollama |
| `CLOUD_TEMPERATURE` | `0.2` | Sampling temperature |
| `CLOUD_THINK` | unset | `0`/`1` to force thinking off/on for models that support it |
| `CLOUD_FALLBACK_KEY` | unset | Enables an OpenAI-compatible fallback when Ollama fails |
| `CLOUD_FALLBACK_NAME` | `openrouter` | Reported in the `route` event (`openrouter` or `opencode_zen`) |
| `CLOUD_FALLBACK_URL` | `https://openrouter.ai/api/v1` | Base URL of the fallback |
| `CLOUD_FALLBACK_MODEL` | `qwen/qwen3-coder` | Fallback model id |

Smaller GPUs: `qwen2.5-coder:7b` + `gemma3:4b` fit in ~8 GB and both support what the
extension needs (tool calling and images respectively).

## Protocol

All endpoints require `Authorization: Bearer <CLOUD_TOKEN>`.

### `GET /health`

```json
{
  "status": "ok",
  "version": "0.5.0",
  "models": { "code": "qwen3:30b", "vision": "gemma3:27b", "agentic": "qwen3:30b" },
  "routing": "image->vision · tools->agentic · else->code",
  "gpu": { "name": "NVIDIA L4", "vram_used_mb": 18210, "vram_total_mb": 23034, "gpu_util_pct": 0, "temp_c": 41 }
}
```

`models.*` is `null` when the model is not pulled. The status bar shows
`vram_used_mb / vram_total_mb`; without a GPU the server reports system RAM instead.

### `POST /vibe/ask` — single shot (Explain / Refactor / Generate)

Request: `{ "prompt": str, "file_context": str | null, "image_data": base64 | null }`

### `POST /vibe/chat` — multi-turn with tools

Request: `{ "messages": [...], "tools_enabled": bool, "image_data": base64 | null }`

`messages` use the OpenAI shape: `user` / `assistant` / `system` / `tool`, with
`assistant.tool_calls[].function.arguments` as a **JSON string** and tool results as
`{ "role": "tool", "tool_call_id": "...", "content": "..." }`. When a slash command
is used, the extension prepends `{ "role": "system", "content": "=== SKILL ... ===" }`.

### Response: `text/event-stream`

| event | data | notes |
|---|---|---|
| `route` | `{"role","backend","model","reason","tools_enabled"}` | first event; `role` ∈ code/vision/agentic, `backend` ∈ ollama/openrouter/opencode_zen |
| `token` | raw text | newlines are sent as multiple `data:` lines (SSE spec) |
| `tool_call` | `{"id","name","arguments"}` | `arguments` is a JSON string; the extension executes the tool locally and posts the result back in the next request |
| `error` | message | the extension aborts the turn |
| `done` | empty | always last |

The eleven tools the extension can execute, with the argument names it expects, are
declared in `TOOLS` in `server.py` and implemented in `src/tools/executors.ts`.
