import * as vscode from "vscode";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { exec } from "child_process";
import { promisify } from "util";

const pexec = promisify(exec);

export interface ToolArgs {
  [key: string]: unknown;
}

const MAX_LINES_PER_READ = 5000;

function workspaceCwd(): string {
  const ws = vscode.workspace.workspaceFolders?.[0];
  return ws ? ws.uri.fsPath : process.cwd();
}

function resolvePath(p: string): string {
  if (p.startsWith("~")) p = path.join(os.homedir(), p.slice(1));
  if (path.isAbsolute(p)) return p;
  return path.resolve(workspaceCwd(), p);
}

function expectString(args: ToolArgs, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`arg '${key}' must be a string`);
  return v;
}

function asString(args: ToolArgs, key: string, def = ""): string {
  const v = args[key];
  return typeof v === "string" ? v : def;
}

function asNumber(args: ToolArgs, key: string, def: number): number {
  const v = args[key];
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)))
    return Number(v);
  return def;
}

// ─── read_file ────────────────────────────────────────────────────────────
export async function read_file(args: ToolArgs): Promise<string> {
  const p = resolvePath(expectString(args, "path"));
  let stat;
  try {
    stat = await fs.stat(p);
  } catch {
    return `ERROR: file does not exist: ${p}`;
  }
  if (!stat.isFile()) return `ERROR: path is not a file: ${p}`;

  const text = await fs.readFile(p, "utf8");
  const lines = text.split("\n");
  const ls = args.line_start as number | undefined;
  const le = args.line_end as number | undefined;

  if (ls || le) {
    const s = Math.max(1, ls ?? 1);
    const e = Math.min(lines.length, le ?? lines.length);
    const sliced = lines.slice(s - 1, e);
    const body = sliced
      .map((l, i) => `${String(i + s).padStart(5, " ")}\t${l}`)
      .join("\n");
    return `# ${p} (lines ${s}-${e} of ${lines.length})\n${body}`;
  }

  if (lines.length > MAX_LINES_PER_READ) {
    const body = lines
      .slice(0, MAX_LINES_PER_READ)
      .map((l, i) => `${String(i + 1).padStart(5, " ")}\t${l}`)
      .join("\n");
    return `# ${p} (${lines.length} lines — TRUNCATED at ${MAX_LINES_PER_READ})\n${body}`;
  }

  const body = lines
    .map((l, i) => `${String(i + 1).padStart(5, " ")}\t${l}`)
    .join("\n");
  return `# ${p} (${lines.length} lines)\n${body}`;
}

// ─── write_file ───────────────────────────────────────────────────────────
export async function write_file(args: ToolArgs): Promise<string> {
  const p = resolvePath(expectString(args, "path"));
  const content = asString(args, "content", "");
  await fs.mkdir(path.dirname(p), { recursive: true });
  let existed = true;
  try {
    await fs.access(p);
  } catch {
    existed = false;
  }
  await fs.writeFile(p, content, "utf8");
  const verb = existed ? "updated" : "created";
  return `OK: file ${verb} (${content.length} chars) — ${p}`;
}

// ─── edit_file ────────────────────────────────────────────────────────────
export async function edit_file(args: ToolArgs): Promise<string> {
  const p = resolvePath(expectString(args, "path"));
  const oldStr = expectString(args, "old_string");
  const newStr = expectString(args, "new_string");

  let text: string;
  try {
    text = await fs.readFile(p, "utf8");
  } catch {
    return `ERROR: file does not exist: ${p}`;
  }

  const occ = text.split(oldStr).length - 1;
  if (occ === 0) {
    return `ERROR: old_string not found in ${p}. Check the exact indentation and whitespace.`;
  }
  if (occ > 1) {
    return `ERROR: old_string found ${occ} times in ${p}. Include more context before/after to make it unique.`;
  }

  const next = text.replace(oldStr, newStr);
  await fs.writeFile(p, next, "utf8");
  return `OK: 1 replacement applied in ${p}`;
}

