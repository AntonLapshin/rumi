import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { projectRumiRoot } from "./paths.js";

export const configSchema = z
  .object({
    dashboardPort: z.number().int().min(1).max(65535).default(3737),
    runner: z.enum(["claude", "opencode"]).nullable().default(null),
    timeouts: z
      .object({
        personaRunMs: z.number().int().min(60_000).default(1_800_000),
        playwrightActionMs: z.number().int().min(1_000).default(30_000),
        playwrightNavigationMs: z.number().int().min(1_000).default(60_000),
        // Per-test timeout baked into generated specs via `test.setTimeout`.
        // Playwright's default is 30s — way too tight once a test has 5+
        // actions at 30s each, even when most pass quickly. 3 min gives
        // headroom for SPA hydration and network jitter without hiding
        // genuine failures.
        playwrightTestMs: z.number().int().min(30_000).default(180_000),
      })
      .default({}),
  })
  .default({});
export type Config = z.infer<typeof configSchema>;

export function configPath(projectRoot: string): string {
  return path.join(projectRumiRoot(projectRoot), "config.json");
}

export function readConfig(projectRoot: string): Config {
  const p = configPath(projectRoot);
  if (!fs.existsSync(p)) return configSchema.parse(undefined);
  try {
    return configSchema.parse(JSON.parse(fs.readFileSync(p, "utf8")));
  } catch (e) {
    console.warn(`⚠ rumi/config.json invalid (${(e as Error).message}); using defaults`);
    return configSchema.parse(undefined);
  }
}

export function writeDefaultConfigIfMissing(projectRoot: string): boolean {
  const p = configPath(projectRoot);
  if (fs.existsSync(p)) return false;
  fs.mkdirSync(projectRumiRoot(projectRoot), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(configSchema.parse(undefined), null, 2) + "\n", "utf8");
  return true;
}
