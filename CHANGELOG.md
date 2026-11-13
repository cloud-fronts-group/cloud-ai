# Changelog

All notable changes to this extension are documented in this file.

## [Unreleased]

### Added
- Unsloth backend: `CLOUD_BACKEND=unsloth` makes `backend/server.py` load a Hub model or a saved LoRA adapter in-process (`backend/unsloth_engine.py`) instead of calling Ollama. Streams tokens and parses `<tool_call>` blocks into `tool_call` events. Image turns still use Ollama.
- `backend/cloud_colab_unsloth.ipynb` and `backend/colab_up.sh`: start that backend on Colab from the browser or from a terminal with the Colab CLI. Drive is mounted with `colab drivemount`, which handles Colab's credential propagation; the notebook skips `drive.mount()` when Drive is already mounted.
- `backend/tests/smoke_test_unsloth.py`, run in CI.

### Changed
- Default port is no longer 8000 (reserved for Evidently): `7655` for the Ollama router, `7654` with `CLOUD_BACKEND=unsloth`. `CLOUD_PORT=8000` is refused. Local users must update `cloud.tunnelUrl`.
- `/health` can report `"status": "loading"` while the Unsloth model loads; the `route` event's `backend` can be `unsloth`.

## [0.5.0] — 2026-11-06

### Changed — renamed to Cloud AI
- The extension, the repository and every identifier are now **Cloud AI** / `cloud-ai`. Settings moved from `mendes.*` to `cloud.*` (`cloud.tunnelUrl`, `cloud.token`, `cloud.toolsEnabled`, `cloud.healthPollSeconds`), commands from `mendes.*` to `cloud.*`, the Activity Bar view to `cloud.chatView`, backend environment variables from `MENDES_*` to `CLOUD_*`, and the memory directory from `~/.mendes/memory` to `~/.cloud/memory`. Existing users must re-enter the tunnel URL and token under the new setting names.
- New vector icons: a cloud carrying a three-node neural graph. `media/icon.svg` is the full-colour logo (rendered to the PNG sizes the Marketplace requires) and `media/icon-mono.svg` the monochrome Activity Bar glyph; both share the same cloud geometry.
- Repository moved to https://github.com/cloud-fronts-group/cloud-ai and made public. `publish.yml` publishes to the Marketplace from a tagged release with Trusted Publishing (GitHub OIDC, `vsce publish --oidc`); no Personal Access Token is stored.
- Historical attributions are intentionally untouched: the original author's copyright line in `LICENSE`, and the original Marketplace ID and repository path in the provenance notes below.

## [0.4.0] — 2026-11-06

