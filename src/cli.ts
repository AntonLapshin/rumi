#!/usr/bin/env node
import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runServe } from "./commands/serve.js";
import { runOrchestrator } from "./commands/run.js";
import { runInstall } from "./commands/install.js";
import { runLog } from "./commands/log.js";

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
  .option("--max-iterations <n>", "safety cap (default 12)", (v) => Number(v), 12)
  .action(async (session: string, options: { runner?: string; projectRoot?: string; maxIterations: number }) => {
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
  .option("--max-iterations <n>", "safety cap (default 12)", (v) => Number(v), 12)
  .option("--no-dashboard", "skip auto-starting the dashboard on :3737")
  .option("--port <number>", "dashboard port (default 3737)", (v) => Number(v), 3737)
  .action(async (
    url: string,
    options: {
      runner?: string;
      projectRoot?: string;
      maxIterations: number;
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
  .command("log")
  .description("Append a line to the active session's logs.txt")
  .argument("<persona>", "pm | fee | qa | system | orchestrator")
  .argument("<message>", "log message")
  .option("--session <path>", "session directory (defaults to newest in cwd/rumi)")
  .option("--project-root <path>", "project root (defaults to cwd)")
  .action((persona: string, message: string, options: { session?: string; projectRoot?: string }) => {
    runLog(persona, message, { sessionDir: options.session, projectRoot: options.projectRoot });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
