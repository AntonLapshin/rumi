import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldE2eSpec } from "../dist/lib/e2e-scaffold.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rumi-e2e-"));
}

const config = {
  timeouts: {
    playwrightActionMs: 30000,
    playwrightNavigationMs: 60000,
    playwrightTestMs: 180000,
  },
};

test("prose actions produce a QA-fillable stub with intent list", () => {
  const dir = tmp();
  const uc = {
    id: "sign_in",
    title: "Sign in",
    description: "User signs in with email.",
    actions: [
      "Open the sign-in entry point",
      "Provide credentials in the sign-in form",
      "Submit the form and confirm the landing page loads",
    ],
  };
  const file = scaffoldE2eSpec(dir, uc, "https://example.com", config);
  const body = fs.readFileSync(file, "utf8");
  assert.ok(body.includes("test.setTimeout(180000)"), "should set per-test timeout");
  assert.ok(body.includes(`await page.goto("https://example.com")`), "should emit page.goto with session URL");
  assert.ok(body.includes("TODO(qa)"), "should leave a TODO(qa) block for QA to fill");
  assert.ok(body.includes("Intent steps:"), "should include the intent list");
  for (const step of uc.actions) {
    assert.ok(body.includes(step), `intent list should quote: ${step}`);
  }
});

test("empty actions still emit a valid stub", () => {
  const dir = tmp();
  const uc = { id: "x", title: "X", description: "X.", actions: [] };
  const file = scaffoldE2eSpec(dir, uc, "https://example.com", config);
  const body = fs.readFileSync(file, "utf8");
  assert.ok(body.includes("TODO(qa)"));
  assert.ok(body.includes("(no actions listed on this use case)"));
});

test("intent steps containing '*/' are escaped so they don't break the comment block", () => {
  const dir = tmp();
  const uc = {
    id: "x",
    title: "X",
    description: "X.",
    actions: ["Open a regex */ style prompt"],
  };
  const file = scaffoldE2eSpec(dir, uc, "https://example.com", config);
  const body = fs.readFileSync(file, "utf8");
  assert.ok(!body.includes("*/"), "raw */ should be rewritten to avoid closing an unintended comment");
});
