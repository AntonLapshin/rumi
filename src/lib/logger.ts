import fs from "node:fs";
import path from "node:path";
import { logsPath } from "./paths.js";

export type Persona = "system" | "pm" | "fee" | "qa" | "orchestrator";

export function appendLog(sessionDir: string, persona: Persona | string, message: string): void {
  const ts = new Date().toISOString();
  const line = `${ts} | ${persona.toString().toUpperCase()} | ${message.replace(/\r?\n/g, " ")}\n`;
  const file = logsPath(sessionDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line, "utf8");
}
