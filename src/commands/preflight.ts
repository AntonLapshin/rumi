import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { readSession } from "../lib/session-io.js";
import { appendLog } from "../lib/logger.js";
import { Action, isTypedAction } from "../lib/schema.js";
import { projectRumiRoot } from "../lib/paths.js";

// Pre-QA / pre-exec snapshot. Opens the URL with playwright-cli, captures
// one snapshot, and reports whether every typed action's selector has a
// plausible match in the snapshot text. Advisory only — misses are
// surfaced but don't block execution (the snapshot format can vary and
// false negatives would be worse than missing a rare true positive).

export interface PreflightOptions {
  useCaseId?: string;
  sessionDir?: string;
  projectRoot?: string;
  timeoutMs?: number;
}

export interface PreflightResult {
  reachable: boolean;
  misses: { action: Action; hint: string }[];
  snapshotBytes: number;
  error?: string;
}

export async function runPreflight(opts: PreflightOptions): Promise<PreflightResult> {
  const dir = resolveSessionDir(opts);
  const session = readSession(dir);

  const actions: Action[] = opts.useCaseId
    ? session.useCases.find((u) => u.id === opts.useCaseId)?.actions ?? []
    : [];

  const timeout = opts.timeoutMs ?? 30_000;
  const result: PreflightResult = { reachable: false, misses: [], snapshotBytes: 0 };

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

    for (const a of actions) {
      if (!isTypedAction(a)) continue;
      const hint = checkAction(a, snapshot);
      if (hint) result.misses.push({ action: a, hint });
    }
  } catch (e) {
    result.error = (e as Error).message;
  } finally {
    await playwright(["session-stop-all"], { timeout: 5000 }).catch(() => {});
  }

  finish(result);
  appendLog(
    dir,
    "orchestrator",
    `preflight ${opts.useCaseId ?? "(url)"}: reachable=${result.reachable}, misses=${result.misses.length}, snapshotBytes=${result.snapshotBytes}`,
  );
  return result;
}

function finish(result: PreflightResult): void {
  // JSON on stdout; concise so callers (orchestrator, humans) can parse.
  const summary = {
    reachable: result.reachable,
    snapshotBytes: result.snapshotBytes,
    misses: result.misses.map((m) => ({
      action: m.action,
      hint: m.hint,
    })),
    error: result.error,
  };
  console.log(JSON.stringify(summary, null, 2));
}

function checkAction(a: Exclude<Action, string>, snapshot: string): string | null {
  // Loose substring check — snapshot format varies by playwright-cli version.
  // A miss here is a hint, not a hard failure.
  switch (a.type) {
    case "goto":
    case "wait_for_url":
      return null; // not a selector
    case "click":
    case "expect_role": {
      if (!snapshot.includes(a.name)) {
        return `snapshot has no match for "${a.name}" (${a.role})`;
      }
      return null;
    }
    case "fill": {
      if (!snapshot.includes(a.label)) {
        return `snapshot has no match for label "${a.label}"`;
      }
      return null;
    }
    case "press":
      return null;
    case "expect_text": {
      if (!snapshot.includes(a.text)) {
        return `snapshot has no match for text "${a.text}"`;
      }
      return null;
    }
  }
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
