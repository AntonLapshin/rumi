import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { templateDir } from "../lib/paths.js";
import { appendLog } from "../lib/logger.js";
import { buildRunnerArgs, detectRunner, Runner, runnerBinary } from "../lib/runner.js";
import { Config, readConfig } from "../lib/config.js";
import { splitDraft, draftPath } from "../lib/split-draft.js";
import {
  listUseCaseFiles,
  readUseCase,
  writeUseCase,
  isTerminal,
} from "../lib/tests-io.js";

export interface RunOptions {
  runner?: string;
  projectRoot?: string;
}

export interface RunSummary {
  passed: number;
  failed: number;
  blocked: number;
  total: number;
  status: "complete" | "incomplete";
}

type PersonaRole = "fee" | "qa";

export async function runOrchestrator(
  sessionDir: string,
  opts: RunOptions = {},
): Promise<RunSummary> {
  const projectRoot = opts.projectRoot ?? findProjectRoot(sessionDir);
  const config = readConfig(projectRoot);
  const runner = await detectRunner(opts.runner ?? config.runner ?? undefined);

  appendLog(
    sessionDir,
    "orchestrator",
    `starting (runner=${runner}, projectRoot=${projectRoot}, personaRunMs=${config.timeouts.personaRunMs})`,
  );

  const featureMd = path.join(sessionDir, "feature.md");
  const draft = draftPath(sessionDir);
  const hasTests = listUseCaseFiles(sessionDir).length > 0;

  // FEE runs once, up front, unless its outputs already exist (resume).
  if (!fs.existsSync(featureMd) || (!fs.existsSync(draft) && !hasTests)) {
    appendLog(sessionDir, "orchestrator", "spawning FEE");
    await spawnPersona("fee", sessionDir, projectRoot, runner, config);
  }

  // Split the draft into per-use-case files. Idempotent; if already split
  // (resume after kill), draft.json is gone and this is a no-op.
  if (fs.existsSync(draft)) {
    const res = splitDraft(sessionDir);
    appendLog(
      sessionDir,
      "orchestrator",
      `split draft: ${res.created.length} new, ${res.skipped.length} existing`,
    );
  }

  // Run QA once per non-terminal use case. Fresh subprocess per file ⇒ fresh
  // context each time. Files written by prior QAs stay untouched.
  for (const file of listUseCaseFiles(sessionDir)) {
    const uc = readUseCase(file);
    if (isTerminal(uc.status)) continue;

    uc.status = "running";
    writeUseCase(file, uc);
    appendLog(sessionDir, "orchestrator", `QA ${uc.id}`);

    await spawnPersona("qa", sessionDir, projectRoot, runner, config, {
      useCaseFile: file,
    });

    // Safety: if QA crashed / timed out / ignored the instruction, force-terminal
    // so the loop doesn't spin and the dashboard doesn't show a stuck "running".
    const after = readUseCase(file);
    if (!isTerminal(after.status)) {
      after.status = "blocked";
      after.reason = after.reason ?? "QA did not record a result";
      writeUseCase(file, after);
      appendLog(
        sessionDir,
        "orchestrator",
        `⚠ QA left ${after.id} non-terminal; marked blocked`,
      );
    }
  }

  const summary = summarize(sessionDir);
  appendLog(
    sessionDir,
    "orchestrator",
    `done — ${summary.passed} passed, ${summary.failed} failed, ${summary.blocked} blocked`,
  );
  return summary;
}

function summarize(sessionDir: string): RunSummary {
  const ucs = listUseCaseFiles(sessionDir).map((f) => readUseCase(f));
  const passed = ucs.filter((u) => u.status === "passed").length;
  const failed = ucs.filter((u) => u.status === "failed").length;
  const blocked = ucs.filter((u) => u.status === "blocked").length;
  const terminal = passed + failed + blocked;
  return {
    passed,
    failed,
    blocked,
    total: ucs.length,
    status: ucs.length > 0 && terminal === ucs.length ? "complete" : "incomplete",
  };
}

interface PersonaSpawnOpts {
  useCaseFile?: string;
}

async function spawnPersona(
  role: PersonaRole,
  sessionDir: string,
  projectRoot: string,
  runner: Runner,
  config: Config,
  spawnOpts: PersonaSpawnOpts = {},
): Promise<void> {
  const prompt = buildPersonaPrompt(role, sessionDir, projectRoot, spawnOpts);
  const bin = runnerBinary(runner);
  const args = buildRunnerArgs(runner, prompt);

  const res = await execa(bin, args, {
    cwd: projectRoot,
    stdio: ["ignore", "inherit", "inherit"],
    reject: false,
    timeout: config.timeouts.personaRunMs,
    env: {
      ...process.env,
      RUMI_SESSION: sessionDir,
      RUMI_ROLE: role,
      ...(spawnOpts.useCaseFile
        ? { RUMI_USE_CASE_FILE: spawnOpts.useCaseFile }
        : {}),
    },
  });

  if (res.timedOut) {
    appendLog(
      sessionDir,
      "orchestrator",
      `⚠ ${role.toUpperCase()} hit personaRunMs (${config.timeouts.personaRunMs}ms); killed`,
    );
  } else if (res.exitCode !== 0) {
    appendLog(sessionDir, "orchestrator", `⚠ ${role.toUpperCase()} exited ${res.exitCode}`);
  }
}

function buildPersonaPrompt(
  role: PersonaRole,
  sessionDir: string,
  projectRoot: string,
  spawnOpts: PersonaSpawnOpts,
): string {
  const template = fs.readFileSync(
    path.join(templateDir(), `persona-${role}.md`),
    "utf8",
  );
  const meta = readMeta(sessionDir);

  const lines = [
    template.trim(),
    "",
    "## Session context",
    `- Session directory: \`${sessionDir}\``,
    `- Project root: \`${projectRoot}\``,
    `- feature.md: \`${path.join(sessionDir, "feature.md")}\``,
    `- URL: \`${meta.url}\``,
  ];

  if (role === "fee") {
    lines.push(`- Write draft.json to: \`${draftPath(sessionDir)}\``);
  }
  if (role === "qa" && spawnOpts.useCaseFile) {
    lines.push(
      `- Use case file: \`${spawnOpts.useCaseFile}\``,
      `- Playwright spec output: \`${spawnOpts.useCaseFile.replace(/\.json$/, ".test.ts")}\``,
    );
  }

  return lines.join("\n");
}

interface SessionMeta {
  url: string;
  createdAt: string;
}

function readMeta(sessionDir: string): SessionMeta {
  const file = path.join(sessionDir, "meta.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as SessionMeta;
}

function findProjectRoot(sessionDir: string): string {
  return path.resolve(sessionDir, "..", "..");
}
