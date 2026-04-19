import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { templateDir } from "../lib/paths.js";
import { appendLog } from "../lib/logger.js";
import { readSession, writeSession } from "../lib/session-io.js";
import { Session, UseCase } from "../lib/schema.js";
import { buildRunnerArgs, detectRunner, Runner, runnerBinary } from "../lib/runner.js";
import { Config, readConfig } from "../lib/config.js";
import { normalize } from "../lib/normalize.js";
import { scaffoldE2eSpec } from "../lib/e2e-scaffold.js";

export interface RunOptions {
  runner?: string;
  projectRoot?: string;
  maxIterations?: number;
}

type PersonaRole = "pm" | "fee" | "qa";

export async function runOrchestrator(sessionDir: string, opts: RunOptions = {}): Promise<Session> {
  const projectRoot = opts.projectRoot ?? findProjectRoot(sessionDir);
  const config = readConfig(projectRoot);
  const runner = await detectRunner(opts.runner ?? config.runner ?? undefined);
  const maxIterations = opts.maxIterations ?? 40;

  appendLog(
    sessionDir,
    "orchestrator",
    `starting loop (runner=${runner}, projectRoot=${projectRoot}, personaRunMs=${config.timeouts.personaRunMs})`,
  );

  // Normalize whatever state is already on disk (resume case).
  let session = writeAndReturn(sessionDir, normalize(readSession(sessionDir)));

  let iter = 0;

  while (session.status !== "complete" && iter < maxIterations) {
    iter++;
    const next = decideNextPersona(session);
    if (!next) {
      session.status = "complete";
      session = writeAndReturn(sessionDir, session);
      appendLog(sessionDir, "orchestrator", "all use cases have terminal status — complete");
      break;
    }

    if (next === "qa") {
      const target = pickNextUseCaseForQa(session);
      if (!target) {
        // Shouldn't happen (decideNextPersona said qa) — defensive.
        session.status = "complete";
        session = writeAndReturn(sessionDir, session);
        break;
      }
      appendLog(
        sessionDir,
        "orchestrator",
        `iteration ${iter}: QA on use case ${target.id}`,
      );
      // Mark the assigned use case as in-flight before spawning so the
      // dashboard highlights it and so QA cannot get confused about which
      // one it's meant to test.
      target.status = "testing";
      session = writeAndReturn(sessionDir, session);
      scaffoldE2eSpec(sessionDir, target, session.url, config);
      await spawnPersona("qa", sessionDir, projectRoot, runner, config, { useCaseId: target.id });
      session = writeAndReturn(sessionDir, normalize(readSession(sessionDir)));

      // Guard against QA leaving its assigned use case non-terminal (crashed,
      // timed out, or ignored instructions). Without this, the loop would
      // re-assign the same UC forever.
      const after = session.useCases.find((u) => u.id === target.id);
      if (after && !isTerminal(after)) {
        after.status = "blocked";
        if (!after.reason) after.reason = "QA did not record a result";
        session = writeAndReturn(sessionDir, normalize(session));
        appendLog(
          sessionDir,
          "orchestrator",
          `⚠ QA left ${target.id} non-terminal; marked blocked`,
        );
      }
      continue;
    }

    appendLog(sessionDir, "orchestrator", `iteration ${iter}: spawning ${next.toUpperCase()} persona`);
    const before = session;
    await spawnPersona(next, sessionDir, projectRoot, runner, config);
    session = writeAndReturn(sessionDir, normalize(readSession(sessionDir)));

    if (!stateAdvanced(before, session, next)) {
      appendLog(sessionDir, "orchestrator", `⚠ ${next.toUpperCase()} did not advance state; breaking loop`);
      break;
    }
  }

  if (iter >= maxIterations && session.status !== "complete") {
    appendLog(sessionDir, "orchestrator", `⚠ reached max iterations (${maxIterations}); stopping`);
  }

  return session;
}

function writeAndReturn(sessionDir: string, s: Session): Session {
  writeSession(sessionDir, s);
  return s;
}

function isTerminal(uc: UseCase): boolean {
  return uc.status === "passed" || uc.status === "failed" || uc.status === "blocked";
}

