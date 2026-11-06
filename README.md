# Mendes AI — General Coding + Data + Data Science + AI Engineering

A Vibe Coding assistant for VS Code that goes far beyond simple chat. **Mendes AI** turns your editor into a specialist across four full areas:

- **General coding** — explain, refactor, generate, fix code in any language
- **Data analytics** — inventory datasets, frame business questions, drill into root causes, generate decks
- **Data Science** — clean, EDA, build/train/tune ML models, explain them with SHAP/LIME
- **AI Engineering** — production RAG, prompt engineering, LoRA fine-tuning, LLM evaluation, agents

All powered by large open-weight models (Qwen, Gemma, custom GGUFs) running on **Google Colab Pro** GPUs, streamed to your VS Code over a Cloudflared tunnel. **No local GPU required.**

---

## Architecture in one diagram

```
   ┌─────────────────────┐               ┌──────────────────────────┐
   │ VS Code (you)       │               │ Google Colab Pro (L4/A100)│
   │  ┌───────────────┐  │   HTTPS/SSE   │  ┌────────────────────┐  │
   │  │ Mendes AI     │◄─┼───tunnel──────┼─▶│ FastAPI router     │  │
   │  │ sidebar chat  │  │               │  │  + Ollama runtime  │  │
   │  └───────────────┘  │               │  └────────────────────┘  │
   │  - 14 slash skills  │               │    Qwen 27B · Gemma 26B  │
   │  - Tool calling     │               │    (or your own GGUF)    │
   │  - Voice + vision   │               │                          │
   └─────────────────────┘               └──────────────────────────┘
```

The big models live where there's VRAM. Your editor stays light. Tools execute **only on your machine** — the backend just emits intents.

---

## What you can do — the four areas

### 🧑‍💻 General coding (works everywhere)

- **Open Chat**: dedicated sidebar chat with a Mendes AI icon in the Activity Bar (same UX as Copilot Chat / Claude Code). Click and use, no setup ritual.
- **Inline commands**:
  - `Mendes: Explain Selection` (`Ctrl+Alt+E`)
  - `Mendes: Refactor Selection` (`Ctrl+Alt+R`)
  - `Mendes: Generate at Cursor`
- **Tool calling**: the model can read/write files, run bash, grep, glob, fetch the web, etc. Every tool call shows a confirmation modal with **Accept / Always / Deny**. Dangerous bash patterns (`rm -rf /`, `dd`, fork bombs) block the "Always" option as a safety net.
- **Voice input** and **image attachments** for vision-capable models.
- **Persistent chat history** across sessions.

### 📊 Data analytics — `/explore`, `/question`, `/chart`, `/drill`, `/report`

