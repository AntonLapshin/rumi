import fs from "node:fs";
import path from "node:path";
import { e2eDir } from "./paths.js";
import { Config } from "./config.js";
import { Action, isTypedAction, UseCase } from "./schema.js";

// Emit a Playwright spec for a use case.
//
// When every action is typed (Theme 3), the spec is generated deterministically —
// QA doesn't write any code, just runs it. When actions are still free prose
// (legacy), we fall back to the original scaffold with a TODO block so QA
// fills it in by hand.

export function scaffoldE2eSpec(
  sessionDir: string,
  uc: UseCase,
  url: string,
  config: Config,
): string {
  const dir = e2eDir(sessionDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${uc.id}.test.ts`);
  const body = renderSpec(uc, url, config);
  fs.writeFileSync(file, body, "utf8");
  return file;
}

function renderSpec(uc: UseCase, url: string, config: Config): string {
  const actions = uc.actions ?? [];
  const allTyped = actions.length > 0 && actions.every(isTypedAction);

  // When the first typed action is already a goto, skip the auto-goto to
  // avoid a redundant navigation.
  const skipAutoGoto =
    allTyped && actions.length > 0 && isTypedAction(actions[0]) && (actions[0] as { type: string }).type === "goto";

  const header = [
    `import { test, expect } from "@playwright/test";`,
    ``,
    `test.use({ actionTimeout: ${config.timeouts.playwrightActionMs}, navigationTimeout: ${config.timeouts.playwrightNavigationMs} });`,
    ``,
    `test(${JSON.stringify(uc.title)}, async ({ page }) => {`,
  ];
  if (!skipAutoGoto) header.push(`  await page.goto(${JSON.stringify(url)});`);

  const body = allTyped
    ? actions.map((a) => `  ${renderActionLine(a)}`).join("\n")
    : "  // TODO(qa): one Playwright step per entry in `actions`, in order.\n" +
      "  // Use locators derived from snapshots (getByRole/getByLabel/getByText).";

  return [...header, body, `});`, ``].join("\n");
}

export function renderActionLine(action: Action): string {
  if (!isTypedAction(action)) {
    return `// ${escapeComment(action)}`;
  }
  const a = action;
  switch (a.type) {
    case "goto":
      return `await page.goto(${JSON.stringify(a.url)});`;
    case "click":
      return `await page.getByRole(${JSON.stringify(a.role)}, { name: ${JSON.stringify(a.name)} }).click();`;
    case "fill":
      return `await page.getByLabel(${JSON.stringify(a.label)}).fill(${JSON.stringify(a.value)});`;
    case "press":
      return `await page.keyboard.press(${JSON.stringify(a.key)});`;
    case "wait_for_url":
      return `await page.waitForURL(new RegExp(${JSON.stringify(escapeRegex(a.url))}));`;
    case "expect_text":
      return `await expect(page.getByText(${JSON.stringify(a.text)})).toBeVisible();`;
    case "expect_role":
      return `await expect(page.getByRole(${JSON.stringify(a.role)}, { name: ${JSON.stringify(a.name)} })).toBeVisible();`;
  }
}

function escapeComment(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\*\//g, "* /");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
