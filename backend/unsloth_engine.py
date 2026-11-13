"""In-process Unsloth inference for the Cloud AI router (``CLOUD_BACKEND=unsloth``).

Serves a Hugging Face model id, or a folder holding a LoRA adapter saved by
``model.save_pretrained`` (for example a run directory on Google Drive), without
exporting to GGUF first. ``server.py`` imports this module lazily, so the Ollama
path keeps working without torch or unsloth installed.

Text only. Image turns stay on Ollama (``CLOUD_VISION_MODEL``).

Tool calling uses the model's own chat template (``apply_chat_template(tools=...)``)
and the Hermes/Qwen convention for the reply: ``<tool_call>{"name": ..., "arguments": {...}}</tool_call>``.
Models whose template emits another convention will answer in plain text.
"""
from __future__ import annotations

import asyncio
import json
import os
import threading
import uuid
from typing import Any, AsyncIterator, Iterator


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


MODEL = _env("CLOUD_UNSLOTH_MODEL", "unsloth/Qwen3-4B-Instruct-2507")
LOADER = _env("CLOUD_UNSLOTH_LOADER", "language").lower()  # language -> FastLanguageModel, model -> FastModel
MAX_SEQ = int(_env("CLOUD_UNSLOTH_MAX_SEQ", "8192"))
LOAD_4BIT = _env("CLOUD_UNSLOTH_4BIT", "1").lower() not in ("0", "false", "off")
TEMPLATE = _env("CLOUD_UNSLOTH_TEMPLATE")  # optional unsloth.chat_templates name, e.g. qwen3-instruct
MAX_NEW_TOKENS = int(_env("CLOUD_MAX_NEW_TOKENS", "2048"))
FAKE = _env("CLOUD_UNSLOTH_FAKE").lower() in ("1", "true", "on")  # canned output, used by the smoke test

OPEN, CLOSE = "<tool_call>", "</tool_call>"


class ToolCallParser:
    """Split a token stream into ("token", str) and ("tool_call", dict) events.

    Text is passed through as it arrives, except that anything which could be the
    start of ``<tool_call>`` is held back until it is known not to be one.
    """

    def __init__(self) -> None:
        self.buf = ""
        self.inside = False

    def feed(self, text: str) -> list[tuple[str, Any]]:
        self.buf += text
        out: list[tuple[str, Any]] = []
        while True:
            if self.inside:
                end = self.buf.find(CLOSE)
                if end < 0:
                    return out
                out.append(self._call(self.buf[:end]))
                self.buf = self.buf[end + len(CLOSE):]
                self.inside = False
                continue
            start = self.buf.find(OPEN)
            if start >= 0:
                if self.buf[:start].strip():
                    out.append(("token", self.buf[:start]))
                self.buf = self.buf[start + len(OPEN):]
                self.inside = True
                continue
            keep = next((n for n in range(min(len(OPEN) - 1, len(self.buf)), 0, -1) if OPEN.startswith(self.buf[-n:])), 0)
            if len(self.buf) > keep:
                out.append(("token", self.buf[: len(self.buf) - keep]))
                self.buf = self.buf[len(self.buf) - keep:]
            return out

    def flush(self) -> list[tuple[str, Any]]:
        rest, self.buf = self.buf, ""
        if not rest.strip():
            return []
        if self.inside:  # generation stopped inside the block: still try to use it
            self.inside = False
            return [self._call(rest)]
        return [("token", rest)]

    @staticmethod
    def _call(raw: str) -> tuple[str, Any]:
        try:
            obj = json.loads(raw.strip())
            args = obj.get("arguments", obj.get("parameters", {}))
            return "tool_call", {
                "id": f"call_{uuid.uuid4().hex[:12]}",
                "name": str(obj.get("name", "")),
                "arguments": args if isinstance(args, str) else json.dumps(args or {}),
            }
        except (json.JSONDecodeError, AttributeError):
            return "token", f"{OPEN}{raw}{CLOSE}"  # unparseable: show it rather than drop it


