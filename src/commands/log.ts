import fs from "node:fs";
import path from "node:path";
import { appendLog } from "../lib/logger.js";
import { projectRumiRoot } from "../lib/paths.js";

export interface LogOptions {
  sessionDir?: string;
  projectRoot?: string;
}

export function runLog(persona: string, message: string, opts: LogOptions = {}): void {
  const dir = opts.sessionDir ?? resolveActiveSession(opts.projectRoot ?? process.cwd());
  if (!dir) throw new Error("No active QA session found. Pass --session or run `rumi init` first.");
  appendLog(dir, persona, message);
}

function resolveActiveSession(projectRoot: string): string | null {
  const root = projectRumiRoot(projectRoot);
  if (!fs.existsSync(root)) return null;

  let newest: { dir: string; mtime: number } | null = null;
  for (const slug of fs.readdirSync(root)) {
    const dir = path.join(root, slug);
    if (!fs.statSync(dir).isDirectory()) continue;
    const sj = path.join(dir, "session.json");
    if (!fs.existsSync(sj)) continue;
    const m = fs.statSync(sj).mtimeMs;
    if (!newest || m > newest.mtime) newest = { dir, mtime: m };
  }
  return newest?.dir ?? null;
}
