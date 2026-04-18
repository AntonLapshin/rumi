import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { templateDir } from "../lib/paths.js";
import { appendLog } from "../lib/logger.js";
import { readSession, writeSession } from "../lib/session-io.js";
import { Session } from "../lib/schema.js";
import { buildRunnerArgs, detectRunner, Runner, runnerBinary } from "../lib/runner.js";
import { Config, readConfig } from "../lib/config.js";
import {
  assertDockerAvailable,
  isInsideContainer,
  runEphemeral,
  sanitizeContainerName,
} from "../lib/docker.js";

export interface RunOptions {
  runner?: string;
  projectRoot?: string;
  maxIterations?: number;
}

type PersonaRole = "pm" | "fee" | "qa";

export async function runOrchestrator(sessionDir: string, opts: RunOptions = {}): Promise<Session> {
  if (!isInsideContainer()) {
    return runOrchestratorInDocker(sessionDir, opts);
  }
  return runOrchestratorLocal(sessionDir, opts);
}

async function runOrchestratorInDocker(sessionDir: string, opts: RunOptions): Promise<Session> {
  await assertDockerAvailable();
  const projectRoot = opts.projectRoot ?? findProjectRoot(sessionDir);
  const config = readConfig(projectRoot);
  const runner = await detectRunner(opts.runner ?? config.runner ?? undefined);

  const rel = path.relative(projectRoot, sessionDir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`session directory must live under the project root (got ${sessionDir})`);
  }
  const containerSession = path.posix.join("/work", rel.split(path.sep).join("/"));
  const name = sanitizeContainerName(`rumi-run-${path.basename(sessionDir)}`);

  const runArgs = ["run", containerSession, "--runner", runner, "--project-root", "/work"];
  if (opts.maxIterations != null) runArgs.push("--max-iterations", String(opts.maxIterations));

  appendLog(sessionDir, "system", `launching docker container ${name} (image=${config.image})`);

  const res = await runEphemeral({
    image: config.image,
    containerName: name,
    projectRoot,
    cmd: runArgs,
    env: {
      RUMI_RUNNER: runner,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    },
  });

  if (res.timedOut) appendLog(sessionDir, "system", `⚠ container ${name} killed (outer timeout)`);
  if ((res.exitCode ?? 0) !== 0) appendLog(sessionDir, "system", `⚠ container ${name} exited ${res.exitCode}`);

  return readSession(sessionDir);
}

