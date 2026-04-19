import fs from "node:fs";
import path from "node:path";
import { e2eDir } from "./paths.js";
import { Config } from "./config.js";
import { UseCase } from "./schema.js";

// Emit a minimal @playwright/test spec with the right timeouts and goto()
// already in place. QA fills in the body (one step per entry in `actions`).
// Clobbered every time the use case is about to run so a stale half-written
// spec from a crashed prior attempt doesn't carry over.
export function scaffoldE2eSpec(
  sessionDir: string,
  uc: UseCase,
  url: string,
  config: Config,
): string {
  const dir = e2eDir(sessionDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${uc.id}.test.ts`);
  const body = [
    `import { test, expect } from "@playwright/test";`,
    ``,
    `test.use({ actionTimeout: ${config.timeouts.playwrightActionMs}, navigationTimeout: ${config.timeouts.playwrightNavigationMs} });`,
    ``,
    `test(${JSON.stringify(uc.title)}, async ({ page }) => {`,
    `  await page.goto(${JSON.stringify(url)});`,
    `  // TODO(qa): one Playwright step per entry in \`actions\`, in order.`,
    `  // Use locators derived from snapshots (getByRole/getByLabel/getByText).`,
    `});`,
    ``,
  ].join("\n");
  fs.writeFileSync(file, body, "utf8");
  return file;
}
