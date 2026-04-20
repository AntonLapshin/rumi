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
        // Max wall-clock for a single persona subprocess. 30 min covers a
        // deep QA pass with settling delays between ~10 actions.
        personaRunMs: z.number().int().min(60_000).default(1_800_000),
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
