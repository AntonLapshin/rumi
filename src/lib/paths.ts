import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

export function urlSlug(raw: string): string {
  const u = new URL(raw);
  return slugify(u.host + u.pathname);
}

export function slugify(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!s) throw new Error(`slugify: nothing usable in "${raw}"`);
  return s;
}

export function projectRumiRoot(projectRoot: string): string {
  return path.join(projectRoot, "rumi");
}

export function sessionDir(projectRoot: string, url: string): string {
  return path.join(projectRumiRoot(projectRoot), urlSlug(url));
}

export function logsPath(sessionDir: string): string {
  return path.join(sessionDir, "logs.txt");
}

export function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

export function templateDir(): string {
  const root = packageRoot();
  const srcTemplates = path.join(root, "src", "templates");
  if (fs.existsSync(srcTemplates)) return srcTemplates;
  return path.join(root, "templates");
}

export function dashboardDir(): string {
  return path.join(packageRoot(), "dashboard");
}
