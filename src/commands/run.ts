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
import { isTypedAction } from "../lib/schema.js";
import { runExec } from "./exec.js";
import { runPreflight } from "./preflight.js";

export interface RunOptions {
  runner?: string;
  projectRoot?: string;
  maxIterations?: number;
}

// The safety cap scales with the session's scope: PM (1-2) + FEE (1) + QA
// (one pass per use case, +1 buffer). A flat cap either starves large runs
// or lets trivial ones spin. If the caller specifies an explicit number we
// respect it.
function computeIterationCap(session: Session): number {
  const ucs = session.useCases.length || 0;
  return Math.max(12, ucs * 3 + 5);
}

// PM is split into two focused phases: code research (fills feature.md) and
// live exploration (fills description + use cases). Keeping each prompt small
// helps smaller models stay on-task.
type PersonaRole = "pm-code" | "pm-explore" | "fee" | "qa";

export async function runOrchestrator(sessionDir: string, opts: RunOptions = {}): Promise<Session> {
  const projectRoot = opts.projectRoot ?? findProjectRoot(sessionDir);
  const config = readConfig(projectRoot);
  const runner = await detectRunner(opts.runner ?? config.runner ?? undefined);
  // Normalize the state on disk first so we can size the cap against real
  // use-case count (important on resume).
  let session = writeAndReturn(sessionDir, normalize(readSession(sessionDir)));
  const maxIterations = opts.maxIterations ?? computeIterationCap(session);

  appendLog(
    sessionDir,
    "orchestrator",
    `starting loop (runner=${runner}, projectRoot=${projectRoot}, personaRunMs=${config.timeouts.personaRunMs}, maxIterations=${maxIterations})`,
  );

  let iter = 0;

  while (session.status !== "complete" && iter < maxIterations) {
    iter++;
    const next = decideNextPersona(session, sessionDir);
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

      const allTyped =
        (target.actions?.length ?? 0) > 0 && (target.actions ?? []).every(isTypedAction);

      // Preflight: open the URL + snapshot.
      //   - URL unreachable → block immediately (no sense running exec/QA).
      //   - For typed-action use cases, selector misses gate execution: a
      //     missing role/name means the generated spec will time out at 30s
      //     per action anyway. Fail fast with a useful reason instead of
      //     burning 3 minutes of Playwright runtime.
      //   - For prose actions we can't mechanically verify selectors, so
      //     misses are logged for QA but don't block.
      try {
        const pre = await runPreflight({
          useCaseId: target.id,
          sessionDir,
          projectRoot,
        });
        if (!pre.reachable) {
          const s = readSession(sessionDir);
          const uc = s.useCases.find((u) => u.id === target.id);
          if (uc) {
            uc.status = "blocked";
            uc.reason = pre.error ?? "URL unreachable";
            session = writeAndReturn(sessionDir, normalize(s));
            appendLog(
              sessionDir,
              "orchestrator",
              `preflight ${target.id}: unreachable — marked blocked`,
            );
          }
          continue;
        }
        if (pre.misses.length > 0) {
          appendLog(
            sessionDir,
            "orchestrator",
            `preflight ${target.id}: ${pre.misses.length} selector hint(s)`,
          );
          if (allTyped) {
            const s = readSession(sessionDir);
            const uc = s.useCases.find((u) => u.id === target.id);
            if (uc) {
              const hints = pre.misses.slice(0, 3).map((m) => m.hint).join("; ");
              uc.status = "failed";
              uc.reason = `preflight: ${hints}`;
              session = writeAndReturn(sessionDir, normalize(s));
              appendLog(
                sessionDir,
                "orchestrator",
                `preflight ${target.id}: typed selectors not in snapshot — marked failed`,
              );
            }
            continue;
          }
        }
      } catch (e) {
        appendLog(
          sessionDir,
          "orchestrator",
          `⚠ preflight ${target.id} crashed: ${(e as Error).message}; continuing`,
        );
      }

      // Fast path: if every action on this use case is typed, the spec is
      // fully rendered. Run it via `rumi exec` — no QA persona needed.
      let handled = false;
      if (allTyped) {
        try {
          const result = await runExec({
            useCaseId: target.id,
            sessionDir,
            projectRoot,
          });
          handled = result.ranSpec;
          if (handled) {
            appendLog(
              sessionDir,
              "orchestrator",
              `exec ${target.id}: ${result.status}${result.reason ? ` — ${result.reason}` : ""}`,
            );
          }
        } catch (e) {
          appendLog(
            sessionDir,
            "orchestrator",
            `⚠ exec ${target.id} crashed: ${(e as Error).message}; falling back to QA persona`,
          );
        }
      }

      if (!handled) {
        await spawnPersona("qa", sessionDir, projectRoot, runner, config, { useCaseId: target.id });
      }
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

    if (!stateAdvanced(before, session, next, sessionDir)) {
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

function decideNextPersona(s: Session, sessionDir: string): PersonaRole | null {
  // pm-code: feature.md doesn't exist yet or hasn't been filled beyond the scaffold.
  if (!featureMdIsFilled(sessionDir)) return "pm-code";
  // pm-explore: description or use cases missing.
  if (!s.description || s.description.trim() === "" || s.useCases.length === 0) return "pm-explore";
  const needsActions = s.useCases.some((uc) => !uc.actions || uc.actions.length === 0);
  if (needsActions) return "fee";
  const needsTesting = s.useCases.some(
    (uc) => uc.status === "ready" || uc.status === "draft" || uc.status === "testing" || !uc.status,
  );
  if (needsTesting) return "qa";
  return null;
}

function featureMdIsFilled(sessionDir: string): boolean {
  const p = path.join(sessionDir, "feature.md");
  if (!fs.existsSync(p)) return false;
  const text = fs.readFileSync(p, "utf8");
  // Scaffold starts with `# <Feature Name>` and has a placeholder comment in
  // every section. Any edit that replaces the title or strips any placeholder
  // counts as "filled enough" — PM declares done via lint-feature-md.
  if (text.includes("# <Feature Name>")) return false;
  // If all top-level placeholder comments are still present, it's untouched.
  const placeholders = (text.match(/<!--[^]*?-->/g) ?? []).length;
  return placeholders < 4;
}

function stateAdvanced(before: Session, after: Session, role: PersonaRole, sessionDir: string): boolean {
  if (role === "pm-code") {
    return featureMdIsFilled(sessionDir);
  }
  if (role === "pm-explore") {
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

  // The child's RUMI_ROLE should be the runtime persona, not the phase tag.
  const envRole = role === "pm-code" || role === "pm-explore" ? "pm" : role;

  const res = await execa(bin, args, {
    cwd: projectRoot,
    stdio: ["ignore", "inherit", "inherit"],
    reject: false,
    timeout: config.timeouts.personaRunMs,
    env: {
      ...process.env,
      RUMI_SESSION: sessionDir,
      RUMI_ROLE: envRole,
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
  _config: Config,
  spawnOpts: PersonaSpawnOpts,
): string {
  const template = fs.readFileSync(path.join(templateDir(), `persona-${role}.md`), "utf8");
  const session = readSession(sessionDir);

  const lines = [
    template.trim(),
    "",
    "## Session context",
    `- Session directory: \`${sessionDir}\``,
    `- Project root: \`${projectRoot}\``,
    `- feature.md path: \`${path.join(sessionDir, "feature.md")}\``,
    `- e2e/ directory: \`${path.join(sessionDir, "e2e")}\``,
    "",
    "## URL",
    `- \`${session.url}\``,
  ];

  lines.push("", "## Task", ...buildRoleTask(role, session, spawnOpts));

  return lines.join("\n");
}

// Scoped context injection (Theme 7). Each persona sees only the fields
// relevant to its phase. Smaller models stay focused; prompt size stays flat
// regardless of session size.
function buildRoleTask(role: PersonaRole, session: Session, spawnOpts: PersonaSpawnOpts): string[] {
  switch (role) {
    case "pm-code": {
      return [
        "- Fill `feature.md` from the codebase. Do not open the URL in this phase.",
        "- When done, run `rumi session lint-feature-md` and fix any reported problems.",
      ];
    }
    case "pm-explore": {
      const existingCount = session.useCases.length;
      return [
        "- Open the URL with playwright-cli. Confirm what's in `feature.md` is real.",
        `- Draft 3–8 use cases via \`rumi session add-use-case\`. (${existingCount} already present.)`,
        "- Set description via `rumi session set-description`.",
      ];
    }
    case "fee": {
      const needs = session.useCases
        .filter((uc) => !uc.actions || uc.actions.length === 0)
        .map((uc) => `  - \`${uc.id}\`: ${uc.title} — ${uc.description}`);
      return [
        '- Fill 5–15 actions for each use case below using `rumi session add-action <id> "<step>"`.',
        "- Use `rumi session add-use-case` for any real gaps you find.",
        "",
        "Use cases needing actions:",
        ...needs,
      ];
    }
    case "qa": {
      const id = spawnOpts.useCaseId ?? "";
      const uc = session.useCases.find((u) => u.id === id);
      if (!uc) return [`- ERROR: use case id "${id}" not found in session.`];
      const actions = (uc.actions ?? []).map((a, i) => `  ${i + 1}. ${a}`);
      return [
        `- Assigned use case id: \`${uc.id}\``,
        `- Title: ${uc.title}`,
        `- Description: ${uc.description}`,
        "- Actions:",
        ...actions,
        "- Record result via `rumi session record-result <id> <passed|failed|blocked> [--reason \"...\"]`.",
        `- Fill \`e2e/${uc.id}.test.ts\` (already scaffolded with goto + timeouts).`,
      ];
    }
  }
}

function findProjectRoot(sessionDir: string): string {
  // session dir is <projectRoot>/rumi/<slug>
  return path.resolve(sessionDir, "..", "..");
}
