import fs from "node:fs";
import path from "node:path";
import { logsPath } from "./paths.js";

export type Persona = "system" | "pm" | "fee" | "qa" | "orchestrator";

// Logs live in two files side-by-side:
//   logs.txt   — human-readable one-line-per-event (kept for `tail -f`)
//   logs.jsonl — structured stream (kept for dashboard + tooling)
// Every `appendLog` writes to both. Structured-only data can go via
// `appendLogEvent`, which still emits a human-legible line to logs.txt.

export interface LogEvent {
  ts: string;
  persona: string;
  event?: string;   // short machine-friendly tag, e.g. "add-use-case"
  message: string;  // human-legible one-liner
  fields?: Record<string, unknown>;
}

export function appendLog(sessionDir: string, persona: Persona | string, message: string): void {
  writeEvent(sessionDir, {
    ts: new Date().toISOString(),
    persona: persona.toString(),
    message: flatten(message),
  });
}

export function appendLogEvent(
  sessionDir: string,
  persona: Persona | string,
  event: string,
  message: string,
  fields?: Record<string, unknown>,
): void {
  writeEvent(sessionDir, {
    ts: new Date().toISOString(),
    persona: persona.toString(),
    event,
    message: flatten(message),
    fields,
  });
}

function writeEvent(sessionDir: string, ev: LogEvent): void {
  const txt = logsPath(sessionDir);
  fs.mkdirSync(path.dirname(txt), { recursive: true });
  const humanLine = `${ev.ts} | ${ev.persona.toUpperCase()} | ${ev.message}\n`;
  fs.appendFileSync(txt, humanLine, "utf8");
  const jsonlFile = txt.replace(/\.txt$/, ".jsonl");
  fs.appendFileSync(jsonlFile, JSON.stringify(ev) + "\n", "utf8");
}

function flatten(msg: string): string {
  return msg.replace(/\r?\n/g, " ");
}
