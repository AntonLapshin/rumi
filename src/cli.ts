#!/usr/bin/env node
import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runServe } from "./commands/serve.js";
import { runOrchestrator } from "./commands/run.js";
import { runInstall } from "./commands/install.js";
import { runLog } from "./commands/log.js";
import { runExec } from "./commands/exec.js";
import { runPreflight } from "./commands/preflight.js";
import {
  runAddAction,
  runAddUseCase,
  runDump,
  runLintFeatureMd,
  runRecordResult,
  runScaffoldFeatureMd,
  runSetActions,
  runSetDescription,
  runValidate,
} from "./commands/session.js";

const program = new Command();

program
  .name("rumi")
  .description("Autonomous QA test runner (PM → FEE → QA personas)")
  .version("0.1.0");

program
  .command("init")
  .description("Scaffold a QA session for a URL in the current project and start the dashboard")
  .argument("<url>", "URL to QA")
  .option("--project-root <path>", "override project root (defaults to cwd)")
  .option("--no-dashboard", "skip auto-starting the dashboard on :3737")
  .option("--port <number>", "dashboard port (default 3737)", (v) => Number(v), 3737)
  .action(async (url: string, options: { projectRoot?: string; dashboard: boolean; port: number }) => {
    const dir = await runInit(url, {
      projectRoot: options.projectRoot,
      startDashboard: options.dashboard,
      dashboardPort: options.port,
    });
    console.log(dir);
  });

program
  .command("serve")
  .description("Serve the progress dashboard from <projectRoot>/rumi")
  .option("--project-root <path>", "override project root (defaults to cwd)")
  .option("--port <number>", "port (default 3737)", (v) => Number(v), 3737)
  .action(async (options: { projectRoot?: string; port: number }) => {
    await runServe(options);
  });

program
  .command("run")
  .description("Run the orchestrator loop over a session directory")
  .argument("<session>", "path to the session directory (created by `init`)")
  .option("--runner <claude|opencode>", "force a specific runner")
  .option("--project-root <path>", "override project root (defaults to session's project)")
  .option("--max-iterations <n>", "safety cap (default scales with use case count)", (v) => Number(v))
  .action(async (session: string, options: { runner?: string; projectRoot?: string; maxIterations?: number }) => {
    const final = await runOrchestrator(session, options);
    const passed = final.useCases.filter((u) => u.status === "passed").length;
    const failed = final.useCases.filter((u) => u.status === "failed").length;
    console.log(`\nrumi complete — ${passed} passed, ${failed} failed, status=${final.status}`);
  });

program
  .command("qa")
  .description("One-shot: init a session for <url>, run the orchestrator loop, print summary")
  .argument("<url>", "URL to QA")
  .option("--runner <claude|opencode>", "force a specific runner")
  .option("--project-root <path>", "override project root (defaults to cwd)")
  .option("--max-iterations <n>", "safety cap (default scales with use case count)", (v) => Number(v))
  .option("--no-dashboard", "skip auto-starting the dashboard on :3737")
  .option("--port <number>", "dashboard port (default 3737)", (v) => Number(v), 3737)
  .action(async (
    url: string,
    options: {
      runner?: string;
      projectRoot?: string;
      maxIterations?: number;
      dashboard: boolean;
      port: number;
    },
  ) => {
    const dir = await runInit(url, {
      projectRoot: options.projectRoot,
      startDashboard: options.dashboard,
      dashboardPort: options.port,
    });
    console.log(`Session: ${dir}`);
    console.log(`Dashboard: http://localhost:${options.port}`);
    const final = await runOrchestrator(dir, {
      runner: options.runner,
      projectRoot: options.projectRoot,
      maxIterations: options.maxIterations,
    });
    const passed = final.useCases.filter((u) => u.status === "passed").length;
    const failed = final.useCases.filter((u) => u.status === "failed").length;
    const blocked = final.useCases.filter((u) => u.status === "blocked").length;
    console.log(
      `\nrumi complete — ${passed} passed, ${failed} failed, ${blocked} blocked, status=${final.status}`,
    );
  });

program
  .command("install")
  .description("Install /rumi slash command and playwright-cli skill into the current project")
  .option("--project-root <path>", "override project root (defaults to cwd)")
  .option("--skip-playwright", "do not run `playwright-cli install-skills`", false)
  .action(async (options: {
    projectRoot?: string;
    skipPlaywright: boolean;
  }) => {
    await runInstall(options);
  });

