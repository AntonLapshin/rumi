import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { readSession, writeSession } from "../lib/session-io.js";
import { normalize } from "../lib/normalize.js";
import { appendLog } from "../lib/logger.js";
import { Action, isTypedAction } from "../lib/schema.js";
import { e2eDir, projectRumiRoot } from "../lib/paths.js";
import { readConfig } from "../lib/config.js";

// Deterministic QA runtime (Theme 3 + 5). When a use case's actions are all
// typed, the e2e spec is already generated — this command just executes it
// via `npx playwright test` and records the result. No LLM needed.

export interface ExecOptions {
  useCaseId: string;
  sessionDir?: string;
  projectRoot?: string;
}

export interface ExecResult {
  ranSpec: boolean;
  status: "passed" | "failed" | "blocked" | "skipped";
  reason?: string;
  stdout?: string;
}

export async function runExec(opts: ExecOptions): Promise<ExecResult> {
  const dir = resolveSessionDir(opts);
  const projectRoot = opts.projectRoot ?? findProjectRoot(dir);
  const session = readSession(dir);
  const uc = session.useCases.find((u) => u.id === opts.useCaseId);
  if (!uc) throw new Error(`use case not found: ${opts.useCaseId}`);

  const actions: Action[] = uc.actions ?? [];
  if (actions.length === 0) {
    const result: ExecResult = {
      ranSpec: false,
      status: "skipped",
      reason: "no actions",
    };
    console.log(JSON.stringify(result));
    return result;
  }

  // If any action is still free prose, we can't run the spec deterministically.
  // The legacy QA flow (LLM writes the spec body + runs playwright-cli) still
  // applies — surface "skipped" so the caller knows to fall back.
  const allTyped = actions.every(isTypedAction);
  if (!allTyped) {
    const result: ExecResult = {
      ranSpec: false,
      status: "skipped",
      reason: "actions include free-text; needs QA persona",
    };
    console.log(JSON.stringify(result));
    return result;
  }

  const specFile = path.join(e2eDir(dir), `${uc.id}.test.ts`);
  if (!fs.existsSync(specFile)) {
    const result: ExecResult = {
      ranSpec: false,
      status: "blocked",
      reason: `spec file missing: ${path.relative(projectRoot, specFile)}`,
    };
    recordAndLog(dir, uc.id, result);
    console.log(JSON.stringify(result));
    return result;
  }

  const config = readConfig(projectRoot);
  // Run the spec directly via @playwright/test. `--reporter=line` keeps stdout
  // compact; exit code is the signal.
  const rel = path.relative(projectRoot, specFile);
  const res = await execa(
    "npx",
    ["playwright", "test", "--reporter=line", rel],
    {
      cwd: projectRoot,
      reject: false,
      timeout: config.timeouts.personaRunMs,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const stdout = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
  let result: ExecResult;
  if (res.timedOut) {
    result = { ranSpec: true, status: "blocked", reason: "playwright test timed out", stdout };
  } else if (res.exitCode === 0) {
    result = { ranSpec: true, status: "passed", stdout };
  } else {
    result = {
      ranSpec: true,
      status: "failed",
      reason: extractFailureReason(stdout) ?? `playwright test exited ${res.exitCode}`,
      stdout,
    };
  }

  recordAndLog(dir, uc.id, result);
  // Compact JSON on stdout for the caller; full stdout already streamed.
  console.log(JSON.stringify({ ...result, stdout: undefined }));
  return result;
}

function recordAndLog(sessionDir: string, useCaseId: string, result: ExecResult): void {
  if (result.status === "skipped") return;
  const s = readSession(sessionDir);
  const uc = s.useCases.find((u) => u.id === useCaseId);
  if (!uc) return;
  uc.status = result.status;
  if (result.status === "passed") {
    delete uc.reason;
  } else if (result.reason) {
    uc.reason = result.reason;
  }
  writeSession(sessionDir, normalize(s));
  appendLog(
    sessionDir,
    "orchestrator",
    `exec ${useCaseId}: ${result.status}${result.reason ? ` — ${result.reason}` : ""}`,
  );
}

function extractFailureReason(stdout: string): string | undefined {
  // `--reporter=line` prints lines like:
  //   "Error: expect(received).toBeVisible() ..."
  //   "  1) [chromium] › ... › Sign in › should ..."
  const errLine = stdout.split(/\r?\n/).find((l) => /^\s*(Error|Timeout|TimeoutError):/i.test(l));
  if (errLine) return errLine.trim().slice(0, 240);
  const failLine = stdout.split(/\r?\n/).find((l) => /\d+ failed/.test(l));
  return failLine?.trim().slice(0, 240);
}

function resolveSessionDir(opts: ExecOptions): string {
  if (opts.sessionDir) return opts.sessionDir;
  const envDir = process.env.RUMI_SESSION;
  if (envDir) return envDir;
  const root = projectRumiRoot(opts.projectRoot ?? process.cwd());
  if (!fs.existsSync(root)) throw new Error("no rumi/ directory");
  let newest: { dir: string; mtime: number } | null = null;
  for (const slug of fs.readdirSync(root)) {
    const dir = path.join(root, slug);
    if (!fs.statSync(dir).isDirectory()) continue;
    const sj = path.join(dir, "session.json");
    if (!fs.existsSync(sj)) continue;
    const m = fs.statSync(sj).mtimeMs;
    if (!newest || m > newest.mtime) newest = { dir, mtime: m };
  }
  if (!newest) throw new Error("no session.json under rumi/");
  return newest.dir;
}

function findProjectRoot(sessionDir: string): string {
  return path.resolve(sessionDir, "..", "..");
}
