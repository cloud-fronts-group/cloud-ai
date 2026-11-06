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
  if (typeof v !== "string") throw new Error(`arg '${key}' deve ser string`);
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
    return `ERRO: arquivo não existe: ${p}`;
  }
  if (!stat.isFile()) return `ERRO: caminho não é arquivo: ${p}`;

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
    return `# ${p} (linhas ${s}-${e} de ${lines.length})\n${body}`;
  }

  if (lines.length > MAX_LINES_PER_READ) {
    const body = lines
      .slice(0, MAX_LINES_PER_READ)
      .map((l, i) => `${String(i + 1).padStart(5, " ")}\t${l}`)
      .join("\n");
    return `# ${p} (${lines.length} linhas — TRUNCADO em ${MAX_LINES_PER_READ})\n${body}`;
  }

  const body = lines
    .map((l, i) => `${String(i + 1).padStart(5, " ")}\t${l}`)
    .join("\n");
  return `# ${p} (${lines.length} linhas)\n${body}`;
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
  const verb = existed ? "atualizado" : "criado";
  return `OK: arquivo ${verb} (${content.length} chars) — ${p}`;
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
    return `ERRO: arquivo não existe: ${p}`;
  }

  const occ = text.split(oldStr).length - 1;
  if (occ === 0) {
    return `ERRO: old_string não encontrada em ${p}. Verifique indentação/whitespace exato.`;
  }
  if (occ > 1) {
    return `ERRO: old_string encontrada ${occ} vezes em ${p}. Inclua mais contexto antes/depois para tornar única.`;
  }

  const next = text.replace(oldStr, newStr);
  await fs.writeFile(p, next, "utf8");
  return `OK: 1 substituição aplicada em ${p}`;
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
    if (err.killed) return `ERRO: timeout após ${timeoutS}s`;
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
    if (matches.length === 0) return `nenhum arquivo encontrado para padrão ${JSON.stringify(pattern)} em ${cwd}`;
    if (matches.length > 200)
      return `${matches.length} matches (mostrando 200):\n${matches.slice(0, 200).join("\n")}`;
    return matches.join("\n");
  } catch (e) {
    return `ERRO: ${(e as Error).message}`;
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
    if (!stdout.trim()) return `sem matches para ${JSON.stringify(pattern)} em ${target}`;
    return stdout;
  } catch (e) {
    const err = e as { code?: number; stdout?: string };
    if (err.code === 1) return `sem matches para ${JSON.stringify(pattern)} em ${target}`;
    if (err.stdout) return err.stdout;
    return `ERRO: ${(e as Error).message}`;
  }
}

// ─── web_fetch ────────────────────────────────────────────────────────────
export async function web_fetch(args: ToolArgs): Promise<string> {
  const url = expectString(args, "url");
  const maxChars = asNumber(args, "max_chars", 8000);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mendes-AI/0.1 (+vscode)" },
      redirect: "follow",
    });
    if (!r.ok) return `ERRO ao buscar ${url}: HTTP ${r.status}`;
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
    return `ERRO ao buscar ${url}: ${(e as Error).message}`;
  }
}

// ─── web_search ───────────────────────────────────────────────────────────
export async function web_search(args: ToolArgs): Promise<string> {
  const query = expectString(args, "query");
  const maxResults = Math.min(asNumber(args, "max_results", 8), 20);
  try {
    const r = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Mendes-AI search)",
      },
      body: `q=${encodeURIComponent(query)}`,
      redirect: "follow",
    });
    if (!r.ok) return `ERRO na busca: HTTP ${r.status}`;
    const html = await r.text();
    const re =
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const out: string[] = [];
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(html)) !== null) {
      if (i++ >= maxResults) break;
      let link = m[1];
      const u = new URL(link.startsWith("//") ? `https:${link}` : link, "https://duckduckgo.com");
      const real = u.searchParams.get("uddg");
      if (real) link = decodeURIComponent(real);
      const title = m[2].replace(/<[^>]+>/g, "").trim();
      const snippet = m[3].replace(/<[^>]+>/g, "").trim();
      out.push(`${i}. ${title}\n   ${link}\n   ${snippet}`);
    }
    if (out.length === 0) return `sem resultados para: ${query}`;
    return out.join("\n\n");
  } catch (e) {
    return `ERRO na busca: ${(e as Error).message}`;
  }
}

// ─── todo_write ───────────────────────────────────────────────────────────
let _todos: { content: string; activeForm: string; status: string }[] = [];

export async function todo_write(args: ToolArgs): Promise<string> {
  const items = (args.todos ?? []) as { content?: string; activeForm?: string; status?: string }[];
  const valid = new Set(["pending", "in_progress", "completed"]);
  const cleaned: typeof _todos = [];
  for (const it of items) {
    if (!valid.has(it.status ?? "")) return `ERRO: status inválido ${JSON.stringify(it.status)}`;
    cleaned.push({
      content: it.content ?? "",
      activeForm: it.activeForm ?? "",
      status: it.status ?? "pending",
    });
  }
  _todos = cleaned;
  const done = _todos.filter((t) => t.status === "completed").length;
  return `OK: ${_todos.length} todos (${done} concluídos)`;
}

export function getTodos() {
  return [..._todos];
}

// ─── memory ───────────────────────────────────────────────────────────────
function memoryDir(): string {
  return path.join(os.homedir(), ".mendes", "memory");
}

export async function memory_write(args: ToolArgs): Promise<string> {
  const name = expectString(args, "name").trim().replace(/\//g, "_").replace(/\.\./g, "");
  const content = asString(args, "content");
  const dir = memoryDir();
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${name}.md`);
  await fs.writeFile(p, content, "utf8");
  return `OK: memória '${name}' salva em ${p}`;
}

export async function memory_read(args: ToolArgs): Promise<string> {
  const name = asString(args, "name").trim();
  const dir = memoryDir();
  if (!name) {
    try {
      const items = (await fs.readdir(dir)).filter((f) => f.endsWith(".md")).sort();
      if (items.length === 0) return "(nenhuma memória salva ainda)";
      return "memórias:\n" + items.map((f) => `  • ${f.replace(/\.md$/, "")}`).join("\n");
    } catch {
      return "(nenhuma memória salva ainda)";
    }
  }
  const p = path.join(dir, `${name.replace(/\//g, "_")}.md`);
  try {
    const text = await fs.readFile(p, "utf8");
    return `# memória: ${name}\n${text}`;
  } catch {
    return `ERRO: memória '${name}' não existe`;
  }
}

// ─── Dispatch & categorização ─────────────────────────────────────────────
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
  if (!fn) return `ERRO: ferramenta desconhecida: ${name}`;
  try {
    return await fn(args);
  } catch (e) {
    return `ERRO ao executar ${name}: ${(e as Error).message}`;
  }
}