program
  .command("preflight")
  .description(
    "Open the session URL via playwright-cli, take one snapshot, and check that each typed action's selector has a plausible match. Advisory — misses are surfaced but don't alter state.",
  )
  .option("--use-case <id>", "check a specific use case's actions")
  .option("--session <path>", "session directory (defaults to $RUMI_SESSION or newest)")
  .option("--project-root <path>", "project root (defaults to cwd)")
  .option("--timeout <ms>", "per-command timeout (default 30000)", (v) => Number(v))
  .action(async (options: { useCase?: string; session?: string; projectRoot?: string; timeout?: number }) => {
    const r = await runPreflight({
      useCaseId: options.useCase,
      sessionDir: options.session,
      projectRoot: options.projectRoot,
      timeoutMs: options.timeout,
    });
    if (!r.reachable) process.exit(1);
  });

program
  .command("exec")
  .description(
    "Run the pre-generated e2e spec for a use case via `npx playwright test`. " +
    "Records passed/failed/blocked on the use case. Deterministic — no LLM needed when actions are typed.",
  )
  .argument("<useCaseId>", "use case id (matches session.useCases[i].id)")
  .option("--session <path>", "session directory (defaults to $RUMI_SESSION or newest)")
  .option("--project-root <path>", "project root (defaults to cwd)")
  .action(async (useCaseId: string, options: { session?: string; projectRoot?: string }) => {
    const result = await runExec({
      useCaseId,
      sessionDir: options.session,
      projectRoot: options.projectRoot,
    });
    if (result.status === "failed" || result.status === "blocked") process.exit(1);
  });

program
  .command("log")
  .description("Append a line to the active session's logs.txt")
  .argument("<persona>", "pm | fee | qa | system | orchestrator")
  .argument("<message>", "log message")
  .option("--session <path>", "session directory (defaults to newest in cwd/rumi)")
  .option("--project-root <path>", "project root (defaults to cwd)")
  .action((persona: string, message: string, options: { session?: string; projectRoot?: string }) => {
    runLog(persona, message, { sessionDir: options.session, projectRoot: options.projectRoot });
  });

const session = program
  .command("session")
  .description("Mutate or inspect session.json via narrow CLI subcommands (use instead of editing JSON)");

const sessionCommonOpts = <T extends Command>(cmd: T): T =>
  cmd
    .option("--session <path>", "session directory (defaults to $RUMI_SESSION or newest)")
    .option("--project-root <path>", "project root (defaults to cwd)") as T;

sessionCommonOpts(
  session
    .command("set-description")
    .description("Set the top-level session description")
    .argument("<text>", "description text")
    .action((text: string, options: { session?: string; projectRoot?: string }) => {
      runSetDescription(text, { sessionDir: options.session, projectRoot: options.projectRoot });
    }),
);

sessionCommonOpts(
  session
    .command("add-use-case")
    .description("Append a use case. Prints the assigned id on stdout.")
    .requiredOption("--title <text>", "short imperative title")
    .requiredOption("--description <text>", "1-2 sentence description")
    .action((options: { title: string; description: string; session?: string; projectRoot?: string }) => {
      runAddUseCase({
        title: options.title,
        description: options.description,
        sessionDir: options.session,
        projectRoot: options.projectRoot,
      });
    }),
);

sessionCommonOpts(
  session
    .command("add-action")
    .description(
      "Append one action step. Prefer a typed flag (--goto/--click/--fill/...) over free text so the e2e spec can be generated deterministically.",
    )
    .argument("<useCaseId>", "use case id")
    .argument("[text]", "legacy free-text step (omit if using a typed flag)")
    .option("--goto <url>", "Navigate to URL")
    .option("--click", "click an element (use --role + --name)")
    .option("--fill", "fill an input (use --label + --value)")
    .option("--press <key>", "press a keyboard key (e.g. Enter)")
    .option("--wait-for-url <substr>", "wait for URL to match")
    .option("--expect-text <text>", "assert visible text")
    .option("--expect-role", "assert element visible (use --role + --name)")
    .option("--role <role>", "ARIA role (button/link/textbox/...)")
    .option("--name <name>", "accessible name")
    .option("--label <label>", "input label")
    .option("--value <value>", "fill value")
    .action((
      useCaseId: string,
      text: string | undefined,
      options: {
        goto?: string;
        click?: boolean;
        fill?: boolean;
        press?: string;
        waitForUrl?: string;
        expectText?: string;
        expectRole?: boolean;
        role?: string;
        name?: string;
        label?: string;
        value?: string;
        session?: string;
        projectRoot?: string;
      },
    ) => {
      const typed = parseTypedAction(options);
      if (typed && text) {
        throw new Error("pass either a typed flag or free text, not both");
      }
      runAddAction({
        useCaseId,
        text,
        typed,
        sessionDir: options.session,
        projectRoot: options.projectRoot,
      });
    }),
);

