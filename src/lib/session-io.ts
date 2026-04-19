import fs from "node:fs";
import path from "node:path";
import { Session, sessionSchema } from "./schema.js";
import { sessionJsonPath } from "./paths.js";

export function readSession(sessionDir: string): Session {
  const raw = fs.readFileSync(sessionJsonPath(sessionDir), "utf8");
  const parsed = JSON.parse(raw);
  return sessionSchema.parse(parsed);
}

export function writeSession(sessionDir: string, session: Session): void {
  const file = sessionJsonPath(sessionDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const validated = sessionSchema.parse(session);
  // Atomic write: tmp + rename keeps readers from ever seeing a half-written file
  // and survives a crash mid-write (the original stays intact until the rename).
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(validated, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

export function tryReadSession(sessionDir: string): Session | null {
  const file = sessionJsonPath(sessionDir);
  if (!fs.existsSync(file)) return null;
  try {
    return readSession(sessionDir);
  } catch {
    return null;
  }
}