// ─── bash ─────────────────────────────────────────────────────────────────
export async function bash(args: ToolArgs): Promise<string> {
  const cmd = expectString(args, "command");
  const timeoutS = Math.min(asNumber(args, "timeout_s", 30), 300);
  try {
    const { stdout, stderr } = await pexec(cmd, {
      cwd: workspaceCwd(),
      timeout: timeoutS * 1000,
      maxBuffer: 50 * 1024 * 1024,
      shell: "/bin/bash",
    });
    const parts: string[] = [];
    if (stdout) parts.push(`STDOUT:\n${stdout}`);
    if (stderr) parts.push(`STDERR:\n${stderr}`);
    parts.push(`EXIT CODE: 0`);
    let out = parts.join("\n");
    if (out.length > 50_000) out = out.slice(0, 50_000) + "\n[...output truncated...]";
    return out;
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    if (err.killed) return `ERROR: timeout after ${timeoutS}s`;
    const parts: string[] = [];
    if (err.stdout) parts.push(`STDOUT:\n${err.stdout}`);
    if (err.stderr) parts.push(`STDERR:\n${err.stderr}`);
    parts.push(`EXIT CODE: ${err.code ?? "?"}`);
    let out = parts.join("\n");
    if (out.length > 50_000) out = out.slice(0, 50_000) + "\n[...output truncated...]";
    return out;
  }
}

// ─── glob ─────────────────────────────────────────────────────────────────
export async function glob_files(args: ToolArgs): Promise<string> {
  const pattern = expectString(args, "pattern");
  const cwd = args.cwd ? resolvePath(asString(args, "cwd")) : workspaceCwd();
  try {
    const { stdout } = await pexec(
      `bash -lc 'shopt -s globstar nullglob; cd ${JSON.stringify(cwd)} && for f in ${pattern}; do echo "$f"; done'`,
      { maxBuffer: 5 * 1024 * 1024 },
    );
    const matches = stdout.trim().split("\n").filter(Boolean).sort();
    if (matches.length === 0) return `no files match ${JSON.stringify(pattern)} in ${cwd}`;
    if (matches.length > 200)
      return `${matches.length} matches (showing 200):\n${matches.slice(0, 200).join("\n")}`;
    return matches.join("\n");
  } catch (e) {
    return `ERROR: ${(e as Error).message}`;
  }
}

// ─── grep ─────────────────────────────────────────────────────────────────
export async function grep_files(args: ToolArgs): Promise<string> {
  const pattern = expectString(args, "pattern");
  const target = resolvePath(expectString(args, "path"));
  const globFilter = asString(args, "glob");
  const includeFlag = globFilter ? `--include=${JSON.stringify(globFilter)}` : "";
  try {
    const { stdout } = await pexec(
      `grep -rEn ${includeFlag} ${JSON.stringify(pattern)} ${JSON.stringify(target)} 2>/dev/null | head -500`,
      { maxBuffer: 5 * 1024 * 1024 },
    );
    if (!stdout.trim()) return `no matches for ${JSON.stringify(pattern)} in ${target}`;
    return stdout;
  } catch (e) {
    const err = e as { code?: number; stdout?: string };
    if (err.code === 1) return `no matches for ${JSON.stringify(pattern)} in ${target}`;
    if (err.stdout) return err.stdout;
    return `ERROR: ${(e as Error).message}`;
  }
}

// ─── web_fetch ────────────────────────────────────────────────────────────
export async function web_fetch(args: ToolArgs): Promise<string> {
  const url = expectString(args, "url");
  const maxChars = asNumber(args, "max_chars", 8000);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Cloud-AI/0.1 (+vscode)" },
      redirect: "follow",
    });
    if (!r.ok) return `ERROR fetching ${url}: HTTP ${r.status}`;
    const ct = r.headers.get("content-type") ?? "";
    let text = await r.text();
    if (ct.includes("html")) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim();
    }
    if (text.length > maxChars) text = text.slice(0, maxChars) + `\n[...truncated at ${maxChars} chars]`;
    return `# ${url}\n${text}`;
  } catch (e) {
    return `ERROR fetching ${url}: ${(e as Error).message}`;
  }
}

