import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { projectRumiRoot, packageRoot } from "../lib/paths.js";
import { readConfig } from "../lib/config.js";
import {
  assertDockerAvailable,
  containerExists,
  containerRunning,
  DASHBOARD_CONTAINER,
  isInsideContainer,
  removeContainer,
  runDetached,
} from "../lib/docker.js";
import { DASHBOARD_MARKER, startDashboardServer } from "../lib/dashboard-server.js";

export interface ServeOptions {
  projectRoot?: string;
  port?: number;
  background?: boolean;
}

export type DashboardState =
  | { kind: "already-running"; port: number }
  | { kind: "started"; port: number }
  | { kind: "conflict"; port: number; listenerPid: number | null };

/**
 * When invoked inside the container (RUMI_IN_CONTAINER=1), this starts the
 * Node HTTP server that serves the dashboard. Otherwise it wraps a long-lived
 * Docker container that does the same.
 */
export async function runServe(opts: ServeOptions = {}): Promise<void> {
  if (isInsideContainer()) {
    return runServeInContainer(opts);
  }

  const projectRoot = opts.projectRoot ?? process.cwd();
  const rumiRoot = projectRumiRoot(projectRoot);
  if (!fs.existsSync(rumiRoot)) fs.mkdirSync(rumiRoot, { recursive: true });

  const state = await ensureDashboard(projectRoot, opts.port);
  console.log(describeDashboard(state));
}

function runServeInContainer(opts: ServeOptions): Promise<void> {
  // Inside the container: /work is the mounted project; dashboard assets are at /opt/rumi/dashboard.
  const projectRoot = opts.projectRoot ?? "/work";
  const port = opts.port ?? readConfig(projectRoot).dashboardPort;
  const assetsDir = path.join(packageRoot(), "dashboard");
  const dataDir = projectRumiRoot(projectRoot);
  fs.mkdirSync(dataDir, { recursive: true });
  startDashboardServer({ port, assetsDir, dataDir });
  return new Promise(() => { /* run forever */ });
}

export function describeDashboard(state: DashboardState): string {
  if (state.kind === "already-running") {
    return `rumi dashboard already running: http://localhost:${state.port}`;
  }
  if (state.kind === "started") {
    return `rumi dashboard: http://localhost:${state.port}`;
  }
  return `⚠ dashboard NOT started — something else is already on :${state.port}. Stop it or pass --port <n>.`;
}

export async function ensureDashboard(
  projectRoot: string,
  preferredPort?: number,
): Promise<DashboardState> {
  await assertDockerAvailable();
  const config = readConfig(projectRoot);
  const port = preferredPort ?? config.dashboardPort;

  // If our dashboard container is already up for *this* project, reuse it.
  if (await containerRunning(DASHBOARD_CONTAINER)) {
    const ours = await isOurDashboard(port, projectRoot);
    if (ours) return { kind: "already-running", port };
    // A rumi-dashboard container exists but for a different project / port. Replace it.
    await removeContainer(DASHBOARD_CONTAINER, { force: true });
  } else if (await containerExists(DASHBOARD_CONTAINER)) {
    await removeContainer(DASHBOARD_CONTAINER, { force: true });
  }

  // Foreign process on the preferred port?
  if (await isPortOpen(port)) {
    return { kind: "conflict", port, listenerPid: null };
  }

  await runDetached({
    image: config.image,
    containerName: DASHBOARD_CONTAINER,
    projectRoot,
    cmd: ["serve", "--project-root", "/work", "--port", String(port)],
    ports: [{ host: port, container: port }],
    restart: "unless-stopped",
  });

  for (let i = 0; i < 80; i++) {
    if (await hasDashboardMarker(port)) return { kind: "started", port };
    await delay(100);
  }
  console.warn(`⚠ dashboard container started but did not respond on :${port} within 8s`);
  return { kind: "started", port };
}

async function hasDashboardMarker(port: number): Promise<boolean> {
  const body = await httpGet(`http://127.0.0.1:${port}/`);
  return !!body && body.includes(DASHBOARD_MARKER);
}

async function isOurDashboard(port: number, projectRoot: string): Promise<boolean> {
  const body = await httpGet(`http://127.0.0.1:${port}/`);
  if (!body || !body.includes(DASHBOARD_MARKER)) return false;
  const sessions = await httpGet(`http://127.0.0.1:${port}/sessions.json`);
  if (sessions == null) return false;
  const localSessionsPath = path.join(projectRumiRoot(projectRoot), "sessions.json");
  if (!fs.existsSync(localSessionsPath)) return true;
  return sessions.trim() === fs.readFileSync(localSessionsPath, "utf8").trim();
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
