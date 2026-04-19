import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { dashboardDir, projectRumiRoot } from "../lib/paths.js";
import { readConfig } from "../lib/config.js";
import { DASHBOARD_MARKER, startDashboardServer } from "../lib/dashboard-server.js";

export interface ServeOptions {
  projectRoot?: string;
  port?: number;
}

export type DashboardState =
  | { kind: "already-running"; port: number }
  | { kind: "started"; port: number }
  | { kind: "restarted"; port: number }
  | { kind: "conflict"; port: number };

export async function runServe(opts: ServeOptions = {}): Promise<void> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const rumiRoot = projectRumiRoot(projectRoot);
  if (!fs.existsSync(rumiRoot)) fs.mkdirSync(rumiRoot, { recursive: true });
  const port = opts.port ?? readConfig(projectRoot).dashboardPort;
  startDashboardServer({ port, assetsDir: dashboardDir(), dataDir: rumiRoot });
  return new Promise(() => { /* run forever */ });
}

export function describeDashboard(state: DashboardState): string {
  if (state.kind === "already-running") {
    return `rumi dashboard already running: http://localhost:${state.port}`;
  }
  if (state.kind === "started") {
    return `rumi dashboard: http://localhost:${state.port}`;
  }
  if (state.kind === "restarted") {
    return `rumi dashboard restarted: http://localhost:${state.port}`;
  }
  return `⚠ dashboard NOT started — something else is already on :${state.port}. Stop it or pass --port <n>.`;
}

export interface EnsureDashboardOptions {
  /** If a rumi dashboard is already running on this port, shut it down and
   *  spawn a fresh one. Used by `rumi init` so each `/rumi URL` invocation
   *  gets a clean dashboard process. */
  forceRestart?: boolean;
}

export async function ensureDashboard(
  projectRoot: string,
  preferredPort?: number,
  opts: EnsureDashboardOptions = {},
): Promise<DashboardState> {
  const config = readConfig(projectRoot);
  const port = preferredPort ?? config.dashboardPort;

  const markerUp = await hasDashboardMarker(port);
  if (markerUp && !opts.forceRestart) return { kind: "already-running", port };

  if (markerUp && opts.forceRestart) {
    await requestShutdown(port);
    if (!(await waitForPortFree(port, 5000))) {
      console.warn(`⚠ existing dashboard on :${port} did not release the port within 5s`);
      return { kind: "conflict", port };
    }
    spawnDetachedServe(projectRoot, port);
    if (await waitForMarker(port, 8000)) return { kind: "restarted", port };
    console.warn(`⚠ restarted dashboard did not respond on :${port} within 8s`);
    return { kind: "restarted", port };
  }

  if (await isPortOpen(port)) return { kind: "conflict", port };

  spawnDetachedServe(projectRoot, port);
  if (await waitForMarker(port, 8000)) return { kind: "started", port };
  console.warn(`⚠ dashboard started but did not respond on :${port} within 8s`);
  return { kind: "started", port };
}

async function waitForMarker(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasDashboardMarker(port)) return true;
    await delay(100);
  }
  return false;
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port))) return true;
    await delay(100);
  }
  return false;
}

function requestShutdown(port: number): Promise<void> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/__shutdown", method: "POST", timeout: 1000 },
      (res) => { res.resume(); res.on("end", () => resolve()); },
    );
    req.on("timeout", () => { req.destroy(); resolve(); });
    req.on("error", () => resolve());
    req.end();
  });
}

function spawnDetachedServe(projectRoot: string, port: number): void {
  const entry = process.argv[1]; // dist/cli.js (or the installed bin resolved to it)
  const child = spawn(
    process.execPath,
    [entry, "serve", "--project-root", projectRoot, "--port", String(port)],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

async function hasDashboardMarker(port: number): Promise<boolean> {
  const body = await httpGet(`http://127.0.0.1:${port}/`);
  return !!body && body.includes(DASHBOARD_MARKER);
}

function httpGet(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 500 }, (res) => {
      if ((res.statusCode ?? 0) >= 400) {
        res.resume();
        return resolve(null);
      }
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (buf += c));
      res.on("end", () => resolve(buf));
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(300);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, "127.0.0.1");
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
