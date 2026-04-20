import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { readSession } from "../lib/session-io.js";
import { appendLog } from "../lib/logger.js";
import { projectRumiRoot } from "../lib/paths.js";

// Pre-QA reachability probe. Opens the URL with playwright-cli and captures
// one snapshot. Its only signal is "is this URL reachable?" — actual locator
// discovery is QA's job against the real page.

export interface PreflightOptions {
  sessionDir?: string;
  projectRoot?: string;
  timeoutMs?: number;
}

export interface PreflightResult {
  reachable: boolean;
  snapshotBytes: number;
  error?: string;
}

export async function runPreflight(opts: PreflightOptions): Promise<PreflightResult> {
  const dir = resolveSessionDir(opts);
  const session = readSession(dir);

  const timeout = opts.timeoutMs ?? 30_000;
  const result: PreflightResult = { reachable: false, snapshotBytes: 0 };

  try {
    await playwright(["session-stop-all"], { timeout }).catch(() => {});
    const open = await playwright(["open", session.url], { timeout });
    if (open.exitCode !== 0) {
      result.error = `playwright-cli open exited ${open.exitCode}`;
      appendLog(dir, "orchestrator", `preflight: URL unreachable (${result.error})`);
      finish(result);
      return result;
    }
    result.reachable = true;

    const snap = await playwright(["snapshot"], { timeout });
    const snapshot = `${snap.stdout ?? ""}\n${snap.stderr ?? ""}`;
    result.snapshotBytes = snapshot.length;
  } catch (e) {
    result.error = (e as Error).message;
  } finally {
    await playwright(["session-stop-all"], { timeout: 5000 }).catch(() => {});
  }

  finish(result);
  appendLog(
    dir,
    "orchestrator",
    `preflight: reachable=${result.reachable}, snapshotBytes=${result.snapshotBytes}`,
  );
  return result;
}

function finish(result: PreflightResult): void {
  console.log(JSON.stringify(result, null, 2));
}

function playwright(args: string[], opts: { timeout: number }) {
  return execa("playwright-cli", args, {
    reject: false,
    timeout: opts.timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function resolveSessionDir(opts: PreflightOptions): string {
  if (opts.sessionDir) return opts.sessionDir;
  const envDir = process.env.RUMI_SESSION;
  if (envDir) return envDir;
  const root = projectRumiRoot(opts.projectRoot ?? process.cwd());
  if (!fs.existsSync(root)) throw new Error("no rumi/ directory");
  let newest: { dir: string; mtime: number } | null = null;
  for (const slug of fs.readdirSync(root)) {
    const d = path.join(root, slug);
    if (!fs.statSync(d).isDirectory()) continue;
    const sj = path.join(d, "session.json");
    if (!fs.existsSync(sj)) continue;
    const m = fs.statSync(sj).mtimeMs;
    if (!newest || m > newest.mtime) newest = { dir: d, mtime: m };
  }
  if (!newest) throw new Error("no session.json under rumi/");
  return newest.dir;
}
