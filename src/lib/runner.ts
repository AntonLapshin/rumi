import { execa } from "execa";

export type Runner = "claude" | "opencode";

export async function detectRunner(override?: string): Promise<Runner> {
  const forced = override ?? process.env.RUMI_RUNNER;
  if (forced === "claude" || forced === "opencode") return forced;

  if (process.env.CLAUDECODE === "1" || process.env.CLAUDE_CODE === "1") return "claude";
  if (process.env.OPENCODE === "1") return "opencode";

  if (await onPath("claude")) return "claude";
  if (await onPath("opencode")) return "opencode";

  throw new Error(
    "Neither `claude` nor `opencode` found on PATH. Set RUMI_RUNNER=claude|opencode or pass --runner."
  );
}

async function onPath(bin: string): Promise<boolean> {
  try {
    const res = await execa("which", [bin], { reject: false });
    return res.exitCode === 0 && res.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export function buildRunnerArgs(runner: Runner, prompt: string, extra: string[] = []): string[] {
  if (runner === "claude") {
    return [
      "-p",
      prompt,
      "--permission-mode",
      "bypassPermissions",
      ...extra,
    ];
  }
  return ["run", prompt, ...extra];
}

export function runnerBinary(runner: Runner): string {
  return runner;
}
