import fs from "node:fs";
import path from "node:path";
import { Session, sessionSchema } from "./schema.js";
import { sessionJsonPath } from "./paths.js";

export function readSession(sessionDir: string): Session {
  const file = sessionJsonPath(sessionDir);
  try {
    return parseSessionFile(file);
  } catch (primaryErr) {
    const bak = `${file}.bak`;
    if (fs.existsSync(bak)) {
      try {
        const recovered = parseSessionFile(bak);
        // Restore the good file so subsequent reads are normal.
        fs.copyFileSync(bak, file);
        process.stderr.write(
          `⚠ rumi: session.json invalid (${(primaryErr as Error).message}); recovered from .bak\n`,
        );
        return recovered;
      } catch {
        // fall through to throw the original error
      }
    }
    throw primaryErr;
  }
}

function parseSessionFile(file: string): Session {
  const raw = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(raw);
  return sessionSchema.parse(parsed);
}

export function writeSession(sessionDir: string, session: Session): void {
  const file = sessionJsonPath(sessionDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const validated = sessionSchema.parse(session);
  // Rotate the previous valid file to .bak so a future malformed write is recoverable.
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, `${file}.bak`);
    } catch {
      // best-effort; don't block the primary write
    }
  }
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
