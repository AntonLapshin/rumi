import fs from "node:fs";
import path from "node:path";
import {
  projectRumiRoot,
  sessionDir,
} from "../lib/paths.js";
import { emptySession, Session } from "../lib/schema.js";
import { writeSession, tryReadSession } from "../lib/session-io.js";
import { appendLog } from "../lib/logger.js";
import { describeDashboard, ensureDashboard } from "./serve.js";
import { readConfig, writeDefaultConfigIfMissing } from "../lib/config.js";
import { normalize } from "../lib/normalize.js";

export interface InitOptions {
  projectRoot?: string;
  startDashboard?: boolean;
  dashboardPort?: number;
}

export async function runInit(url: string, opts: InitOptions = {}): Promise<string> {
  try {
    new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  const projectRoot = opts.projectRoot ?? process.cwd();
  const dir = sessionDir(projectRoot, url);
  fs.mkdirSync(dir, { recursive: true });

  const existing = tryReadSession(dir);
  if (!existing) {
    writeSession(dir, emptySession(url));
    appendLog(dir, "system", `session created for ${url} at ${dir}`);
  } else {
    const revived = reviveBlocked(existing);
    if (revived.count > 0) {
      writeSession(dir, normalize(revived.session));
      appendLog(
        dir,
        "system",
        `session resumed (status=${existing.status}, useCases=${existing.useCases.length}); requeued ${revived.count} blocked use case(s)`,
      );
    } else {
      appendLog(dir, "system", `session resumed (status=${existing.status}, useCases=${existing.useCases.length})`);
    }
  }

  updateSessionsIndex(projectRoot);

  if (writeDefaultConfigIfMissing(projectRoot)) {
    appendLog(dir, "system", "wrote default rumi/config.json");
  }

  if (opts.startDashboard !== false) {
    const port = opts.dashboardPort ?? readConfig(projectRoot).dashboardPort;
    try {
      // `rumi init` is the entry point for every `/rumi URL` invocation —
      // restart the dashboard so each session starts against a fresh process
      // (picks up any dashboard asset changes, clears stale server state).
      const state = await ensureDashboard(projectRoot, port, { forceRestart: true });
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

// Re-running `/rumi` on a URL means the user wants another pass. Blocked use
// cases usually reflect environmental problems (URL unreachable, QA crashed,
// timeouts) rather than real product defects — requeue them so QA retries
// on the fresh run. `failed` stays as-is; that's a real assertion failure
// the user should look at before re-running.
function reviveBlocked(s: Session): { session: Session; count: number } {
  let count = 0;
  for (const uc of s.useCases) {
    if (uc.status === "blocked") {
      uc.status = (uc.actions?.length ?? 0) > 0 ? "ready" : "draft";
      delete uc.reason;
      count++;
    }
  }
  return { session: s, count };
}

function updateSessionsIndex(projectRoot: string) {
  const rumiRoot = projectRumiRoot(projectRoot);
  const sessions: { slug: string; path: string; url: string | null }[] = [];

  for (const slug of fs.readdirSync(rumiRoot)) {
    const sDir = path.join(rumiRoot, slug);
    if (!fs.statSync(sDir).isDirectory()) continue;
    const sj = path.join(sDir, "session.json");
    if (!fs.existsSync(sj)) continue;
    let url: string | null = null;
    try {
      url = JSON.parse(fs.readFileSync(sj, "utf8")).url ?? null;
    } catch {}
    sessions.push({ slug, path: slug, url });
  }

  sessions.sort((a, b) => a.slug.localeCompare(b.slug));
  fs.writeFileSync(path.join(rumiRoot, "sessions.json"), JSON.stringify(sessions, null, 2) + "\n", "utf8");
}
