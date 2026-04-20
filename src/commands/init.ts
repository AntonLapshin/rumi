import fs from "node:fs";
import path from "node:path";
import { projectRumiRoot, sessionDir } from "../lib/paths.js";
import { appendLog } from "../lib/logger.js";
import { describeDashboard, ensureDashboard } from "./serve.js";
import { readConfig, writeDefaultConfigIfMissing } from "../lib/config.js";

export interface InitOptions {
  projectRoot?: string;
  startDashboard?: boolean;
  dashboardPort?: number;
}

export async function runInit(
  url: string,
  opts: InitOptions = {},
): Promise<string> {
  try {
    new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  const projectRoot = opts.projectRoot ?? process.cwd();
  const dir = sessionDir(projectRoot, url);
  fs.mkdirSync(dir, { recursive: true });

  // meta.json is the canonical per-session metadata. It's written once at
  // init time and never modified after — FEE's draft.json and the per-use-case
  // tests/*.json carry the actual session progress.
  const metaFile = path.join(dir, "meta.json");
  if (!fs.existsSync(metaFile)) {
    fs.writeFileSync(
      metaFile,
      JSON.stringify({ url, createdAt: new Date().toISOString() }, null, 2) + "\n",
      "utf8",
    );
    appendLog(dir, "system", `session created for ${url}`);
  } else {
    appendLog(dir, "system", `session resumed at ${dir}`);
  }

  updateSessionsIndex(projectRoot);

  if (writeDefaultConfigIfMissing(projectRoot)) {
    appendLog(dir, "system", "wrote default rumi/config.json");
  }

  if (opts.startDashboard !== false) {
    const port = opts.dashboardPort ?? readConfig(projectRoot).dashboardPort;
    try {
      const state = await ensureDashboard(projectRoot, port, {
        forceRestart: true,
      });
      const summary = describeDashboard(state);
      console.error(summary); // stderr so stdout stays clean for session-path capture
      appendLog(dir, "system", summary.replace(/^\W+\s*/, ""));
    } catch (e) {
      const msg = `dashboard start failed: ${(e as Error).message}`;
      console.error(`⚠ ${msg}`);
      appendLog(dir, "system", msg);
    }
  }

  return dir;
}

function updateSessionsIndex(projectRoot: string): void {
  const rumiRoot = projectRumiRoot(projectRoot);
  const sessions: { slug: string; path: string; url: string | null }[] = [];

  for (const slug of fs.readdirSync(rumiRoot)) {
    const sDir = path.join(rumiRoot, slug);
    if (!fs.statSync(sDir).isDirectory()) continue;
    const metaFile = path.join(sDir, "meta.json");
    if (!fs.existsSync(metaFile)) continue;
    let url: string | null = null;
    try {
      url = JSON.parse(fs.readFileSync(metaFile, "utf8")).url ?? null;
    } catch {}
    sessions.push({ slug, path: slug, url });
  }

  sessions.sort((a, b) => a.slug.localeCompare(b.slug));
  fs.writeFileSync(
    path.join(rumiRoot, "sessions.json"),
    JSON.stringify(sessions, null, 2) + "\n",
    "utf8",
  );
}
