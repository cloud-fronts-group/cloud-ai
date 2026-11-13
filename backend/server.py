#!/usr/bin/env python3
"""
Cloud AI — reference backend.

Implements the exact HTTP + Server-Sent-Events protocol that the VS Code
extension speaks (see ``src/client.ts``):

    GET  /health      -> HealthResponse (JSON)
    POST /vibe/ask    -> SSE  route, token*, [error], done
    POST /vibe/chat   -> SSE  route, token*, tool_call*, [error], done

Every request must carry ``Authorization: Bearer $CLOUD_TOKEN``.

Inference runs on Ollama (``/api/chat`` streaming, with tools) or, with
``CLOUD_BACKEND=unsloth``, on an Unsloth model loaded in this process (see
``unsloth_engine.py``; image turns still go to Ollama). When
``CLOUD_FALLBACK_KEY`` is set, an OpenAI-compatible endpoint (OpenRouter by
default) is used if Ollama cannot be reached or rejects the request.

The server is stateless: the extension owns the conversation history and
executes every tool call locally, then posts the full transcript back.

Run locally:
    CLOUD_TOKEN=secret python backend/server.py
    # or: CLOUD_TOKEN=secret uvicorn server:app --host 0.0.0.0 --port 7655
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import shutil
import subprocess
import uuid
from typing import Any, AsyncIterator

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

VERSION = "0.5.0"
REPO = "https://github.com/cloud-fronts-group/cloud-ai"


# ── Configuration (environment) ──────────────────────────────────────────
def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _with_scheme(host: str) -> str:
    return host if "://" in host else f"http://{host}"


TOKEN = _env("CLOUD_TOKEN") or secrets.token_urlsafe(24)
HOST = _env("CLOUD_HOST", "0.0.0.0")

BACKEND = _env("CLOUD_BACKEND", "ollama").lower()  # ollama | unsloth
if BACKEND not in ("ollama", "unsloth"):
    raise SystemExit(f"CLOUD_BACKEND must be 'ollama' or 'unsloth', got {BACKEND!r}")

OLLAMA_HOST = _with_scheme(_env("OLLAMA_HOST", "http://127.0.0.1:11434")).rstrip("/")
VISION_MODEL = _env("CLOUD_VISION_MODEL", "gemma3:27b")
if BACKEND == "unsloth":
    import unsloth_engine

    # One model is loaded in-process and serves both the code and the agentic role.
    CODE_MODEL = AGENTIC_MODEL = unsloth_engine.MODEL
else:
    unsloth_engine = None  # type: ignore[assignment]
    CODE_MODEL = _env("CLOUD_CODE_MODEL", "qwen3:30b")
    AGENTIC_MODEL = _env("CLOUD_AGENTIC_MODEL") or CODE_MODEL
# 8000 is reserved for Evidently on our hosts: the Unsloth router takes 7654, everything else 7655 and up.
PORT = int(_env("CLOUD_PORT", "7654" if BACKEND == "unsloth" else "7655"))
if PORT == 8000:
    raise SystemExit("CLOUD_PORT=8000 is reserved for Evidently; use 7654 (unsloth) or 7655+")
NUM_CTX = int(_env("CLOUD_NUM_CTX", "16384"))
TEMPERATURE = float(_env("CLOUD_TEMPERATURE", "0.2"))
THINK = _env("CLOUD_THINK").lower()  # "" = model default, "0"/"1" = force off/on

# Optional OpenAI-compatible fallback (the RouteEvent enum allows openrouter | opencode_zen)
FALLBACK_NAME = _env("CLOUD_FALLBACK_NAME", "openrouter")
FALLBACK_URL = _env("CLOUD_FALLBACK_URL", "https://openrouter.ai/api/v1").rstrip("/")
FALLBACK_KEY = _env("CLOUD_FALLBACK_KEY")
FALLBACK_MODEL = _env("CLOUD_FALLBACK_MODEL", "qwen/qwen3-coder")

REQUEST_TIMEOUT = httpx.Timeout(connect=10.0, read=600.0, write=60.0, pool=10.0)

# ── Prompts ──────────────────────────────────────────────────────────────
SYSTEM_CHAT = """You are Cloud AI, a Vibe Coding assistant that lives in a VS Code sidebar.
You help with general coding, data analytics, data science / ML and AI engineering.

