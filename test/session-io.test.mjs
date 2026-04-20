import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSession, writeSession, tryReadSession } from "../dist/lib/session-io.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rumi-io-"));
}

function make(url = "https://example.com") {
  return {
    url,
    description: "",
    status: "initialized",
    useCases: [],
    createdAt: new Date().toISOString(),
  };
}

test("writeSession creates .bak on second write", () => {
  const dir = tmp();
  writeSession(dir, make());
  writeSession(dir, { ...make(), description: "v2" });
  assert.ok(fs.existsSync(path.join(dir, "session.json.bak")));
});

test("readSession falls back to .bak on corrupt primary", () => {
  // .bak always holds the previous valid state. After three writes, .bak is
  // the second write ("good"), which is what we should recover when the
  // third (live) file is corrupted.
  const dir = tmp();
  writeSession(dir, make("https://example.com"));
  writeSession(dir, { ...make("https://example.com"), description: "good" });
  writeSession(dir, { ...make("https://example.com"), description: "newest" });
  fs.writeFileSync(path.join(dir, "session.json"), "corrupt", "utf8");
  const s = readSession(dir);
  assert.equal(s.description, "good");
});

test("tryReadSession returns null for missing", () => {
  const dir = tmp();
  assert.equal(tryReadSession(dir), null);
});

test("writeSession rejects invalid shape", () => {
  const dir = tmp();
  assert.throws(() => writeSession(dir, { url: "not-a-url" }));
});