// ─── web_search ───────────────────────────────────────────────────────────
interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

const strip = (h: string): string => h.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

/** DuckDuckGo's HTML endpoint. No key needed, but it is scraped: the markup can change. */
export function parseDuckDuckGo(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  // Anchor and snippet are matched separately so a change to one does not lose the other.
  const anchors = [...html.matchAll(/<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>[\s\S]*?<\/a>/g)];
  const snippets = [...html.matchAll(/class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/g)];
  anchors.forEach((m, i) => {
    const href = /href="([^"]+)"/.exec(m[0])?.[1];
    if (!href) return;
    let url = href.replace(/&amp;/g, "&");
    try {
      const u = new URL(url.startsWith("//") ? `https:${url}` : url, "https://duckduckgo.com");
      url = u.searchParams.get("uddg") ?? u.toString();
    } catch {
      return;
    }
    hits.push({ title: strip(m[0]), url, snippet: strip(snippets[i]?.[1] ?? "") });
  });
  return hits;
}

async function searchDuckDuckGo(query: string): Promise<SearchHit[]> {
  const r = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (Cloud-AI search)",
    },
    body: `q=${encodeURIComponent(query)}`,
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  const hits = parseDuckDuckGo(html);
  if (hits.length === 0 && !/no results|No\s+results/i.test(html)) {
    // A page that is neither results nor "no results" means a block page or changed markup.
    throw new Error(
      "DuckDuckGo returned a page this tool could not read (rate limit, bot check or changed markup). " +
        "Set cloud.search.provider to 'brave' or 'searxng' for an API-backed search.",
    );
  }
  return hits;
}

async function searchBrave(query: string, n: number, key: string): Promise<SearchHit[]> {
  if (!key) throw new Error("cloud.search.apiKey is empty (Brave Search API key)");
  const r = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`,
    { headers: { Accept: "application/json", "X-Subscription-Token": key } },
  );
  if (!r.ok) throw new Error(`Brave HTTP ${r.status}`);
  const j = (await r.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
  return (j.web?.results ?? []).map((x) => ({
    title: strip(x.title ?? ""),
    url: x.url ?? "",
    snippet: strip(x.description ?? ""),
  }));
}

async function searchSearxng(query: string, base: string): Promise<SearchHit[]> {
  if (!base) throw new Error("cloud.search.url is empty (base URL of a SearXNG instance with the JSON format enabled)");
  const r = await fetch(`${base.replace(/\/+$/, "")}/search?q=${encodeURIComponent(query)}&format=json`, {
    headers: { Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`SearXNG HTTP ${r.status}`);
  const j = (await r.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (j.results ?? []).map((x) => ({ title: x.title ?? "", url: x.url ?? "", snippet: x.content ?? "" }));
}

export async function web_search(args: ToolArgs): Promise<string> {
  const query = expectString(args, "query");
  const maxResults = Math.max(1, Math.min(asNumber(args, "max_results", 8), 20));
  const cfg = vscode.workspace.getConfiguration("cloud.search");
  const provider = cfg.get<string>("provider") ?? "duckduckgo";
  try {
    const hits =
      provider === "brave"
        ? await searchBrave(query, maxResults, cfg.get<string>("apiKey") ?? "")
        : provider === "searxng"
          ? await searchSearxng(query, cfg.get<string>("url") ?? "")
          : await searchDuckDuckGo(query);
    if (hits.length === 0) return `no results for: ${query}`;
    return hits
      .slice(0, maxResults)
      .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`)
      .join("\n\n");
  } catch (e) {
    return `ERROR in web_search (${provider}): ${(e as Error).message}`;
  }
}

