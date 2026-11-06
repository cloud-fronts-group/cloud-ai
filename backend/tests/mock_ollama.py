"""Tiny stand-in for Ollama's /api/tags and /api/chat, used by smoke_test.py.

Behaviour:
- tools present and no tool result yet  -> one tool_call chunk (read_file README.md), then done
- otherwise                              -> a few text chunks, one of them containing newlines
- a user message with `images`           -> text is prefixed with "[vision] "
- a tool result in the history           -> text is prefixed with "[after-tool] "
"""
import asyncio
import json

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

app = FastAPI()
MODELS = ["qwen3:30b", "gemma3:27b"]


@app.get("/api/tags")
async def tags():
    return {"models": [{"name": m} for m in MODELS]}


def chunk(model, content="", tool_calls=None, done=False):
    msg = {"role": "assistant", "content": content}
    if tool_calls:
        msg["tool_calls"] = tool_calls
    return (json.dumps({"model": model, "message": msg, "done": done}) + "\n").encode()


@app.post("/api/chat")
async def chat(req: Request):
    body = await req.json()
    model = body["model"]
    msgs = body["messages"]
    has_tools = bool(body.get("tools"))
    has_tool_result = any(m.get("role") == "tool" for m in msgs)
    has_image = any(m.get("images") for m in msgs)
    n_system = sum(1 for m in msgs if m.get("role") == "system")

    async def gen():
        if has_tools and not has_tool_result:
            yield chunk(model, tool_calls=[{"function": {"name": "read_file", "arguments": {"path": "README.md"}}}])
            yield chunk(model, done=True)
            return
        pieces = ["Hello", " from\n", "```python\nprint(1)\n```", "\n"]
        if has_image:
            pieces.insert(0, "[vision] ")
        if has_tool_result:
            pieces.insert(0, "[after-tool] ")
        pieces.insert(0, f"[sys={n_system}] ")
        for p in pieces:
            yield chunk(model, content=p)
            await asyncio.sleep(0.01)
        yield chunk(model, done=True)

    return StreamingResponse(gen(), media_type="application/x-ndjson")
