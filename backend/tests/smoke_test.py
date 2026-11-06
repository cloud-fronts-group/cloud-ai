#!/usr/bin/env python3
"""End-to-end protocol test:  this client  ->  server.py  ->  mock Ollama.

The SSE reader below uses the same algorithm as parseSse() in src/client.ts, so
if this passes, the extension will decode what the server sends. Exit code 0 on
success, 1 on any failure. Only needs backend/requirements.txt installed.
"""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
TOKEN = "smoke-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_http(url: str, headers=None, tries: int = 80) -> bool:
    for _ in range(tries):
        try:
            urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=2)
            return True
        except urllib.error.HTTPError:
            return True  # server is up even if it answered 4xx
        except Exception:
            time.sleep(0.25)
    return False


def sse_events(resp):
    """Spec-compliant SSE reader — mirrors parseSse() in src/client.ts."""
    events, ev, data = [], None, None
    for raw in resp:
        line = raw.decode("utf-8").rstrip("\r\n")
        if line == "":
            if ev is not None and data is not None:
                events.append((ev, "\n".join(data)))
            ev, data = None, None
            continue
        if line.startswith(":"):
            continue
        if line.startswith("event:"):
            ev = line[6:].strip()
        elif line.startswith("data:"):
            d = line[5:]
            if d.startswith(" "):
                d = d[1:]
            if data is None:
                data = []
            data.append(d)
    if ev is not None and data is not None:
        events.append((ev, "\n".join(data)))
    return events


def post_sse(url: str, body: dict):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers={**AUTH, "Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        ct = resp.headers.get("content-type", "")
        assert ct.startswith("text/event-stream"), f"content-type={ct}"
        return sse_events(resp)


def main() -> int:
    mock_port, srv_port = free_port(), free_port()
    env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    mock = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "mock_ollama:app", "--port", str(mock_port), "--log-level", "warning"],
        cwd=HERE,
        env=env,
    )
    srv = subprocess.Popen(
        [sys.executable, os.path.join(BACKEND, "server.py")],
        env={
            **env,
            "CLOUD_TOKEN": TOKEN,
            "CLOUD_HOST": "127.0.0.1",
            "CLOUD_PORT": str(srv_port),
            "OLLAMA_HOST": f"http://127.0.0.1:{mock_port}",
            "CLOUD_FALLBACK_KEY": "",
            "CLOUD_LOG_LEVEL": "warning",
        },
    )
    failures: list[str] = []

    def check(cond: bool, msg: str) -> None:
        print(("  ok   " if cond else "  FAIL ") + msg)
        if not cond:
            failures.append(msg)

    try:
        base = f"http://127.0.0.1:{srv_port}"
        assert wait_http(f"http://127.0.0.1:{mock_port}/api/tags"), "mock ollama did not start"
        assert wait_http(f"{base}/health", AUTH), "server did not start"

        print("[1] auth")
        try:
            urllib.request.urlopen(f"{base}/health", timeout=5)
            check(False, "unauthenticated /health must be rejected")
        except urllib.error.HTTPError as e:
            check(e.code == 401, f"unauthenticated /health -> {e.code}")

        print("[2] /health shape")
        h = json.load(urllib.request.urlopen(urllib.request.Request(f"{base}/health", headers=AUTH), timeout=5))
        check(h["status"] == "ok", f"status={h['status']}")
        check(h["models"] == {"code": "qwen3:30b", "vision": "gemma3:27b", "agentic": "qwen3:30b"}, f"models={h['models']}")
        check(set(h["gpu"]) == {"name", "vram_used_mb", "vram_total_mb", "gpu_util_pct", "temp_c"}, "gpu keys")
        check(h["gpu"]["vram_total_mb"] > 0, "vram_total_mb > 0 (status bar divides by it)")

        print("[3] /vibe/ask — route first, done last, newlines inside tokens survive")
        ev = post_sse(f"{base}/vibe/ask", {"prompt": "hi", "file_context": "x = 1", "image_data": None})
        kinds = [k for k, _ in ev]
        check(kinds[0] == "route" and kinds[-1] == "done", f"event order {kinds}")
        rt = json.loads(ev[0][1])
        check(rt["role"] == "code" and rt["backend"] == "ollama" and rt["model"] == "qwen3:30b", f"route={rt}")
        text = "".join(d for k, d in ev if k == "token")
        check(text == "[sys=1] Hello from\n```python\nprint(1)\n```\n", f"reassembled text {text!r}")

        print("[4] /vibe/chat — tools -> agentic route + tool_call event")
        ev = post_sse(f"{base}/vibe/chat", {"messages": [{"role": "user", "content": "read the readme"}], "tools_enabled": True, "image_data": None})
        rt = json.loads(ev[0][1])
        check(rt["role"] == "agentic" and rt["tools_enabled"] is True, f"route={rt}")
        tcs = [json.loads(d) for k, d in ev if k == "tool_call"]
        check(len(tcs) == 1 and tcs[0]["name"] == "read_file", f"tool_calls={tcs}")
        check(isinstance(tcs[0].get("arguments"), str) and json.loads(tcs[0]["arguments"]) == {"path": "README.md"},
              "arguments is a JSON string (the extension JSON.parse's it)")
        check(tcs[0]["id"].startswith("call_"), "tool call id present")
        check([k for k, _ in ev][-1] == "done", "done last")

        print("[5] /vibe/chat — tool result round-trip (OpenAI-shaped history -> Ollama-shaped)")
        hist = [
            {"role": "user", "content": "read the readme"},
            {"role": "assistant", "tool_calls": [{"id": tcs[0]["id"], "type": "function",
                                                  "function": {"name": "read_file", "arguments": tcs[0]["arguments"]}}]},
            {"role": "tool", "tool_call_id": tcs[0]["id"], "content": "# README\nhello"},
        ]
        ev = post_sse(f"{base}/vibe/chat", {"messages": hist, "tools_enabled": True, "image_data": None})
        text = "".join(d for k, d in ev if k == "token")
        check(text.startswith("[sys=1] [after-tool] "), f"text={text!r}")
        check([k for k, _ in ev][-1] == "done", "done last")

        print("[6] /vibe/chat — image -> vision route, tools suppressed")
        ev = post_sse(f"{base}/vibe/chat", {"messages": [{"role": "user", "content": "what is this"}], "tools_enabled": True,
                                            "image_data": "data:image/png;base64,iVBORw0KGgo="})
        rt = json.loads(ev[0][1])
        check(rt["role"] == "vision" and rt["model"] == "gemma3:27b" and rt["tools_enabled"] is False, f"route={rt}")
        text = "".join(d for k, d in ev if k == "token")
        check(text.startswith("[sys=1] [vision] "), f"text={text!r}")

        print("[7] /vibe/chat — slash-command skill prefix is kept as a second system message")
        ev = post_sse(f"{base}/vibe/chat", {"messages": [{"role": "system", "content": "=== SKILL: EDA ==="},
                                                         {"role": "user", "content": "focus on time series"}],
                                            "tools_enabled": False, "image_data": None})
        text = "".join(d for k, d in ev if k == "token")
        check(text.startswith("[sys=2] "), f"text={text!r}")
        check([k for k, _ in ev][-1] == "done", "done last")
    finally:
        for p in (srv, mock):
            p.terminate()
        for p in (srv, mock):
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()

    if failures:
        print(f"\n{len(failures)} check(s) FAILED")
        return 1
    print("\nALL PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