Recovery release, now maintained at [cloud-fronts-group/cloud-ai](https://github.com/cloud-fronts-group/cloud-ai). The original repository (`mendesalex89/AI_Assistant`) disappeared from GitHub while the Marketplace listing still pointed at it. The complete TypeScript source of 0.3.2 was recovered from the `dist/extension.js.map` source map shipped inside the published VSIX; everything below was rebuilt around it.

### Added
- `backend/server.py` — reference FastAPI implementation of the backend the extension talks to (`GET /health`, `POST /vibe/ask`, `POST /vibe/chat` over SSE), running on Ollama with an optional OpenAI-compatible fallback (OpenRouter / OpenCode Zen). This previously existed only inside the lost Colab notebook.
- `backend/cloud_colab.ipynb` — one-click Colab notebook: installs Ollama, pulls the models, starts the router, opens a Cloudflare quick tunnel and prints `CLOUD_URL` / `CLOUD_TOKEN`.
- `backend/tests/smoke_test.py` — end-to-end protocol test against a mock Ollama; runs in CI.
- Build tooling that was not in the VSIX: `esbuild.config.mjs`, `tsconfig.json`, `.vscodeignore`, VS Code launch/tasks, GitHub Actions CI that type-checks, packages the VSIX and attaches it to tagged releases.

### Changed
- Publisher is now `cloud-fronts-group`; repository, issues and homepage links point at the new home.
- `src/client.ts` — the SSE parser is now spec-compliant: consecutive `data:` lines of one event are joined with `\n`, comment lines are ignored, and `data:` without a trailing space is accepted. The 0.3.2 parser yielded each `data:` line as a separate event, so a newline inside a streamed token (and therefore any Markdown code fence) could not survive the wire. The backend encodes tokens as multiple `data:` lines, which is also what `sse-starlette` does by default.
- Source maps are no longer shipped inside the VSIX (`**/*.map` in `.vscodeignore`).

### Known gaps inherited from 0.3.2
- The README advertises image attachments, and both the client (`imageDataB64`) and backend (`image_data`) carry them, but the chat webview (`media/chat.js`) has no attach control yet, so nothing sends an image today.
- `web_search` scrapes DuckDuckGo's HTML endpoint and will break whenever its markup changes.

## [0.3.2] — 2026-05-12

### Changed
- Marketplace page rewritten to clearly position the extension across its **four full areas**: general coding, data analytics, Data Science (ML), AI Engineering. Includes architecture diagram and a slash-command breakdown by area with attributions to the upstream projects (`ai-analyst-lab/ai-analyst`, `HungHsunHan/claude-code-data-science-team`).

## [0.3.1] — 2026-05-12

### Changed
- Activity Bar icon now matches the extension logo (brain + chip + "M") instead of a generic brain outline. Drawn as a monochromatic SVG so it themes correctly under light, dark, and high-contrast.

## [0.3.0] — 2026-05-12

The "first-class chat" release. Cloud AI now has a dedicated icon in the VS Code Activity Bar (same UX as GitHub Copilot Chat / Claude Code / Cursor) — the chat lives in the sidebar, always one click away.

### Added
- **Activity Bar entry** — a Cloud AI icon appears in the left rail. Click to open the chat sidebar.
- **Persistent sidebar chat** — uses `WebviewViewProvider`; state survives hiding the panel.
- **Auto-reveal on first install** — the chat opens automatically the first time you activate the extension, so you can use it immediately.
- **New command** `Cloud: Focus Chat (Sidebar)` (mapped to `Ctrl+Shift+M` / `Cmd+Shift+M`).
- `Cloud: Open Chat in Editor` continues to work for users who prefer the chat as a tab.

### Changed
- Refactored chat internals into a reusable `ChatRuntime` so both the sidebar view and the editor panel share the same logic (history, tool-loop, slash commands).
- `Ctrl+Shift+M` now focuses the sidebar view instead of opening the editor panel.

## [0.2.0] — 2026-05-12

The "specialist" release. Cloud AI now ships with 14 slash commands that turn the chat into a Data Science and AI Engineering expert.

### Added — 14 slash commands

**Data Science (adapted from `ai-analyst-lab/ai-analyst` and `HungHsunHan/claude-code-data-science-team`)**
- `/explore` — Data inventory, schema profiling, quality assessment
- `/question` — Frame business problems into prioritized analytical questions with testable hypotheses
- `/engineer` — Data cleaning, missing values, outliers, feature engineering
- `/eda` — Exploratory analysis with descriptive stats, correlations and visualizations
- `/model` — ML model selection, hyperparameter tuning, evaluation
- `/explain` — Model explainability via SHAP, LIME, permutation importance, PDPs
- `/chart` — SWD-styled visualizations with action titles and decluttering rules
- `/drill` — Root cause investigation with "peel the onion" methodology
- `/report` — Consolidate analysis into business-ready `final_report.md` + `executable_analysis.ipynb`

**AI Engineering (new)**
- `/rag` — Build production RAG pipelines (chunking, embeddings, hybrid retrieval, reranking, eval)
- `/prompt` — Production-grade prompt engineering (CoT, few-shot, structured outputs, anti-jailbreak)
- `/finetune` — LLM fine-tuning with LoRA/QLoRA (dataset prep, training, eval, deployment)
- `/eval` — LLM evaluation systems (rubrics, LLM-as-judge, Ragas, regression testing)
- `/agent` — AI agent architecture (tool design, planning patterns, error handling, frameworks)

### Added — Built-in commands
- `/skills` or `/help` — list all available slash commands

### How it works
Each slash command loads a Markdown skill file from the extension bundle and injects it as a system message for the current turn. The model becomes specialist for that response without polluting subsequent turns. Skills can be invoked with or without arguments — e.g. `/eda` or `/eda focus on time series`.

## [0.1.0] — 2026-05-12

Initial public release.

### Added
- Multi-turn chat panel (`Ctrl+Shift+M`) with persistent history, voice input, and image attachments.
- Tool calling end-to-end: read/write files, bash, glob, grep, web fetch, web search, todo, memory — each gated by an Accept / Always / Deny modal.
- Bash safety filter: dangerous patterns (`rm -rf /`, `dd`, fork bombs, `mkfs`, `shutdown`) cannot be set to "Always".
- Code actions: Explain Selection (`Ctrl+Alt+E`), Refactor Selection (`Ctrl+Alt+R`), Generate at Cursor.
- Status bar with live `/health` polling and VRAM usage.
- Clear network-error messages when the Cloudflared tunnel is offline.
- Settings: `cloud.tunnelUrl`, `cloud.token` (machine-scoped), `cloud.toolsEnabled`, `cloud.healthPollSeconds`.
