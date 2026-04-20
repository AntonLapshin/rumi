import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldE2eSpec, renderActionLine } from "../dist/lib/e2e-scaffold.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rumi-e2e-"));
}

const config = {
  timeouts: { playwrightActionMs: 30000, playwrightNavigationMs: 60000 },
};

test("typed actions render a full deterministic spec", () => {
  const dir = tmp();
  const uc = {
    id: "sign_in",
    title: "Sign in",
    description: "User signs in with email.",
    actions: [
      { type: "goto", url: "https://example.com/login" },
      { type: "fill", label: "Email", value: "qa@example.com" },
      { type: "fill", label: "Password", value: "hunter2" },
      { type: "click", role: "button", name: "Sign in" },
      { type: "expect_text", text: "Welcome" },
    ],
  };
  const file = scaffoldE2eSpec(dir, uc, "https://example.com", config);
  const body = fs.readFileSync(file, "utf8");
  assert.ok(body.includes("page.getByLabel(\"Email\").fill(\"qa@example.com\")"));
  assert.ok(body.includes("page.getByRole(\"button\", { name: \"Sign in\" }).click()"));
  assert.ok(body.includes("expect(page.getByText(\"Welcome\")).toBeVisible()"));
  assert.ok(!body.includes("TODO(qa)"), "should not contain TODO when all actions typed");
});

test("prose actions fall back to TODO scaffold", () => {
  const dir = tmp();
  const uc = {
    id: "x",
    title: "X",
    description: "X.",
    actions: ["Click the foo", "Verify bar"],
  };
  const file = scaffoldE2eSpec(dir, uc, "https://example.com", config);
  const body = fs.readFileSync(file, "utf8");
  assert.ok(body.includes("TODO(qa)"));
});

test("mixed actions fall back to TODO (not partially rendered)", () => {
  const dir = tmp();
  const uc = {
    id: "x",
    title: "X",
    description: "X.",
    actions: [
      { type: "goto", url: "https://example.com" },
      "Click the custom widget", // prose
    ],
  };
  const file = scaffoldE2eSpec(dir, uc, "https://example.com", config);
  const body = fs.readFileSync(file, "utf8");
  assert.ok(body.includes("TODO(qa)"));
});

test("renderActionLine — each type", () => {
  assert.equal(
    renderActionLine({ type: "goto", url: "https://x.test/" }),
    `await page.goto("https://x.test/");`,
  );
  assert.equal(
    renderActionLine({ type: "click", role: "link", name: "Home" }),
    `await page.getByRole("link", { name: "Home" }).click();`,
  );
  assert.equal(
    renderActionLine({ type: "press", key: "Enter" }),
    `await page.keyboard.press("Enter");`,
  );
  assert.equal(
    renderActionLine({ type: "expect_role", role: "heading", name: "Hi" }),
    `await expect(page.getByRole("heading", { name: "Hi" })).toBeVisible();`,
  );
});

test("wait_for_url escapes regex metacharacters", () => {
  const line = renderActionLine({ type: "wait_for_url", url: "/app/home?tab=1" });
  // `?` is a regex metachar and should be escaped; `=` is not.
  assert.ok(line.includes("\\?"), `expected \\? in: ${line}`);
  assert.ok(line.includes("new RegExp("), `expected RegExp wrapper in: ${line}`);
});