function parseTypedAction(o: {
  goto?: string;
  click?: boolean;
  fill?: boolean;
  press?: string;
  waitForUrl?: string;
  expectText?: string;
  expectRole?: boolean;
  role?: string;
  name?: string;
  label?: string;
  value?: string;
}): import("./lib/schema.js").ActionObject | undefined {
  const count = [o.goto, o.click, o.fill, o.press, o.waitForUrl, o.expectText, o.expectRole].filter(Boolean).length;
  if (count === 0) return undefined;
  if (count > 1) throw new Error("pick exactly one typed action flag");
  if (o.goto) return { type: "goto", url: o.goto };
  if (o.click) {
    if (!o.role || !o.name) throw new Error("--click requires --role and --name");
    return { type: "click", role: o.role, name: o.name };
  }
  if (o.fill) {
    if (!o.label || o.value === undefined) throw new Error("--fill requires --label and --value");
    return { type: "fill", label: o.label, value: o.value };
  }
  if (o.press) return { type: "press", key: o.press };
  if (o.waitForUrl) return { type: "wait_for_url", url: o.waitForUrl };
  if (o.expectText) return { type: "expect_text", text: o.expectText };
  if (o.expectRole) {
    if (!o.role || !o.name) throw new Error("--expect-role requires --role and --name");
    return { type: "expect_role", role: o.role, name: o.name };
  }
  return undefined;
}

sessionCommonOpts(
  session
    .command("set-actions")
    .description("Replace a use case's actions. Reads a JSON array of strings from stdin.")
    .argument("<useCaseId>", "use case id")
    .action(async (useCaseId: string, options: { session?: string; projectRoot?: string }) => {
      const raw = await readStdin();
      let arr: unknown;
      try { arr = JSON.parse(raw); } catch (e) {
        throw new Error(`stdin must be a JSON array of strings: ${(e as Error).message}`);
      }
      if (!Array.isArray(arr) || !arr.every((x) => typeof x === "string")) {
        throw new Error("stdin must be a JSON array of strings");
      }
      runSetActions({
        useCaseId,
        actions: arr as string[],
        sessionDir: options.session,
        projectRoot: options.projectRoot,
      });
    }),
);

sessionCommonOpts(
  session
    .command("record-result")
    .description("Record the outcome of a use case")
    .argument("<useCaseId>", "use case id")
    .argument("<status>", "passed | failed | blocked")
    .option("--reason <text>", "required for failed/blocked")
    .action((
      useCaseId: string,
      status: string,
      options: { reason?: string; session?: string; projectRoot?: string },
    ) => {
      runRecordResult({
        useCaseId,
        status,
        reason: options.reason,
        sessionDir: options.session,
        projectRoot: options.projectRoot,
      });
    }),
);

sessionCommonOpts(
  session
    .command("dump")
    .description("Print the session (or one use case, or selected fields) as JSON")
    .option("--use-case <id>", "dump only this use case")
    .option("--fields <csv>", "comma-separated top-level or use case fields")
    .action((options: { useCase?: string; fields?: string; session?: string; projectRoot?: string }) => {
      runDump({
        useCaseId: options.useCase,
        fields: options.fields?.split(",").map((s) => s.trim()).filter(Boolean),
        sessionDir: options.session,
        projectRoot: options.projectRoot,
      });
    }),
);

sessionCommonOpts(
  session
    .command("scaffold-feature-md")
    .description("Write an empty feature.md skeleton with canonical sections")
    .option("--force", "overwrite an existing feature.md", false)
    .action((options: { force: boolean; session?: string; projectRoot?: string }) => {
      runScaffoldFeatureMd({
        force: options.force,
        sessionDir: options.session,
        projectRoot: options.projectRoot,
      });
    }),
);

sessionCommonOpts(
  session
    .command("lint-feature-md")
    .description("Check feature.md for missing/empty/out-of-order sections")
    .action((options: { session?: string; projectRoot?: string }) => {
      runLintFeatureMd({ sessionDir: options.session, projectRoot: options.projectRoot });
    }),
);

sessionCommonOpts(
  session
    .command("validate")
    .description("Check the session for schema + domain problems. Exits non-zero on issues.")
    .action((options: { session?: string; projectRoot?: string }) => {
      runValidate({ sessionDir: options.session, projectRoot: options.projectRoot });
    }),
);

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
