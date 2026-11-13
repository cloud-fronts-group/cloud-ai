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
CLOUD_TOKEN=change-me python backend/server.py     # listens on 0.0.0.0:7655
```

Then in VS Code → Settings → Cloud AI set `cloud.tunnelUrl` to `http://localhost:7655`
(or your tunnel URL) and `cloud.token` to the same token.

**On Colab with Unsloth instead of Ollama:** open [`cloud_colab_unsloth.ipynb`](cloud_colab_unsloth.ipynb)
([open in Colab](https://colab.research.google.com/github/cloud-fronts-group/cloud-ai/blob/main/backend/cloud_colab_unsloth.ipynb)),
or drive the same thing from a terminal with the [Colab CLI](https://github.com/googlecolab/google-colab-cli):

```bash
uv tool install google-colab-cli
CLOUD_UNSLOTH_MODEL=/content/drive/MyDrive/CASMI26/runs/qwen3-4b-v1/lora backend/colab_up.sh my-session
```

`colab_up.sh` allocates the VM, mounts Google Drive when the model lives there, installs
Unsloth, uploads the router, starts it behind a tunnel and prints `CLOUD_URL` / `CLOUD_TOKEN`.
See [Unsloth backend](#unsloth-backend) below.

**Smoke test without any model** (starts a mock Ollama, runs the protocol end to end):

```bash
python backend/tests/smoke_test.py
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CLOUD_TOKEN` | random, printed at start | Bearer token the extension must send |
| `CLOUD_HOST` / `CLOUD_PORT` | `0.0.0.0` / `7655` (`7654` with `CLOUD_BACKEND=unsloth`) | Bind address. Port 8000 is never used: it is reserved for Evidently |
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

## Unsloth backend

`CLOUD_BACKEND=unsloth` loads one model inside the router process with
`FastLanguageModel.from_pretrained` and streams from `model.generate`. It serves the
code and agentic roles; image turns still go to Ollama, so `models.vision` is `null`
unless Ollama is running too. `/health` reports `"status": "loading"` until the model is in memory.

| Variable | Default | Meaning |
|---|---|---|
| `CLOUD_BACKEND` | `ollama` | `ollama` or `unsloth` |
| `CLOUD_UNSLOTH_MODEL` | `unsloth/Qwen3-4B-Instruct-2507` | Hub id, or a folder with a saved LoRA adapter / merged model |
| `CLOUD_UNSLOTH_LOADER` | `language` | `language` = `FastLanguageModel`, `model` = `FastModel` (Gemma 3n/4 and other newer architectures) |
| `CLOUD_UNSLOTH_4BIT` | `1` | Load in 4-bit. Serve at the precision you trained at |
| `CLOUD_UNSLOTH_MAX_SEQ` | `8192` | `max_seq_length` |
| `CLOUD_UNSLOTH_TEMPLATE` | unset | Name for `unsloth.chat_templates.get_chat_template`, when the tokenizer has no usable template |
| `CLOUD_MAX_NEW_TOKENS` | `2048` | Generation cap per turn |

Tool calling relies on the model's chat template accepting `tools=` and on the reply
using `<tool_call>{"name": ..., "arguments": {...}}</tool_call>` (Qwen, Hermes-style
templates). A model fine-tuned on a narrow task, such as a spectrum-to-structure
adapter, will usually have lost general tool use: keep `cloud.toolsEnabled` off for it.

**Google Drive and the Colab CLI.** `drive.mount()` does not prompt in the kernel: drivefs
sends a `colab_request` over the websocket and blocks until it gets a `colab_reply`. In the
browser the Colab front end answers it. From a terminal only `colab drivemount` does: it
calls Colab's credential-propagation endpoint, shows the Google consent URL when one is
needed, and replies to the kernel, waiting up to 10 minutes. `colab exec` does not, so
`colab_up.sh` always mounts with `colab drivemount` first and the notebook skips
`drive.mount()` when `/content/drive` is already a mount point. That step needs a person
at a terminal; it cannot run in CI.

The CLI records every command, execution and stdin exchange of a session in
`~/.config/colab-cli/history/<session>.jsonl` (owner-only). Because `colab_start.py`
prints `CLOUD_TOKEN`, that file holds the token: treat it like `.env`.

**Smoke test** (canned generation, no GPU or torch needed): `python backend/tests/smoke_test_unsloth.py`

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
| `route` | `{"role","backend","model","reason","tools_enabled"}` | first event; `role` ∈ code/vision/agentic, `backend` ∈ ollama/unsloth/openrouter/opencode_zen |
| `token` | raw text | newlines are sent as multiple `data:` lines (SSE spec) |
| `tool_call` | `{"id","name","arguments"}` | `arguments` is a JSON string; the extension executes the tool locally and posts the result back in the next request |
| `error` | message | the extension aborts the turn |
| `done` | empty | always last |

The eleven tools the extension can execute, with the argument names it expects, are
declared in `TOOLS` in `server.py` and implemented in `src/tools/executors.ts`.
