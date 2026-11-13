// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const $messages = document.getElementById("messages");
  const $input = /** @type {HTMLTextAreaElement} */ (document.getElementById("input"));
  const $send = document.getElementById("send");
  const $stop = document.getElementById("stop");
  const $clear = document.getElementById("clear");
  const $route = document.getElementById("route");
  const $tools = /** @type {HTMLInputElement} */ (document.getElementById("tools"));
  const $mic = document.getElementById("mic");
  const $attach = document.getElementById("attach");
  const $file = /** @type {HTMLInputElement} */ (document.getElementById("file"));
  const $attachment = document.getElementById("attachment");
  const $thumb = /** @type {HTMLImageElement} */ (document.getElementById("thumb"));
  const $detach = document.getElementById("detach");

  /** @type {string | null} data: URL of the image waiting to be sent */
  let pendingImage = null;

  function setImage(dataUrl) {
    pendingImage = dataUrl;
    $attachment.hidden = !dataUrl;
    if (dataUrl) $thumb.src = dataUrl;
    else $thumb.removeAttribute("src");
  }

  function readImage(file) {
    if (!file || !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return;
    const fr = new FileReader();
    fr.onload = () => setImage(String(fr.result));
    fr.readAsDataURL(file);
  }

  $attach.addEventListener("click", () => $file.click());
  $file.addEventListener("change", () => {
    readImage($file.files && $file.files[0]);
    $file.value = "";
  });
  $detach.addEventListener("click", () => setImage(null));
  $input.addEventListener("paste", (e) => {
    const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.type.startsWith("image/"));
    if (!item) return;
    e.preventDefault();
    readImage(item.getAsFile());
  });

  let currentAssistant = null;
  let assistantRaw = "";

  function autoSize() {
    $input.style.height = "auto";
    $input.style.height = Math.min($input.scrollHeight, 14 * 16) + "px";
  }
  $input.addEventListener("input", autoSize);

  $input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });

  $send.addEventListener("click", doSend);
  $stop.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  $clear.addEventListener("click", () => vscode.postMessage({ type: "clear" }));
  $tools.addEventListener("change", () => {
    vscode.postMessage({ type: "toggleTools", toolsEnabled: $tools.checked });
  });

  function doSend() {
    const text = $input.value.trim();
    if (!text && !pendingImage) return;
    vscode.postMessage(pendingImage ? { type: "send", text, image: pendingImage } : { type: "send", text });
    setImage(null);
    $input.value = "";
    autoSize();
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function renderMarkdown(src) {
    const parts = [];
    const re = /```(\w*)\n([\s\S]*?)```/g;
    let last = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const before = src.slice(last, m.index);
      parts.push(renderInline(escapeHtml(before)));
      parts.push(`<pre><code>${escapeHtml(m[2])}</code></pre>`);
      last = m.index + m[0].length;
    }
    parts.push(renderInline(escapeHtml(src.slice(last))));
    return parts.join("");
  }

  function renderInline(s) {
    return s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  }

  function addBubble(kind, text, asMarkdown) {
    const el = document.createElement("div");
    el.className = "bubble " + kind;
    if (asMarkdown) el.innerHTML = renderMarkdown(text);
    else el.textContent = text;
    $messages.appendChild(el);
    $messages.scrollTop = $messages.scrollHeight;
    return el;
  }

  function addToolCallBubble(name, argsJson) {
    const el = document.createElement("div");
    el.className = "bubble tool-call";
    let argPreview = argsJson || "";
    try {
      const parsed = JSON.parse(argsJson || "{}");
      const compact = JSON.stringify(parsed);
      argPreview = compact.length > 200 ? compact.slice(0, 200) + "…" : compact;
    } catch {
      // keep the raw text
    }
    el.innerHTML =
      `<span class="tool-icon">🔧</span> <span class="tool-name">${escapeHtml(name)}</span>` +
      `<pre class="tool-args"><code>${escapeHtml(argPreview)}</code></pre>`;
    $messages.appendChild(el);
    $messages.scrollTop = $messages.scrollHeight;
  }

  function addToolResultBubble(name, content) {
    const el = document.createElement("div");
    const isError = content.startsWith("ERROR");
    el.className = "bubble tool-result" + (isError ? " tool-error" : "");
    const icon = isError ? "✗" : "✓";
    const truncated =
      content.length > 1500 ? content.slice(0, 1500) + "\n[…truncated]" : content;
    el.innerHTML =
      `<span class="tool-icon">${icon}</span> <span class="tool-name">${escapeHtml(name)}</span>` +
      `<pre class="tool-args"><code>${escapeHtml(truncated)}</code></pre>`;
    $messages.appendChild(el);
    $messages.scrollTop = $messages.scrollHeight;
  }

  function showThinkingBubble() {
    if (document.getElementById("thinking-bubble")) return;
    const t = document.createElement("div");
    t.className = "bubble thinking";
    t.id = "thinking-bubble";
    t.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    $messages.appendChild(t);
    $messages.scrollTop = $messages.scrollHeight;
  }

  function removeThinkingBubble() {
    const t = document.getElementById("thinking-bubble");
    if (t) t.remove();
  }

  function ensureAssistantBubble() {
    if (currentAssistant) return;
    removeThinkingBubble();
    currentAssistant = document.createElement("div");
    currentAssistant.className = "bubble assistant cursor";
    currentAssistant.textContent = "";
    assistantRaw = "";
    $messages.appendChild(currentAssistant);
    $messages.scrollTop = $messages.scrollHeight;
  }

  function startAssistantTurn() {
    showThinkingBubble();
    $send.hidden = true;
    $stop.hidden = false;
  }

  function endCurrentBubble() {
    if (currentAssistant) {
      currentAssistant.classList.remove("cursor");
      if (assistantRaw) {
        currentAssistant.innerHTML = renderMarkdown(assistantRaw);
      } else {
        // Empty bubble (the model only asked for a tool): remove it
        currentAssistant.remove();
      }
    }
    currentAssistant = null;
    assistantRaw = "";
  }

  function endAssistantTurn() {
    removeThinkingBubble();
    endCurrentBubble();
    $send.hidden = false;
    $stop.hidden = true;
  }

  // ─── Voice input (Web Speech API) ──────────────────────────────────
  const SR =
    /** @type {any} */ (window).SpeechRecognition ||
    /** @type {any} */ (window).webkitSpeechRecognition;
  if (SR) {
    $mic.hidden = false;
    let recognition = null;
    let listening = false;
    $mic.addEventListener("click", () => {
      if (listening) {
        recognition?.stop();
        return;
      }
      recognition = new SR();
      recognition.lang = navigator.language || "pt-BR";
      recognition.interimResults = true;
      recognition.continuous = false;
      recognition.onstart = () => {
        listening = true;
        $mic.classList.add("listening");
      };
      recognition.onend = () => {
        listening = false;
        $mic.classList.remove("listening");
      };
      recognition.onerror = (e) => {
        listening = false;
        $mic.classList.remove("listening");
        console.error("speech error", e);
      };
      recognition.onresult = (e) => {
        let transcript = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          transcript += e.results[i][0].transcript;
        }
        $input.value = (
          $input.value.replace(/\s*$/, "") +
          " " +
          transcript
        ).trimStart();
        autoSize();
      };
      recognition.start();
    });
  }

  // ─── Messages from the extension host ────────────────────────────
  window.addEventListener("message", (event) => {
    const m = event.data;
    switch (m.type) {
      case "config":
        $tools.checked = !!m.toolsEnabled;
        break;
      case "replay":
        $messages.innerHTML = "";
        for (const msg of m.history || []) {
          if (msg.role === "user" && msg.content) {
            addBubble("user", msg.content);
          } else if (msg.role === "assistant" && msg.content) {
            addBubble("assistant", msg.content, true);
          } else if (msg.role === "tool" && msg.content) {
            addToolResultBubble(msg.tool_call_id || "tool", msg.content);
          }
          if (msg.role === "assistant" && msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              addToolCallBubble(tc.function?.name || "?", tc.function?.arguments || "");
            }
          }
        }
        break;
      case "userEcho": {
        const bubble = addBubble("user", m.data);
        if (m.meta && typeof m.meta.image === "string" && m.meta.image.startsWith("data:image/")) {
          const img = document.createElement("img");
          img.className = "attached";
          img.src = m.meta.image;
          bubble.prepend(img);
        }
        startAssistantTurn();
        break;
      }
      case "route":
        if (m.meta && m.meta.backend) {
          const tools = m.meta.tools_enabled ? " · tools" : "";
          $route.textContent = `${m.meta.backend}/${m.meta.model}${tools}`;
        }
        break;
      case "token":
        ensureAssistantBubble();
        assistantRaw += m.data;
        currentAssistant.textContent = assistantRaw;
        $messages.scrollTop = $messages.scrollHeight;
        break;
      case "toolCall": {
        // Close any open text bubble, then show the tool call.
        removeThinkingBubble();
        endCurrentBubble();
        try {
          const tc = JSON.parse(m.data || "{}");
          addToolCallBubble(tc.name || "?", tc.arguments || "");
        } catch {
          addToolCallBubble("?", m.data || "");
        }
        break;
      }
      case "toolResult": {
        try {
          const tr = JSON.parse(m.data || "{}");
          addToolResultBubble(tr.name || "?", tr.content || "");
        } catch {
          addToolResultBubble("?", m.data || "");
        }
        break;
      }
      case "done":
        endAssistantTurn();
        break;
      case "error":
        endAssistantTurn();
        addBubble("error", "error: " + m.data);
        break;
      case "reset":
        $messages.innerHTML = "";
        $route.textContent = "—";
        endAssistantTurn();
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