Ground rules:
- Be direct and concrete. Prefer working code over prose. Use Markdown with fenced code blocks.
- When tools are available, use them instead of guessing: read files before editing them, prefer edit_file (exact old_string -> new_string) over rewriting whole files, and run bash to verify your work.
- Tools execute on the USER'S machine inside their VS Code workspace; relative paths resolve from the workspace root. Every write or bash call is shown to the user for approval, so keep calls purposeful and say what you are about to do.
- If a slash-command skill is active (a system message framed by === SKILL ... === END SKILL ===), follow it as your primary guide for this response.
- Answer in the language the user writes in (Portuguese or English)."""

SYSTEM_ASK = """You are Cloud AI, a coding assistant invoked from a VS Code editor command (explain, refactor or generate).
Follow the instructions in the user message exactly. When asked for code only, return only code: no Markdown fences, no commentary."""


# ── Tool catalogue (OpenAI / Ollama function-calling schema) ─────────────
# Argument names must match src/tools/executors.ts in the extension.
def _tool(name: str, description: str, properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": properties, "required": required},
        },
    }


TOOLS: list[dict[str, Any]] = [
    _tool(
        "read_file",
        "Read a text file from the user's workspace. Returns numbered lines. Use line_start/line_end on large files.",
        {
            "path": {"type": "string", "description": "Absolute or workspace-relative path"},
            "line_start": {"type": "integer", "description": "First line to return (1-based)"},
            "line_end": {"type": "integer", "description": "Last line to return (inclusive)"},
        },
        ["path"],
    ),
    _tool(
        "write_file",
        "Create or overwrite a file with the given content. Parent directories are created.",
        {"path": {"type": "string"}, "content": {"type": "string"}},
        ["path", "content"],
    ),
    _tool(
        "edit_file",
        "Replace exactly one occurrence of old_string with new_string in a file. old_string must be unique; include surrounding lines to disambiguate.",
        {"path": {"type": "string"}, "old_string": {"type": "string"}, "new_string": {"type": "string"}},
        ["path", "old_string", "new_string"],
    ),
    _tool(
        "bash",
        "Run a shell command in the workspace root with /bin/bash. Returns STDOUT, STDERR and EXIT CODE.",
        {
            "command": {"type": "string"},
            "description": {"type": "string", "description": "One line saying what the command does"},
            "timeout_s": {"type": "number", "description": "Timeout in seconds (default 30, max 300)"},
        },
        ["command"],
    ),
    _tool(
        "glob",
        "List files matching a bash glob pattern (globstar enabled, e.g. src/**/*.ts).",
        {
            "pattern": {"type": "string"},
            "cwd": {"type": "string", "description": "Directory to search from (default: workspace root)"},
        },
        ["pattern"],
    ),
    _tool(
        "grep",
        "Recursive extended-regex search (grep -rEn). Returns file:line:match, at most 500 lines.",
        {
            "pattern": {"type": "string"},
            "path": {"type": "string", "description": "File or directory to search"},
            "glob": {"type": "string", "description": "Optional --include filter, e.g. *.py"},
        },
        ["pattern", "path"],
    ),
    _tool(
        "web_fetch",
        "Fetch a URL and return its text (HTML is stripped to plain text).",
        {
            "url": {"type": "string"},
            "max_chars": {"type": "integer", "description": "Truncate after this many characters (default 8000)"},
        },
        ["url"],
    ),
    _tool(
        "web_search",
        "Web search (DuckDuckGo). Returns numbered results with title, URL and snippet.",
        {"query": {"type": "string"}, "max_results": {"type": "integer", "description": "1-20, default 8"}},
        ["query"],
    ),
    _tool(
        "todo_write",
        "Replace the session task list. Use it to plan multi-step work and show progress.",
        {
            "todos": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "content": {"type": "string"},
                        "activeForm": {"type": "string", "description": "Present-continuous label shown while in progress"},
                        "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]},
                    },
                    "required": ["content", "status"],
                },
            }
        },
        ["todos"],
    ),
    _tool(
        "memory_write",
        "Persist a named Markdown note under ~/.cloud/memory for future sessions.",
        {"name": {"type": "string"}, "content": {"type": "string"}},
        ["name", "content"],
    ),
    _tool(
        "memory_read",
        "Read a named memory note, or list every note when name is omitted.",
        {"name": {"type": "string"}},
        [],
    ),
]


# ── Routing ──────────────────────────────────────────────────────────────
def route(*, has_image: bool, tools_enabled: bool) -> dict[str, Any]:
    """Pick role/model. Shape matches RouteEvent in src/client.ts."""
    if has_image:
        return {
            "role": "vision",
            "backend": "ollama",
            "model": VISION_MODEL,
            "reason": "image attached -> vision model (tools disabled for vision turns)",
            "tools_enabled": False,
        }
    if tools_enabled:
        return {
            "role": "agentic",
            "backend": BACKEND,
            "model": AGENTIC_MODEL,
            "reason": "tools enabled -> agentic model",
            "tools_enabled": True,
        }
    return {
        "role": "code",
        "backend": BACKEND,
        "model": CODE_MODEL,
        "reason": "text only -> code model",
        "tools_enabled": False,
    }


# ── SSE encoding ─────────────────────────────────────────────────────────
def sse(event: str, data: str) -> bytes:
    """One SSE event. A payload containing newlines becomes several `data:`
    lines, which the client joins back with "\\n" (SSE spec)."""
    out = [f"event: {event}\n"]
    out.extend(f"data: {line}\n" for line in data.split("\n"))
    out.append("\n")
    return "".join(out).encode("utf-8")


def _call_id() -> str:
    return f"call_{uuid.uuid4().hex[:12]}"


def _strip_data_url(b64: str) -> str:
    return b64.split(",", 1)[1] if b64.startswith("data:") else b64


def _parse_args(args: Any) -> dict[str, Any]:
    if isinstance(args, dict):
        return args
    if isinstance(args, str) and args.strip():
        try:
            parsed = json.loads(args)
            return parsed if isinstance(parsed, dict) else {"_value": parsed}
        except json.JSONDecodeError:
            return {"_raw": args}
    return {}


# ── Message conversion ───────────────────────────────────────────────────
def to_ollama_messages(messages: list[dict[str, Any]], image_b64: str | None) -> list[dict[str, Any]]:
    """Extension history is OpenAI-shaped (tool_calls.function.arguments is a
    JSON string, tool results carry tool_call_id). Ollama wants arguments as an
    object and ignores tool_call_id."""
    out: list[dict[str, Any]] = []
    for m in messages:
        role = m.get("role", "user")
        if role == "assistant" and m.get("tool_calls"):
            calls = []
            for tc in m["tool_calls"]:
                fn = tc.get("function") or {}
                calls.append({"function": {"name": fn.get("name", ""), "arguments": _parse_args(fn.get("arguments"))}})
            out.append({"role": "assistant", "content": m.get("content") or "", "tool_calls": calls})
        elif role == "tool":
            out.append({"role": "tool", "content": m.get("content") or ""})
        else:
            out.append({"role": role, "content": m.get("content") or ""})
    if image_b64:
        for m in reversed(out):
            if m["role"] == "user":
                m["images"] = [_strip_data_url(image_b64)]
                break
    return out


def to_openai_messages(messages: list[dict[str, Any]], image_b64: str | None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in messages:
        role = m.get("role", "user")
        if role == "assistant" and m.get("tool_calls"):
            calls = []
            for tc in m["tool_calls"]:
                fn = tc.get("function") or {}
                args = fn.get("arguments")
                calls.append(
                    {
                        "id": tc.get("id") or _call_id(),
                        "type": "function",
                        "function": {
                            "name": fn.get("name", ""),
                            "arguments": args if isinstance(args, str) else json.dumps(args or {}),
                        },
                    }
                )
            out.append({"role": "assistant", "content": m.get("content") or None, "tool_calls": calls})
        elif role == "tool":
            out.append({"role": "tool", "tool_call_id": m.get("tool_call_id") or "", "content": m.get("content") or ""})
        else:
            out.append({"role": role, "content": m.get("content") or ""})
    if image_b64:
        for m in reversed(out):
            if m["role"] == "user":
                url = image_b64 if image_b64.startswith("data:") else f"data:image/png;base64,{image_b64}"
                m["content"] = [
                    {"type": "text", "text": m["content"] or ""},
                    {"type": "image_url", "image_url": {"url": url}},
                ]
                break
    return out


# ── Inference backends ───────────────────────────────────────────────────
class BackendError(RuntimeError):
    pass


async def ollama_stream(
    model: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None
) -> AsyncIterator[tuple[str, Any]]:
    """Yield ("token", str) and ("tool_call", {id,name,arguments:str})."""
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": True,
        "options": {"num_ctx": NUM_CTX, "temperature": TEMPERATURE},
    }
    if tools:
        payload["tools"] = tools
    if THINK in ("0", "false", "off"):
        payload["think"] = False
    elif THINK in ("1", "true", "on"):
        payload["think"] = True

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            async with client.stream("POST", f"{OLLAMA_HOST}/api/chat", json=payload) as r:
                if r.status_code != 200:
                    body = (await r.aread()).decode("utf-8", "replace")
                    raise BackendError(f"ollama HTTP {r.status_code}: {body[:300]}")
                async for line in r.aiter_lines():
                    if not line.strip():
                        continue
                    chunk = json.loads(line)
                    if chunk.get("error"):
                        raise BackendError(f"ollama: {chunk['error']}")
                    msg = chunk.get("message") or {}
                    if msg.get("content"):
                        yield "token", msg["content"]
                    for tc in msg.get("tool_calls") or []:
                        fn = tc.get("function") or {}
                        args = fn.get("arguments")
                        yield "tool_call", {
                            "id": _call_id(),
                            "name": fn.get("name", ""),
                            "arguments": args if isinstance(args, str) else json.dumps(args or {}),
                        }
                    if chunk.get("done"):
                        return
    except httpx.HTTPError as e:
        raise BackendError(f"ollama unreachable at {OLLAMA_HOST}: {e}") from e


async def openai_stream(
    model: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None
) -> AsyncIterator[tuple[str, Any]]:
    """OpenAI-compatible chat/completions streaming (OpenRouter, OpenCode Zen, …)."""
    payload: dict[str, Any] = {"model": model, "messages": messages, "stream": True}
    if tools:
        payload["tools"] = tools
    headers = {"Authorization": f"Bearer {FALLBACK_KEY}", "Content-Type": "application/json"}
    if "openrouter" in FALLBACK_URL:
        headers["HTTP-Referer"] = REPO
        headers["X-Title"] = "Cloud AI"

    pending: dict[int, dict[str, str]] = {}
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            async with client.stream("POST", f"{FALLBACK_URL}/chat/completions", json=payload, headers=headers) as r:
                if r.status_code != 200:
                    body = (await r.aread()).decode("utf-8", "replace")
                    raise BackendError(f"{FALLBACK_NAME} HTTP {r.status_code}: {body[:300]}")
                async for line in r.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    chunk = json.loads(data)
                    if chunk.get("error"):
                        raise BackendError(f"{FALLBACK_NAME}: {chunk['error']}")
                    choice = (chunk.get("choices") or [{}])[0]
                    delta = choice.get("delta") or {}
                    if delta.get("content"):
                        yield "token", delta["content"]
                    for tc in delta.get("tool_calls") or []:
                        slot = pending.setdefault(tc.get("index", 0), {"id": "", "name": "", "arguments": ""})
                        if tc.get("id"):
                            slot["id"] = tc["id"]
                        fn = tc.get("function") or {}
                        if fn.get("name"):
                            slot["name"] += fn["name"]
                        if fn.get("arguments"):
                            slot["arguments"] += fn["arguments"]
    except httpx.HTTPError as e:
        raise BackendError(f"{FALLBACK_NAME} unreachable: {e}") from e

    for slot in pending.values():
        yield "tool_call", {"id": slot["id"] or _call_id(), "name": slot["name"], "arguments": slot["arguments"] or "{}"}


def _think() -> bool | None:
    return False if THINK in ("0", "false", "off") else True if THINK in ("1", "true", "on") else None


async def unsloth_stream(
    model: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None
) -> AsyncIterator[tuple[str, Any]]:
    """Same event contract as ollama_stream, served by the in-process Unsloth model."""
    try:
        async for ev in unsloth_engine.ENGINE.stream(messages, tools, temperature=TEMPERATURE, think=_think()):
            yield ev
    except Exception as e:  # noqa: BLE001
        raise BackendError(f"unsloth ({model}): {type(e).__name__}: {e}") from e


async def generate(
    rt: dict[str, Any],
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    image_b64: str | None,
    request: Request,
) -> AsyncIterator[bytes]:
    yield sse("route", json.dumps(rt))
    emitted = False
    try:
        try:
            primary = unsloth_stream if rt["backend"] == "unsloth" else ollama_stream
            # Both take Ollama-shaped history: tool_calls[].function.arguments as an object.
            async for kind, data in primary(rt["model"], to_ollama_messages(messages, image_b64), tools):
                if await request.is_disconnected():
                    return
                emitted = True
                yield sse(kind, data if kind == "token" else json.dumps(data))
        except BackendError as e:
            if emitted or not FALLBACK_KEY:
                raise
            rt2 = {**rt, "backend": FALLBACK_NAME, "model": FALLBACK_MODEL, "reason": f"{e} -> falling back to {FALLBACK_NAME}"}
            yield sse("route", json.dumps(rt2))
            async for kind, data in openai_stream(FALLBACK_MODEL, to_openai_messages(messages, image_b64), tools):
                if await request.is_disconnected():
                    return
                yield sse(kind, data if kind == "token" else json.dumps(data))
    except Exception as e:  # noqa: BLE001 — anything must reach the client as an `error` event
        yield sse("error", f"{type(e).__name__}: {e}")
    yield sse("done", "")


# ── Health ───────────────────────────────────────────────────────────────
async def ollama_models() -> set[str] | None:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{OLLAMA_HOST}/api/tags")
            r.raise_for_status()
            return {m["name"] for m in r.json().get("models", [])}
    except Exception:  # noqa: BLE001
        return None


def _present(model: str, tags: set[str] | None) -> str | None:
    if tags is None:
        return None
    if model in tags:
        return model
    if ":" not in model and f"{model}:latest" in tags:
        return model
    return None


def gpu_stats() -> dict[str, Any]:
    """Shape matches HealthResponse.gpu in src/client.ts. The status bar divides
    vram_used_mb by vram_total_mb, so total is never 0."""
    if shutil.which("nvidia-smi"):
        try:
            out = subprocess.run(
                [
                    "nvidia-smi",
                    "--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True,
                text=True,
                timeout=5,
                check=True,
            ).stdout.strip().splitlines()[0]
            name, used, total, util, temp = [x.strip() for x in out.split(",")]
            return {
                "name": name,
                "vram_used_mb": int(float(used)),
                "vram_total_mb": max(int(float(total)), 1),
                "gpu_util_pct": int(float(util)),
                "temp_c": int(float(temp)),
            }
        except Exception:  # noqa: BLE001
            pass
    # No GPU: report system RAM so the status-bar percentage still means something.
    try:
        info: dict[str, int] = {}
        with open("/proc/meminfo", encoding="utf-8") as f:
            for line in f:
                k, v = line.split(":", 1)
                info[k] = int(v.split()[0])
        total_mb = info["MemTotal"] // 1024
        avail_mb = info.get("MemAvailable", 0) // 1024
        return {
            "name": "CPU (no GPU) · system RAM",
            "vram_used_mb": total_mb - avail_mb,
            "vram_total_mb": max(total_mb, 1),
            "gpu_util_pct": 0,
            "temp_c": 0,
        }
    except Exception:  # noqa: BLE001
        return {"name": "unknown", "vram_used_mb": 0, "vram_total_mb": 1, "gpu_util_pct": 0, "temp_c": 0}


# ── HTTP layer ───────────────────────────────────────────────────────────
app = FastAPI(title="Cloud AI backend", version=VERSION, docs_url=None, redoc_url=None)

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


async def auth(request: Request) -> None:
    header = request.headers.get("authorization", "")
    if not header.startswith("Bearer ") or not secrets.compare_digest(header[7:], TOKEN):
        raise HTTPException(status_code=401, detail="invalid or missing bearer token")


class AskBody(BaseModel):
    prompt: str
    file_context: str | None = None
    image_data: str | None = None


class ChatBody(BaseModel):
    messages: list[dict[str, Any]]
    tools_enabled: bool = False
    image_data: str | None = None


@app.get("/")
async def root() -> dict[str, Any]:
    return {"name": "cloud-ai-backend", "version": VERSION, "endpoints": ["/health", "/vibe/ask", "/vibe/chat"], "repo": REPO}


@app.get("/health")
async def health(_: None = Depends(auth)) -> dict[str, Any]:
    tags, gpu = await asyncio.gather(ollama_models(), asyncio.to_thread(gpu_stats))
    engine = unsloth_engine.ENGINE if BACKEND == "unsloth" else None
    if engine is not None and engine.state == "ready":
        status = "ok"
    elif engine is not None and engine.state in ("idle", "loading"):
        status = "loading"
    elif engine is None and tags is not None:
        status = "ok"
    elif FALLBACK_KEY:
        status = "ok-fallback"
    else:
        status = "degraded"
    routing = "image->vision · tools->agentic · else->code"
    if engine is not None:
        routing += f" · unsloth={engine.state}" + (f" ({engine.error[:200]})" if engine.error else "")
    loaded = CODE_MODEL if engine is not None and engine.state == "ready" else None
    if FALLBACK_KEY:
        routing += f" · fallback={FALLBACK_NAME}/{FALLBACK_MODEL}"
    return {
        "status": status,
        "version": VERSION,
        "models": {
            "code": loaded if engine is not None else _present(CODE_MODEL, tags),
            "vision": _present(VISION_MODEL, tags),
            "agentic": loaded if engine is not None else _present(AGENTIC_MODEL, tags),
        },
        "routing": routing,
        "gpu": gpu,
    }


@app.post("/vibe/ask")
async def vibe_ask(body: AskBody, request: Request, _: None = Depends(auth)) -> StreamingResponse:
    """Single-shot prompt used by Explain / Refactor / Generate."""
    user = body.prompt
    if body.file_context:
        user = f"Context — the lines immediately before the cursor:\n```\n{body.file_context}\n```\n\n{body.prompt}"
    messages = [{"role": "system", "content": SYSTEM_ASK}, {"role": "user", "content": user}]
    rt = route(has_image=bool(body.image_data), tools_enabled=False)
    return StreamingResponse(
        generate(rt, messages, None, body.image_data, request), media_type="text/event-stream", headers=SSE_HEADERS
    )


@app.post("/vibe/chat")
async def vibe_chat(body: ChatBody, request: Request, _: None = Depends(auth)) -> StreamingResponse:
    """Multi-turn chat. The extension may prepend a skill as a system message;
    our base system prompt goes first so the skill refines rather than replaces it."""
    rt = route(has_image=bool(body.image_data), tools_enabled=body.tools_enabled)
    tools = TOOLS if rt["tools_enabled"] else None
    messages = [{"role": "system", "content": SYSTEM_CHAT}, *body.messages]
    return StreamingResponse(
        generate(rt, messages, tools, body.image_data, request), media_type="text/event-stream", headers=SSE_HEADERS
    )


if __name__ == "__main__":
    import uvicorn

    if not _env("CLOUD_TOKEN"):
        print(f"[cloud] CLOUD_TOKEN not set — generated one for this run:\n[cloud] CLOUD_TOKEN={TOKEN}", flush=True)
    print(
        f"[cloud] v{VERSION} · backend={BACKEND} · ollama={OLLAMA_HOST} · code={CODE_MODEL} · vision={VISION_MODEL} · "
        f"agentic={AGENTIC_MODEL} · fallback={'on:' + FALLBACK_NAME if FALLBACK_KEY else 'off'}",
        flush=True,
    )
    if BACKEND == "unsloth":
        unsloth_engine.ENGINE.load_in_background()  # /health answers "loading" meanwhile
    uvicorn.run(app, host=HOST, port=PORT, log_level=_env("CLOUD_LOG_LEVEL", "info"))
