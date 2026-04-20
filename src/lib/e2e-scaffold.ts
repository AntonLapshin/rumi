import fs from "node:fs";
import path from "node:path";
import { e2eDir } from "./paths.js";
import { Config } from "./config.js";
import { UseCase } from "./schema.js";

// Emit a Playwright stub for a use case. Actions are intent-level prose —
// QA opens the live page, discovers real locators via snapshots, and fills
// in the TODO block below with exact getByRole/getByLabel/getByText calls.

export function scaffoldE2eSpec(
  sessionDir: string,
  uc: UseCase,
  url: string,
  config: Config,
): string {
  const dir = e2eDir(sessionDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${uc.id}.test.ts`);
  fs.writeFileSync(file, renderSpec(uc, url, config), "utf8");
  return file;
}

function renderSpec(uc: UseCase, url: string, config: Config): string {
  const actions = uc.actions ?? [];
  const intentList = actions.length === 0
    ? "  //   (no actions listed on this use case)"
    : actions.map((a, i) => `  //   ${i + 1}. ${escapeComment(a)}`).join("\n");

  return [
    `import { test, expect } from "@playwright/test";`,
    ``,
    `test.use({ actionTimeout: ${config.timeouts.playwrightActionMs}, navigationTimeout: ${config.timeouts.playwrightNavigationMs} });`,
    ``,
    `test(${JSON.stringify(uc.title)}, async ({ page }) => {`,
    // Per-test timeout (Playwright's default is 30s). Lifts the whole-test
    // ceiling above the sum of per-action budgets so a multi-step test
    // doesn't time out while individual actions are still within budget.
    `  test.setTimeout(${config.timeouts.playwrightTestMs});`,
    `  await page.goto(${JSON.stringify(url)});`,
    `  // TODO(qa): one Playwright step per intent below, in order. Use locators`,
    `  // derived from a live snapshot (getByRole/getByLabel/getByText). After`,
    `  // navigations, wait for URL or a landmark element before asserting.`,
    `  //`,
    `  // Intent steps:`,
    intentList,
    `});`,
    ``,
  ].join("\n");
}

function escapeComment(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\*\//g, "* /");
}