function pickNextUseCaseForQa(s: Session): UseCase | null {
  // Prefer leftover "testing" (crashed previous run), then "ready"/"draft".
  const crashed = s.useCases.find((u) => u.status === "testing");
  if (crashed) return crashed;
  return (
    s.useCases.find(
      (u) => (u.actions?.length ?? 0) > 0 && (u.status === "ready" || u.status === "draft" || !u.status),
    ) ?? null
  );
}

function decideNextPersona(s: Session): PersonaRole | null {
  if (!s.description || s.description.trim() === "" || s.useCases.length === 0) return "pm";
  const needsActions = s.useCases.some((uc) => !uc.actions || uc.actions.length === 0);
  if (needsActions) return "fee";
  const needsTesting = s.useCases.some(
    (uc) => uc.status === "ready" || uc.status === "draft" || uc.status === "testing" || !uc.status,
  );
  if (needsTesting) return "qa";
  return null;
}

function stateAdvanced(before: Session, after: Session, role: PersonaRole): boolean {
  if (role === "pm") {
    return after.description.trim().length > 0 && after.useCases.length > 0;
  }
  // fee
  const beforeReady = before.useCases.filter((uc) => uc.actions && uc.actions.length > 0).length;
  const afterReady = after.useCases.filter((uc) => uc.actions && uc.actions.length > 0).length;
  return afterReady > beforeReady;
}

interface PersonaSpawnOpts {
  useCaseId?: string;
}

async function spawnPersona(
  role: PersonaRole,
  sessionDir: string,
  projectRoot: string,
  runner: Runner,
  config: Config,
  spawnOpts: PersonaSpawnOpts = {},
): Promise<void> {
  const prompt = buildPersonaPrompt(role, sessionDir, projectRoot, config, spawnOpts);
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
      ...(spawnOpts.useCaseId ? { RUMI_USE_CASE: spawnOpts.useCaseId } : {}),
    },
  });

  if (res.timedOut) {
    appendLog(
      sessionDir,
      "orchestrator",
      `⚠ ${role.toUpperCase()} child hit personaRunMs (${config.timeouts.personaRunMs}ms); killed`,
    );
  } else if (res.exitCode !== 0) {
    appendLog(sessionDir, "orchestrator", `⚠ ${role.toUpperCase()} child exited ${res.exitCode}`);
  }
}

function buildPersonaPrompt(
  role: PersonaRole,
  sessionDir: string,
  projectRoot: string,
  config: Config,
  spawnOpts: PersonaSpawnOpts,
): string {
  const template = fs.readFileSync(path.join(templateDir(), `persona-${role}.md`), "utf8");
  const sessionJson = fs.readFileSync(path.join(sessionDir, "session.json"), "utf8");
  const sessionUrl = (() => {
    try { return JSON.parse(sessionJson).url as string; } catch { return ""; }
  })();

  const lines = [
    template.trim(),
    "",
    "## Session context",
    `- Session directory: \`${sessionDir}\``,
    `- Project root: \`${projectRoot}\``,
    `- session.json path: \`${path.join(sessionDir, "session.json")}\``,
    `- feature.md path: \`${path.join(sessionDir, "feature.md")}\``,
    `- e2e/ directory: \`${path.join(sessionDir, "e2e")}\``,
    `- logs.txt path: \`${path.join(sessionDir, "logs.txt")}\``,
    "",
    "## URL",
    `- \`${sessionUrl}\``,
  ];

  if (role === "qa") {
    lines.push(
      "",
      "## Task",
      `- Test use case id: \`${spawnOpts.useCaseId ?? ""}\` (find it in \`session.json#useCases\` by id).`,
      `- A skeleton \`e2e/<id>.test.ts\` has already been written with the right timeouts and \`goto\` — fill in the body.`,
    );
  }

  lines.push(
    "",
    "## Current session.json",
    "```json",
    sessionJson.trim(),
    "```",
  );

  return lines.join("\n");
}

function findProjectRoot(sessionDir: string): string {
  // session dir is <projectRoot>/rumi/<slug>
  return path.resolve(sessionDir, "..", "..");
}
