import fs from "node:fs";
import http from "node:http";
import path from "node:path";

// Serves the dashboard. Static assets (index.html, app.js, style.css) are
// baked into the image at /opt/rumi/dashboard; session artefacts
// (sessions.json, <slug>/session.json, <slug>/logs.txt, <slug>/e2e/*.test.ts)
// come from the bind-mounted host project at /work/rumi.

export const DASHBOARD_MARKER = "rumi dashboard";

const STATIC_NAMES = new Set(["index.html", "app.js", "style.css"]);

export interface DashboardServerOptions {
  port: number;
  assetsDir: string; // e.g. /opt/rumi/dashboard
  dataDir: string;  // e.g. /work/rumi
}

export function startDashboardServer(opts: DashboardServerOptions): http.Server {
  const { port, assetsDir, dataDir } = opts;

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (rel === "" || rel === "index.html") rel = "index.html";

      if (STATIC_NAMES.has(rel)) {
        return sendFile(res, path.join(assetsDir, rel));
      }

      // Dynamic/mounted: sessions.json, <slug>/session.json, <slug>/logs.txt, <slug>/e2e/*.test.ts
      const safe = path.normalize(rel);
      if (safe.startsWith("..") || path.isAbsolute(safe)) {
        res.statusCode = 400;
        return res.end("bad path");
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
