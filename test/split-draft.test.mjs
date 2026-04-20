import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { splitDraft, draftPath } from "../dist/lib/split-draft.js";
import { listUseCaseFiles, readUseCase } from "../dist/lib/tests-io.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rumi-split-"));
}

function writeDraft(dir, draft) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(draftPath(dir), JSON.stringify(draft, null, 2), "utf8");
}

test("splitDraft writes one file per use case and deletes draft", () => {
  const dir = tmp();
  writeDraft(dir, {
    description: "d",
    useCases: [
      { name: "Sign in", description: "…", actions: ["A", "B"] },
      { name: "Sign out", description: "…", actions: ["C", "D"] },
    ],
  });
  const res = splitDraft(dir);
  assert.deepEqual(res.created.sort(), ["sign_in", "sign_out"]);
  assert.equal(res.skipped.length, 0);
  assert.equal(fs.existsSync(draftPath(dir)), false);

  const files = listUseCaseFiles(dir);
  assert.equal(files.length, 2);
  const uc = readUseCase(files[0]);
  assert.equal(uc.status, "pending");
  assert.equal(uc.reason, null);
});

test("splitDraft handles duplicate titles with unique ids", () => {
  const dir = tmp();
  writeDraft(dir, {
    description: "d",
    useCases: [
      { name: "Sign in", actions: ["a"] },
      { name: "sign in", actions: ["b"] },
    ],
  });
  const res = splitDraft(dir);
  assert.deepEqual(res.created.sort(), ["sign_in", "sign_in_2"]);
});

test("splitDraft is idempotent when tests already exist", () => {
  const dir = tmp();
  writeDraft(dir, {
    description: "",
    useCases: [{ name: "Keep", actions: ["a"] }],
  });
  splitDraft(dir);
  // Re-run: draft is gone now, so no-op.
  const again = splitDraft(dir);
  assert.deepEqual(again, { created: [], skipped: [] });

  // Re-create draft with an overlap; overlap should be skipped.
  writeDraft(dir, {
    description: "",
    useCases: [
      { name: "Keep", actions: ["a"] },
      { name: "New one", actions: ["b"] },
    ],
  });
  const third = splitDraft(dir);
  assert.deepEqual(third.created, ["new_one"]);
  assert.deepEqual(third.skipped, ["keep"]);
});

test("splitDraft rejects a use case with no actions", () => {
  const dir = tmp();
  writeDraft(dir, {
    description: "",
    useCases: [{ name: "Bad", actions: [] }],
  });
  assert.throws(() => splitDraft(dir));
});
