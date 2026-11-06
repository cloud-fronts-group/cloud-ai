import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export interface Skill {
  command: string;
  title: string;
  description: string;
  source?: string;
  body: string;
}

export interface ParsedSlashCommand {
  skill: Skill;
  args: string;
  originalInput: string;
}

let cache: Map<string, Skill> | undefined;

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body: match[2].trim() };
}

export function loadSkills(extUri: vscode.Uri): Map<string, Skill> {
  if (cache) return cache;
  const skillsDir = path.join(extUri.fsPath, "skills");
  const skills = new Map<string, Skill>();
  if (!fs.existsSync(skillsDir)) return skills;
  for (const file of fs.readdirSync(skillsDir)) {
    if (!file.endsWith(".md")) continue;
    try {
      const raw = fs.readFileSync(path.join(skillsDir, file), "utf8");
      const { meta, body } = parseFrontmatter(raw);
      const command = meta.command ?? path.basename(file, ".md");
      const skill: Skill = {
        command: command.toLowerCase(),
        title: meta.title ?? command,
        description: meta.description ?? "",
        source: meta.source,
        body,
      };
      skills.set(skill.command, skill);
    } catch {
      // Silently skip malformed skill files; missing skills are non-fatal
    }
  }
  cache = skills;
  return skills;
}

const SLASH_RE = /^\/([a-zA-Z][a-zA-Z0-9_-]*)(\s+([\s\S]*))?$/;

export function parseSlashCommand(
  input: string,
  skills: Map<string, Skill>,
): ParsedSlashCommand | undefined {
  const trimmed = input.trimStart();
  const m = trimmed.match(SLASH_RE);
  if (!m) return undefined;
  const cmd = m[1].toLowerCase();
  const skill = skills.get(cmd);
  if (!skill) return undefined;
  return { skill, args: (m[3] ?? "").trim(), originalInput: input };
}

export function listSkills(extUri: vscode.Uri): Skill[] {
  return Array.from(loadSkills(extUri).values()).sort((a, b) =>
    a.command.localeCompare(b.command),
  );
}

export function buildSkillPrompt(parsed: ParsedSlashCommand): {
  systemMessage: string;
  userMessage: string;
} {
  const systemMessage =
    `You are now operating with the following specialized skill enabled. ` +
    `Follow it as your primary guide for this response, while still being able to use any tools/abilities you normally have.\n\n` +
    `=== SKILL: ${parsed.skill.title} ===\n\n${parsed.skill.body}\n\n=== END SKILL ===`;
  const userMessage = parsed.args || `Apply the ${parsed.skill.title} skill.`;
  return { systemMessage, userMessage };
}
