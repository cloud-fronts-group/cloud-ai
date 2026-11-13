#!/usr/bin/env python3
"""Protocol test for CLOUD_BACKEND=unsloth:  this client -> server.py -> unsloth_engine (canned output).

CLOUD_UNSLOTH_FAKE=1 replaces model.generate with a fixed token stream, so this
needs neither a GPU nor torch. It exercises everything else: routing, /health,
the streaming <tool_call> parser and the SSE encoding. Exit code 0 on success.
"""
import json
import os
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
sys.path[:0] = [HERE, BACKEND]

from smoke_test import AUTH, TOKEN, free_port, post_sse, wait_http  # noqa: E402
from unsloth_engine import ToolCallParser  # noqa: E402

MODEL = "unsloth/Qwen3-4B-Instruct-2507"


def main() -> int:
    failures: list[str] = []

    def check(cond: bool, msg: str) -> None:
        print(("  ok   " if cond else "  FAIL ") + msg)
        if not cond:
            failures.append(msg)

    print("[1] ToolCallParser")
    text = 'before <tool_call>\n{"name": "bash", "arguments": {"command": "ls"}}\n</tool_call> after a < b'
    for size in (1, 3, 7, len(text)):
        p, ev = ToolCallParser(), []
        for i in range(0, len(text), size):
            ev += p.feed(text[i:i + size])
        ev += p.flush()
        plain = "".join(d for k, d in ev if k == "token")
        calls = [d for k, d in ev if k == "tool_call"]
        check(plain == "before  after a < b" and len(calls) == 1 and calls[0]["name"] == "bash"
              and json.loads(calls[0]["arguments"]) == {"command": "ls"}, f"chunk size {size}")
    p = ToolCallParser()
    ev = p.feed("<tool_call>not json</tool_call>") + p.flush()
    check(ev == [("token", "<tool_call>not json</tool_call>")], "unparseable block is shown, not dropped")

    port = free_port()
    srv = subprocess.Popen(
        [sys.executable, os.path.join(BACKEND, "server.py")],
        env={**os.environ, "PYTHONUNBUFFERED": "1", "CLOUD_TOKEN": TOKEN, "CLOUD_HOST": "127.0.0.1",
             "CLOUD_PORT": str(port), "CLOUD_BACKEND": "unsloth", "CLOUD_UNSLOTH_FAKE": "1",
             "CLOUD_UNSLOTH_MODEL": MODEL, "OLLAMA_HOST": "http://127.0.0.1:9", "CLOUD_FALLBACK_KEY": "",
             "CLOUD_LOG_LEVEL": "warning"},
    )
    try:
        base = f"http://127.0.0.1:{port}"
        assert wait_http(f"{base}/health", AUTH), "server did not start"

        print("[2] /vibe/ask -> unsloth route, text intact")
        ev = post_sse(f"{base}/vibe/ask", {"prompt": "hi", "file_context": None, "image_data": None})
        rt = json.loads(ev[0][1])
        check(rt["backend"] == "unsloth" and rt["model"] == MODEL and rt["role"] == "code", f"route={rt}")
        check("".join(d for k, d in ev if k == "token") == "[sys=1] Hello from\n```python\nprint(1 < 2)\n```\n", "text")
        check([k for k, _ in ev][-1] == "done", "done last")

        print("[3] /health once the model is loaded")
        h = json.load(urllib.request.urlopen(urllib.request.Request(f"{base}/health", headers=AUTH), timeout=5))
        check(h["status"] == "ok" and h["models"] == {"code": MODEL, "vision": None, "agentic": MODEL}, f"health={h}")

        print("[4] /vibe/chat with tools -> tool_call parsed out of the token stream")
        ev = post_sse(f"{base}/vibe/chat", {"messages": [{"role": "user", "content": "read the readme"}],
                                            "tools_enabled": True, "image_data": None})
        tcs = [json.loads(d) for k, d in ev if k == "tool_call"]
        check(len(tcs) == 1 and tcs[0]["name"] == "read_file" and json.loads(tcs[0]["arguments"]) == {"path": "README.md"},
              f"tool_calls={tcs}")
        check("".join(d for k, d in ev if k == "token") == "Reading it.\n", "text before the call is kept")
        check("<tool" not in "".join(d for k, d in ev if k == "token"), "no tool-call markup leaks into the text")

        print("[5] tool result round-trip")
        hist = [{"role": "user", "content": "read the readme"},
                {"role": "assistant", "tool_calls": [{"id": tcs[0]["id"], "type": "function",
                                                      "function": {"name": "read_file", "arguments": tcs[0]["arguments"]}}]},
                {"role": "tool", "tool_call_id": tcs[0]["id"], "content": "# README"}]
        ev = post_sse(f"{base}/vibe/chat", {"messages": hist, "tools_enabled": True, "image_data": None})
        check("".join(d for k, d in ev if k == "token").startswith("[sys=1] [after-tool] "), "after-tool text")

        print("[6] image turn stays on Ollama; unreachable Ollama surfaces as an error event")
        ev = post_sse(f"{base}/vibe/chat", {"messages": [{"role": "user", "content": "what is this"}],
                                            "tools_enabled": False, "image_data": "data:image/png;base64,iVBORw0KGgo="})
        check(json.loads(ev[0][1])["backend"] == "ollama", "vision route backend")
        check([k for k, _ in ev][-2:] == ["error", "done"], f"events {[k for k, _ in ev]}")
    finally:
        srv.terminate()
        try:
            srv.wait(5)
        except subprocess.TimeoutExpired:
            srv.kill()

    print(f"\n{len(failures)} check(s) FAILED" if failures else "\nALL PASSED")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