async function runOrchestratorLocal(sessionDir: string, opts: RunOptions): Promise<Session> {
  const projectRoot = opts.projectRoot ?? findProjectRoot(sessionDir);
  const config = readConfig(projectRoot);
  const runner = await detectRunner(opts.runner ?? config.runner ?? undefined);
  const maxIterations = opts.maxIterations ?? 12;

  appendLog(
    sessionDir,
    "orchestrator",
    `starting loop (runner=${runner}, projectRoot=${projectRoot}, personaRunMs=${config.timeouts.personaRunMs})`,
  );

  let session = readSession(sessionDir);
  await preflightUrlReachable(sessionDir, session.url);

  let iter = 0;

  while (session.status !== "complete" && iter < maxIterations) {
    iter++;
    const next = decideNextPersona(session);
    if (!next) {
      session.status = "complete";
      writeSession(sessionDir, session);
      appendLog(sessionDir, "orchestrator", "all use cases have terminal status — complete");
      break;
    }

    appendLog(sessionDir, "orchestrator", `iteration ${iter}: spawning ${next.toUpperCase()} persona`);
    await spawnPersona(next, sessionDir, projectRoot, runner, config);

    const before = session;
    session = readSession(sessionDir);

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

function decideNextPersona(s: Session): PersonaRole | null {
  if (!s.description || s.description.trim() === "" || s.useCases.length === 0) return "pm";
  const needsActions = s.useCases.some((uc) => !uc.actions || uc.actions.length === 0 || !uc.status);
  if (needsActions) return "fee";
  const needsTesting = s.useCases.some(
    (uc) => uc.status === "ready" || uc.status === "draft" || uc.status === "testing",
  );
  if (needsTesting) return "qa";
  return null;
}

function stateAdvanced(before: Session, after: Session, role: PersonaRole): boolean {
  if (role === "pm") {
    return after.description.trim().length > 0 && after.useCases.length > 0;
  }
  if (role === "fee") {
    const beforeReady = before.useCases.filter((uc) => uc.actions && uc.actions.length > 0).length;
    const afterReady = after.useCases.filter((uc) => uc.actions && uc.actions.length > 0).length;
    return afterReady > beforeReady;
  }
  const terminal = (uc: { status?: string }) => uc.status === "passed" || uc.status === "failed" || uc.status === "blocked";
  const beforeTerminal = before.useCases.filter(terminal).length;
  const afterTerminal = after.useCases.filter(terminal).length;
  return afterTerminal > beforeTerminal;
}

async function spawnPersona(
  role: PersonaRole,
  sessionDir: string,
  projectRoot: string,
  runner: Runner,
  config: Config,
): Promise<void> {
  const prompt = buildPersonaPrompt(role, sessionDir, projectRoot, config);
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
): string {
  const template = fs.readFileSync(path.join(templateDir(), `persona-${role}.md`), "utf8");
  const sessionJson = fs.readFileSync(path.join(sessionDir, "session.json"), "utf8");

  return [
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
    "## Networking (IMPORTANT — you are inside a Docker container)",
    "- The host machine's `localhost` is **not** your container's localhost. To reach the host, use `host.docker.internal`.",
    "- When calling `playwright-cli open` / `playwright-cli goto` with a URL taken from `session.json#url`, if the URL host is `localhost` or `127.0.0.1`, substitute `host.docker.internal` (e.g. `http://localhost:5173/foo` → `http://host.docker.internal:5173/foo`) **only for the browser call**. Do **not** mutate `session.json`.",
    "- When writing `e2e/<id>.test.ts`, use the **original** URL from `session.json#url` (with `localhost`/`127.0.0.1` intact) — those tests are re-run by the user on the host, where `localhost` means the host.",
    "",
    "## Config (from rumi/config.json)",
    `- Playwright action timeout: \`${config.timeouts.playwrightActionMs}\` ms`,
    `- Playwright navigation timeout: \`${config.timeouts.playwrightNavigationMs}\` ms`,
    "  Apply the timeouts when authoring `@playwright/test` spec files — set `test.use({ actionTimeout, navigationTimeout })` at the top of each spec, and prefer explicit `{ timeout }` options on flaky `expect(...).toBeVisible()`/`toBeEnabled()` assertions over the defaults.",
    "",
    "## Current session.json",
    "```json",
    sessionJson.trim(),
    "```",
    "",
    "## Exit criteria",
    "After finishing your work:",
    "1. Overwrite `session.json` with the updated JSON (valid against the schema in your instructions).",
    `2. Run: \`rumi log ${role} "<one-line summary>"\``,
    "3. Exit.",
  ].join("\n");
}

function findProjectRoot(sessionDir: string): string {
  // session dir is <projectRoot>/rumi/<slug>
  return path.resolve(sessionDir, "..", "..");
}

async function preflightUrlReachable(sessionDir: string, rawUrl: string): Promise<void> {
  // We're inside the container. `localhost` / `127.0.0.1` from session.json point at
  // the container's own loopback; the host is at host.docker.internal.
  let probeUrl: string;
  try {
    const u = new URL(rawUrl);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      u.hostname = "host.docker.internal";
    }
    probeUrl = u.toString();
  } catch {
    return; // malformed URL; let the personas surface the real error
  }

  const ok = await probeHttp(probeUrl);
  if (ok) {
    appendLog(sessionDir, "orchestrator", `preflight: ${probeUrl} reachable`);
    return;
  }

  const hint =
    rawUrl.includes("localhost") || rawUrl.includes("127.0.0.1")
      ? "Your dev server is likely bound to 127.0.0.1 only, which refuses connections from Docker. " +
        "Restart it with `--host` so it binds all interfaces (Vite: `npm run dev -- --host`; Next.js: `next dev -H 0.0.0.0`)."
      : `${rawUrl} is not reachable from inside the container — confirm it's up and accepting connections from Docker.`;

  const msg = `⚠ preflight: ${probeUrl} refused connection. ${hint}`;
  appendLog(sessionDir, "orchestrator", msg);
  console.error(msg);
}

function probeHttp(url: string): Promise<boolean> {
  return new Promise(async (resolve) => {
    try {
      const mod = url.startsWith("https:") ? await import("node:https") : await import("node:http");
      const req = mod.get(url, { timeout: 3000 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.on("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}
