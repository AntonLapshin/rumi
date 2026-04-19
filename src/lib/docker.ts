import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execa } from "execa";

export const DASHBOARD_CONTAINER = "rumi-dashboard";

export function isInsideContainer(): boolean {
  return process.env.RUMI_IN_CONTAINER === "1";
}

export async function assertDockerAvailable(): Promise<void> {
  const which = await execa("which", ["docker"], { reject: false });
  if (which.exitCode !== 0 || !which.stdout.trim()) {
    throw new Error("`docker` not found on PATH. Install Docker Desktop (or any Docker CLI + daemon) and try again.");
  }
  const ping = await execa("docker", ["info"], { reject: false, stdio: "ignore" });
  if (ping.exitCode !== 0) {
    throw new Error("Docker CLI is installed but the daemon is not reachable. Start Docker Desktop (or your daemon) and try again.");
  }
}

export async function imageExistsLocally(image: string): Promise<boolean> {
  const res = await execa("docker", ["image", "inspect", image], { reject: false, stdio: "ignore" });
  return res.exitCode === 0;
}

export async function pullImage(image: string): Promise<void> {
  await execa("docker", ["pull", image], { stdio: "inherit" });
}

export async function containerExists(name: string): Promise<boolean> {
  const res = await execa("docker", ["container", "inspect", name], { reject: false, stdio: "ignore" });
  return res.exitCode === 0;
}

export async function containerRunning(name: string): Promise<boolean> {
  const res = await execa("docker", ["inspect", "-f", "{{.State.Running}}", name], { reject: false });
  return res.exitCode === 0 && res.stdout.trim() === "true";
}

export async function removeContainer(name: string, opts: { force?: boolean } = {}): Promise<void> {
  await execa("docker", ["rm", ...(opts.force ? ["-f"] : []), name], { reject: false, stdio: "ignore" });
}

export async function stopContainer(name: string): Promise<void> {
  await execa("docker", ["stop", name], { reject: false, stdio: "ignore" });
}

export function sanitizeContainerName(raw: string): string {
  // docker container names: [a-zA-Z0-9][a-zA-Z0-9_.-]+
  const cleaned = raw.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^[_.-]+/, "");
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "rumi";
}

export interface BaseMountOptions {
  projectRoot: string;
  authMounts?: boolean; // default true
}

export function baseMounts(opts: BaseMountOptions): string[] {
  const args: string[] = ["-v", `${opts.projectRoot}:/work`];
  if (opts.authMounts !== false) {
    const home = os.homedir();
    // Mount only the credential files, read-only. We deliberately do NOT
    // mount the whole ~/.claude or ~/.opencode dirs:
    //   - rw would expose conversation history, project notes, and sessions
    //     across every repo to every persona.
    //   - :ro on the whole dir would break Claude Code's own writes
    //     (projects/, sessions/, history.jsonl).
    // The credential file is all a headless child actually needs; Claude
    // Code's own session state then lives inside the ephemeral container
    // and vanishes with --rm. On macOS this mount is typically absent
    // (auth lives in Keychain) — in that case the child authenticates via
    // ANTHROPIC_API_KEY from the environment instead.
    const claudeCreds = path.join(home, ".claude", ".credentials.json");
    if (fs.existsSync(claudeCreds)) {
      args.push("-v", `${claudeCreds}:/home/node/.claude/.credentials.json:ro`);
    }
    const opencodeAuth = path.join(home, ".opencode", "auth.json");
    if (fs.existsSync(opencodeAuth)) {
      args.push("-v", `${opencodeAuth}:/home/node/.opencode/auth.json:ro`);
    }
  }
  return args;
}

export function envArgs(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (v == null) continue;
    out.push("-e", `${k}=${v}`);
  }
  return out;
}

export interface RunEphemeralOptions {
  image: string;
  containerName: string;
  projectRoot: string;
  cmd: string[]; // args passed after the `rumi` ENTRYPOINT
  env?: Record<string, string | undefined>;
  timeoutMs?: number; // hard deadline; triggers `docker kill` on expiry
  ports?: Array<{ host: number; container: number }>;
}

export interface RunResult {
  exitCode: number | null;
  timedOut: boolean;
  killed: boolean;
}

/**
 * Run a one-shot container with stdio inherited. On timeout we issue
 * `docker kill` so every descendant process (personas, chromium) dies too —
 * simply killing the local `docker run` client would leave the container alive.
 */
export async function runEphemeral(opts: RunEphemeralOptions): Promise<RunResult> {
  const args: string[] = [
    "run",
    "--rm",
    "--name",
    opts.containerName,
    "--init",
    // On Docker Desktop for Mac/Windows host.docker.internal exists by default;
    // on Linux this explicit alias makes host-gateway routing work the same way,
    // so personas can always reach the host's localhost via `host.docker.internal`.
    "--add-host",
    "host.docker.internal:host-gateway",
    ...baseMounts({ projectRoot: opts.projectRoot }),
    ...envArgs(opts.env ?? {}),
  ];
  for (const p of opts.ports ?? []) {
    // Bind on host loopback only — prevents other machines on the LAN/Wi‑Fi
    // from reaching the published port. The server inside the container still
    // listens on 0.0.0.0 so Docker's port forwarding can reach it.
    args.push("-p", `127.0.0.1:${p.host}:${p.container}`);
  }
  args.push(opts.image, ...opts.cmd);

  const child = execa("docker", args, { stdio: "inherit", reject: false });

  let timedOut = false;
  let timer: NodeJS.Timeout | null = null;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      execa("docker", ["kill", opts.containerName], { reject: false, stdio: "ignore" }).catch(() => {});
    }, opts.timeoutMs);
  }

  const forwardSignal = (sig: NodeJS.Signals) => {
    execa("docker", ["kill", "--signal", sig, opts.containerName], { reject: false, stdio: "ignore" }).catch(() => {});
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  const res = await child;
  if (timer) clearTimeout(timer);
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);

  return { exitCode: res.exitCode ?? null, timedOut, killed: timedOut };
}

export interface RunDetachedOptions {
  image: string;
  containerName: string;
  projectRoot: string;
  cmd: string[];
  env?: Record<string, string | undefined>;
  ports?: Array<{ host: number; container: number }>;
  restart?: "no" | "unless-stopped" | "on-failure";
}

export async function runDetached(opts: RunDetachedOptions): Promise<void> {
  const args: string[] = [
    "run",
    "-d",
    "--name",
    opts.containerName,
    "--init",
    ...baseMounts({ projectRoot: opts.projectRoot, authMounts: false }),
    ...envArgs(opts.env ?? {}),
  ];
  if (opts.restart) args.push("--restart", opts.restart);
  for (const p of opts.ports ?? []) {
    args.push("-p", `127.0.0.1:${p.host}:${p.container}`);
  }
  args.push(opts.image, ...opts.cmd);

  const res = await execa("docker", args, { reject: false, stdio: ["ignore", "pipe", "inherit"] });
  if (res.exitCode !== 0) {
    throw new Error(`docker run -d failed (exit ${res.exitCode})`);
  }
}
