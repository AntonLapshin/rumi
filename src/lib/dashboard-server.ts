import fs from "node:fs";
import http from "node:http";
import path from "node:path";

// Serves the dashboard. Static assets (index.html, app.js, style.css) come
// from the package's dashboard/ directory; session artefacts
// (sessions.json, <slug>/meta.json, <slug>/tests/*.json, <slug>/logs.jsonl)
// come from the project's rumi/ directory.

export const DASHBOARD_MARKER = "rumi dashboard";

const STATIC_NAMES = new Set(["index.html", "app.js", "style.css"]);

export interface DashboardServerOptions {
  port: number;
  assetsDir: string;
  dataDir: string;
}

export function startDashboardServer(opts: DashboardServerOptions): http.Server {
  const { port, assetsDir, dataDir } = opts;

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (rel === "" || rel === "index.html") rel = "index.html";

      if (rel === "__shutdown") {
        const remote = req.socket.remoteAddress ?? "";
        if (req.method !== "POST" || !isLoopback(remote)) {
          res.statusCode = 403;
          return res.end("forbidden");
        }
        res.end("ok");
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1000).unref();
        return;
      }

      if (STATIC_NAMES.has(rel)) {
        return sendFile(res, path.join(assetsDir, rel));
      }

      const safe = path.normalize(rel);
      if (safe.startsWith("..") || path.isAbsolute(safe)) {
        res.statusCode = 400;
        return res.end("bad path");
      }

      // Dynamic: <slug>/tests-index.json — generated from the directory listing.
      const idxMatch = safe.match(/^([^/]+)\/tests-index\.json$/);
      if (idxMatch) {
        return sendTestsIndex(res, path.join(dataDir, idxMatch[1]));
      }

      return sendFile(res, path.join(dataDir, safe));
    } catch (e) {
      res.statusCode = 500;
      res.end(String((e as Error).message));
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`${DASHBOARD_MARKER} listening on :${port}  (assets=${assetsDir} data=${dataDir})`);
  });

  return server;
}

function sendTestsIndex(res: http.ServerResponse, sessionDir: string): void {
  const dir = path.join(sessionDir, "tests");
  const files: string[] = [];
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".json")) files.push(name);
    }
    files.sort();
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ files }));
}

function sendFile(res: http.ServerResponse, filePath: string): void {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.statusCode = 404;
      return res.end("not found");
    }
    res.setHeader("Content-Type", contentType(filePath));
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(filePath).pipe(res);
  });
}

function isLoopback(addr: string): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html": return "text/html; charset=utf-8";
    case ".js":   return "text/javascript; charset=utf-8";
    case ".css":  return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".txt":  return "text/plain; charset=utf-8";
    case ".ts":   return "text/plain; charset=utf-8";
    default:      return "application/octet-stream";
  }
}
