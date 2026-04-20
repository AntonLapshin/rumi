import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readUseCase, writeUseCase, listUseCaseFiles, isTerminal, testsDir } from "../dist/lib/tests-io.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rumi-uc-"));
}

test("writeUseCase round-trips through readUseCase", () => {
  const dir = tmp();
  const file = path.join(testsDir(dir), "foo.json");
  writeUseCase(file, {
    id: "foo",
    name: "Foo",
    description: "d",
    actions: ["a", "b"],
    status: "pending",
    reason: null,
    updatedAt: new Date().toISOString(),
  });
  const uc = readUseCase(file);
  assert.equal(uc.id, "foo");
  assert.equal(uc.status, "pending");
  assert.deepEqual(uc.actions, ["a", "b"]);
});

test("writeUseCase rejects missing required fields", () => {
  const dir = tmp();
  const file = path.join(testsDir(dir), "bad.json");
  assert.throws(() => writeUseCase(file, { name: "x" }));
});

test("listUseCaseFiles returns sorted .json paths only", () => {
  const dir = tmp();
  writeUseCase(path.join(testsDir(dir), "b.json"), { id: "b", name: "B" });
  writeUseCase(path.join(testsDir(dir), "a.json"), { id: "a", name: "A" });
  fs.writeFileSync(path.join(testsDir(dir), "note.txt"), "ignore", "utf8");
  const files = listUseCaseFiles(dir).map((p) => path.basename(p));
  assert.deepEqual(files, ["a.json", "b.json"]);
});

test("listUseCaseFiles returns [] when tests/ is absent", () => {
  const dir = tmp();
  assert.deepEqual(listUseCaseFiles(dir), []);
});

test("isTerminal classifies statuses", () => {
  assert.equal(isTerminal("passed"), true);
  assert.equal(isTerminal("failed"), true);
  assert.equal(isTerminal("blocked"), true);
  assert.equal(isTerminal("pending"), false);
  assert.equal(isTerminal("running"), false);
});