class Engine:
    def __init__(self) -> None:
        self.model: Any = None
        self.tokenizer: Any = None
        self.state = "idle"  # idle | loading | ready | error
        self.error = ""
        self._load_lock = threading.Lock()
        self._gen_lock = asyncio.Lock()  # one generation at a time on one GPU

    # ── loading ──────────────────────────────────────────────────────────
    def load(self) -> None:
        with self._load_lock:
            if self.state in ("ready", "loading"):
                return
            self.state = "loading"
        try:
            if not FAKE:
                import unsloth  # noqa: F401  must be imported before transformers

                cls = unsloth.FastModel if LOADER == "model" else unsloth.FastLanguageModel
                model, tok = cls.from_pretrained(
                    model_name=MODEL, max_seq_length=MAX_SEQ, dtype=None, load_in_4bit=LOAD_4BIT
                )
                if TEMPLATE:
                    from unsloth.chat_templates import get_chat_template

                    tok = get_chat_template(tok, chat_template=TEMPLATE)
                cls.for_inference(model)
                self.model, self.tokenizer = model, tok
            self.state = "ready"
        except Exception as e:  # noqa: BLE001  reported through /health and the error event
            self.error, self.state = f"{type(e).__name__}: {e}", "error"

    def load_in_background(self) -> None:
        threading.Thread(target=self.load, name="unsloth-load", daemon=True).start()

    # ── generation ───────────────────────────────────────────────────────
    def _text_stream(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None,
        temperature: float, think: bool | None, stop: threading.Event,
    ) -> Iterator[str]:
        if FAKE:
            yield from _fake_stream(messages, tools)
            return
        from transformers import StoppingCriteria, StoppingCriteriaList, TextIteratorStreamer

        class _Stop(StoppingCriteria):
            def __call__(self, *_: Any, **__: Any) -> bool:
                return stop.is_set()

        kwargs: dict[str, Any] = {}
        if tools:
            kwargs["tools"] = tools
        if think is not None:
            kwargs["enable_thinking"] = think
        inputs = self.tokenizer.apply_chat_template(
            messages, add_generation_prompt=True, tokenize=True, return_dict=True, return_tensors="pt", **kwargs
        ).to(self.model.device)
        streamer = TextIteratorStreamer(self.tokenizer, skip_prompt=True, skip_special_tokens=True)
        gen: dict[str, Any] = dict(
            **inputs, streamer=streamer, max_new_tokens=MAX_NEW_TOKENS, use_cache=True,
            stopping_criteria=StoppingCriteriaList([_Stop()]),
        )
        if temperature > 0:
            gen.update(do_sample=True, temperature=temperature)
        else:
            gen.update(do_sample=False)
        failure: list[BaseException] = []

        def run() -> None:
            try:
                self.model.generate(**gen)
            except BaseException as e:  # noqa: BLE001
                failure.append(e)
                streamer.end()

        t = threading.Thread(target=run, name="unsloth-generate", daemon=True)
        t.start()
        yield from streamer
        t.join()
        if failure:
            raise failure[0]

    async def stream(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None,
        temperature: float = 0.2, think: bool | None = None,
    ) -> AsyncIterator[tuple[str, Any]]:
        """Yield ("token", str) and ("tool_call", {id,name,arguments:str})."""
        if self.state != "ready":
            await asyncio.to_thread(self.load)
        if self.state != "ready":
            raise RuntimeError(f"unsloth model {MODEL} not loaded: {self.error or self.state}")

        loop = asyncio.get_running_loop()
        q: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
        stop = threading.Event()

        def pump() -> None:
            try:
                for piece in self._text_stream(messages, tools, temperature, think, stop):
                    loop.call_soon_threadsafe(q.put_nowait, ("text", piece))
                loop.call_soon_threadsafe(q.put_nowait, ("end", None))
            except BaseException as e:  # noqa: BLE001
                loop.call_soon_threadsafe(q.put_nowait, ("fail", e))

        parser = ToolCallParser()
        async with self._gen_lock:
            threading.Thread(target=pump, name="unsloth-pump", daemon=True).start()
            try:
                while True:
                    kind, data = await q.get()
                    if kind == "fail":
                        raise data
                    if kind == "end":
                        break
                    for ev in parser.feed(data):
                        yield ev
                for ev in parser.flush():
                    yield ev
            finally:
                stop.set()  # client went away or we are done: stop generating


def _fake_stream(messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None) -> Iterator[str]:
    """Same behaviour as tests/mock_ollama.py, with the tool call split across chunks."""
    n_system = sum(1 for m in messages if m.get("role") == "system")
    if tools and not any(m.get("role") == "tool" for m in messages):
        yield from ("Reading it.\n<tool", '_call>\n{"name": "read_file", "argu', 'ments": {"path": "README.md"}}\n</tool_', "call>")
        return
    pieces = [f"[sys={n_system}] "]
    if any(m.get("role") == "tool" for m in messages):
        pieces.append("[after-tool] ")
    pieces += ["Hello", " from\n", "```python\nprint(1 < 2)\n```", "\n"]
    yield from pieces


ENGINE = Engine()