Adapted from [ai-analyst-lab/ai-analyst](https://github.com/ai-analyst-lab/ai-analyst).

| Slash | What it does |
|---|---|
| `/explore` | Inventory a dataset, profile every column, surface quality blockers (nulls, duplicates, outliers), recommend feasible analyses |
| `/question` | Turn a vague business problem into 5-10 testable analytical questions ranked by Impact × Feasibility, with hypotheses for the top 3 |
| `/chart` | Generate Storytelling-with-Data styled charts — action titles, max 2 colors + gray, direct labels, no clutter |
| `/drill` | Root cause investigation with "peel the onion" methodology: confirm → decompose → isolate → repeat — until you find the specific actionable cause |
| `/report` | Consolidate the full analysis into a business-ready `final_report.md` + `executable_analysis.ipynb` |

### 🔬 Data Science (ML) — `/engineer`, `/eda`, `/model`, `/explain`

Adapted from [HungHsunHan/claude-code-data-science-team](https://github.com/HungHsunHan/claude-code-data-science-team).

| Slash | What it does |
|---|---|
| `/engineer` | Data cleaning, missing values, outlier detection (IQR / Z-score), duplicates, feature engineering driven by business value |
| `/eda` | Exploratory analysis — descriptive stats, distributions, correlations (Pearson/Spearman), pattern discovery, hypothesis formulation |
| `/model` | Model selection (linear / trees / boosting / NN), train/val/test splits, hyperparameter tuning, evaluation metrics matched to the business goal |
| `/explain` | Multi-method feature importance: built-in + permutation + **SHAP** + **LIME** + Partial Dependence + interactions + stability checks |

### 🤖 AI Engineering — `/rag`, `/prompt`, `/finetune`, `/eval`, `/agent`

Original to Mendes AI — built from current best practices.

| Slash | What it does |
|---|---|
| `/rag` | Production RAG pipelines: chunking strategies, embedding selection, hybrid retrieval (semantic + BM25), reranking, prompt template, evaluation with Ragas |
| `/prompt` | Production prompt engineering — Chain-of-Thought, few-shot, structured outputs (JSON/XML), function calling schemas, anti-jailbreak, robustness testing |
| `/finetune` | LoRA / QLoRA fine-tuning end-to-end: dataset prep, Unsloth/transformers setup, hyperparams, eval against base, deployment as merged model or adapter, GGUF quantization |
| `/eval` | LLM evaluation systems: reference-based + rubric-based + reference-free, LLM-as-judge done right, Ragas / DeepEval / PromptFoo / LangSmith, CI integration |
| `/agent` | Agent architecture — tool catalog design, ReAct / plan-and-execute / reflexion, memory tiers, error handling, framework picking (LangGraph / LlamaIndex / AutoGen / CrewAI / Smolagents) |

Type `/skills` or `/help` in the chat to list all 14 with descriptions.

---

## Quick start

1. **Install** — download the latest `mendes-ai-*.vsix` from this repository's [Releases](https://github.com/cloud-fronts-group/mendes-ai/releases) (or build it yourself: `npm install && npm run package`), then:
   ```bash
   code --install-extension mendes-ai-0.4.0.vsix
   ```
2. **Spin up the backend** — open [`backend/mendes_colab.ipynb`](backend/mendes_colab.ipynb) in Colab ([one-click](https://colab.research.google.com/github/cloud-fronts-group/mendes-ai/blob/main/backend/mendes_colab.ipynb)), pick a GPU runtime and run all cells. The last cell prints:
   ```
   MENDES_URL=https://xxxxx.trycloudflare.com
   MENDES_TOKEN=...
   ```
3. **Configure VS Code** — open Settings → search "Mendes AI":
   - `mendes.tunnelUrl` → the Cloudflared URL
   - `mendes.token` → the token
4. Click the **Mendes AI icon** in the Activity Bar (the brain + chip in the left rail) — the chat opens in the sidebar.
5. Type `/skills` to see everything you can do.

### Running the backend somewhere other than Colab

The backend is a small FastAPI server over Ollama — see [`backend/README.md`](backend/README.md). Any machine with Ollama works:

```bash
pip install -r backend/requirements.txt
MENDES_TOKEN=change-me python backend/server.py      # then set mendes.tunnelUrl=http://localhost:8000
```

It also documents the wire protocol (`/health`, `/vibe/ask`, `/vibe/chat` over SSE) if you want to point the extension at your own inference stack.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `mendes.tunnelUrl` | `""` | Cloudflared tunnel URL from your Colab session |
| `mendes.token` | `""` | Bearer token sent on every request (machine-scoped, doesn't sync) |
| `mendes.toolsEnabled` | `false` | Allow the model to call tools (file I/O, bash, web) |
| `mendes.healthPollSeconds` | `10` | How often to poll `/health` for the status bar |

## Keybindings

| Action | Shortcut |
|---|---|
| Focus Mendes chat (sidebar) | `Ctrl+Shift+M` (`Cmd+Shift+M`) |
| Explain selection | `Ctrl+Alt+E` |
| Refactor selection | `Ctrl+Alt+R` |

## Privacy & security

- Tools require explicit per-session approval. "Always" decisions live in RAM and reset when VS Code closes.
- Token is machine-scoped — does not sync across devices via Settings Sync.
- All traffic flows through **your own** Cloudflared tunnel and **your own** Colab session. No third-party server in the middle.
- File system access and shell execution happen **only on your machine** — the backend just forwards the model's intent.

## Why this stack?

- **VRAM economics.** Qwen 27B and Gemma 26B don't fit on an 8GB local GPU. They fit on Colab Pro's L4 / A100.
- **Zero per-token cost.** Colab Pro is a flat monthly fee — vs. metered API billing.
- **Privacy.** Prompts never leave a Colab kernel you control.
- **Editor stays local.** All file I/O and shell execution happen on your machine.

## Limitations

- Needs a Colab Pro account (or another GPU host) to run the backend. The extension does not include hosted inference.
- The Cloudflared tunnel URL changes when Colab restarts — you must update the setting (the extension shows a clear error when it's offline).
- AI Engineering skills generate code; they don't run training/RAG/eval pipelines for you. They tell you **what** to write and **why**.

## Development

```bash
npm install            # esbuild + TypeScript + vsce, no runtime dependencies
npm run typecheck      # tsc --noEmit
npm run build          # bundles src/ -> dist/extension.js
npm run package        # produces mendes-ai-<version>.vsix
npm run test:backend   # protocol smoke test against a mock Ollama (needs backend/requirements.txt)
```

Press **F5** in VS Code to launch an Extension Development Host with the extension loaded.

## Issues & contributing

Bug reports, feature requests, and PRs are welcome at [github.com/cloud-fronts-group/mendes-ai](https://github.com/cloud-fronts-group/mendes-ai/issues).

## Provenance

Mendes AI was written by Alex Mendes and published to the VS Code Marketplace as `mendesalex89.mendes-ai` (v0.1.0–0.3.2, May 2026). The source repository the listing links to, `mendesalex89/AI_Assistant`, no longer exists on GitHub, and none of the author's other public repositories contain it.

This repository restores the project:

- **Extension source** (`src/`, `media/`, `skills/`) is the original 0.3.2 TypeScript, recovered verbatim from the `dist/extension.js.map` source map that shipped inside the published VSIX. The only functional change is a spec-compliant SSE parser in `src/client.ts` (see the changelog).
- **Backend** (`backend/`) is a reconstruction: the original Colab notebook was lost with the repo, so `server.py` re-implements the protocol the client speaks, on Ollama, plus a new Colab notebook.
- **Build tooling** (`esbuild.config.mjs`, `tsconfig.json`, `.vscodeignore`, CI) was not in the VSIX and was written fresh.

Everything is MIT, as the original was.

## Acknowledgments

Skills are adapted from these excellent open-source projects:
- **Data analytics skills** from [ai-analyst-lab/ai-analyst](https://github.com/ai-analyst-lab/ai-analyst) (Apache 2.0)
- **Data Science skills** from [HungHsunHan/claude-code-data-science-team](https://github.com/HungHsunHan/claude-code-data-science-team)

## License

MIT — see [LICENSE](LICENSE). Original work © 2026 Alex Mendes; source recovery, backend and tooling © 2026 Cloud Fronts Group.