// ─── todo_write ───────────────────────────────────────────────────────────
let _todos: { content: string; activeForm: string; status: string }[] = [];

export async function todo_write(args: ToolArgs): Promise<string> {
  const items = (args.todos ?? []) as { content?: string; activeForm?: string; status?: string }[];
  const valid = new Set(["pending", "in_progress", "completed"]);
  const cleaned: typeof _todos = [];
  for (const it of items) {
    if (!valid.has(it.status ?? "")) return `ERROR: invalid status ${JSON.stringify(it.status)}`;
    cleaned.push({
      content: it.content ?? "",
      activeForm: it.activeForm ?? "",
      status: it.status ?? "pending",
    });
  }
  _todos = cleaned;
  const done = _todos.filter((t) => t.status === "completed").length;
  return `OK: ${_todos.length} todos (${done} completed)`;
}

export function getTodos() {
  return [..._todos];
}

// ─── memory ───────────────────────────────────────────────────────────────
function memoryDir(): string {
  return path.join(os.homedir(), ".cloud", "memory");
}

export async function memory_write(args: ToolArgs): Promise<string> {
  const name = expectString(args, "name").trim().replace(/\//g, "_").replace(/\.\./g, "");
  const content = asString(args, "content");
  const dir = memoryDir();
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${name}.md`);
  await fs.writeFile(p, content, "utf8");
  return `OK: memory '${name}' saved to ${p}`;
}

export async function memory_read(args: ToolArgs): Promise<string> {
  const name = asString(args, "name").trim();
  const dir = memoryDir();
  if (!name) {
    try {
      const items = (await fs.readdir(dir)).filter((f) => f.endsWith(".md")).sort();
      if (items.length === 0) return "(no memories saved yet)";
      return "memories:\n" + items.map((f) => `  • ${f.replace(/\.md$/, "")}`).join("\n");
    } catch {
      return "(no memories saved yet)";
    }
  }
  const p = path.join(dir, `${name.replace(/\//g, "_")}.md`);
  try {
    const text = await fs.readFile(p, "utf8");
    return `# memory: ${name}\n${text}`;
  } catch {
    return `ERROR: memory '${name}' does not exist`;
  }
}

// ─── Dispatch and categories ─────────────────────────────────────────────
export const DISPATCH: Record<string, (args: ToolArgs) => Promise<string>> = {
  read_file,
  write_file,
  edit_file,
  bash,
  glob: glob_files,
  grep: grep_files,
  web_fetch,
  web_search,
  todo_write,
  memory_write,
  memory_read,
};

export const SAFE_TOOLS = new Set([
  "read_file",
  "glob",
  "grep",
  "web_fetch",
  "web_search",
  "todo_write",
  "memory_read",
]);

export const DANGEROUS_TOOLS = new Set([
  "write_file",
  "edit_file",
  "bash",
  "memory_write",
]);

export function isSafe(name: string): boolean {
  return SAFE_TOOLS.has(name);
}

const DANGEROUS_BASH_PATTERNS: RegExp[] = [
  /\brm\s+-rf?\s+\//,
  /\bdd\s+if=/,
  /:\(\)\s*\{/,
  /\bmkfs\./,
  /\bshutdown\b/,
  /\breboot\b/,
  /\b>\s*\/dev\/sd/,
];

export function bashDangerLevel(command: string): "safe" | "caution" | "dangerous" {
  for (const p of DANGEROUS_BASH_PATTERNS) {
    if (p.test(command)) return "dangerous";
  }
  if (/\bsudo\s|\brm\s|git push --force|kill -9/.test(command)) return "caution";
  return "safe";
}

export async function execute(name: string, args: ToolArgs): Promise<string> {
  const fn = DISPATCH[name];
  if (!fn) return `ERROR: unknown tool: ${name}`;
  try {
    return await fn(args);
  } catch (e) {
    return `ERROR running ${name}: ${(e as Error).message}`;
  }
}
