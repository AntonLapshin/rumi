import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldFeatureMd, lintFeatureMd } from "../dist/lib/feature-md.js";

function tmpSession() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rumi-test-"));
  return dir;
}

test("scaffold creates feature.md with all canonical sections", () => {
  const dir = tmpSession();
  const p = scaffoldFeatureMd(dir);
  const body = fs.readFileSync(p, "utf8");
  for (const section of [
    "## Summary",
    "## Entry points",
    "## Data model",
    "## Primary flow",
    "## Variants & edge cases",
    "## External dependencies",
    "## Known gaps / TODOs",
  ]) {
    assert.ok(body.includes(section), `missing ${section}`);
  }
});

test("scaffold does not overwrite existing file", () => {
  const dir = tmpSession();
  const p = scaffoldFeatureMd(dir);
  fs.writeFileSync(p, "# already there", "utf8");
  scaffoldFeatureMd(dir);
  assert.equal(fs.readFileSync(p, "utf8"), "# already there");
});

test("scaffold --force overwrites", () => {
  const dir = tmpSession();
  const p = scaffoldFeatureMd(dir);
  fs.writeFileSync(p, "# already there", "utf8");
  scaffoldFeatureMd(dir, { force: true });
  assert.ok(fs.readFileSync(p, "utf8").includes("## Summary"));
});

test("lint flags empty required sections", () => {
  const dir = tmpSession();
  scaffoldFeatureMd(dir);
  const problems = lintFeatureMd(dir);
  const names = problems.map((p) => `${p.section}:${p.issue}`);
  for (const s of ["Summary", "Entry points", "Primary flow", "Variants & edge cases"]) {
    assert.ok(names.includes(`${s}:empty`), `expected ${s}:empty in ${names.join(",")}`);
  }
});

test("lint passes when required sections filled", () => {
  const dir = tmpSession();
  const p = scaffoldFeatureMd(dir);
  fs.writeFileSync(
    p,
    [
      "# Widgets",
      "",
      "## Summary",
      "A thing.",
      "",
      "## Entry points",
      "- UI: /widgets",
      "",
      "## Primary flow",
      "1. go",
      "",
      "## Variants & edge cases",
      "- empty state",
      "",
    ].join("\n"),
    "utf8",
  );
  const problems = lintFeatureMd(dir);
  assert.deepEqual(problems, []);
});

test("lint flags unexpected sections and out-of-order", () => {
  const dir = tmpSession();
  const p = scaffoldFeatureMd(dir);
  fs.writeFileSync(
    p,
    [
      "# X",
      "## Entry points",
      "- /x",
      "## Summary",
      "hi",
      "## Primary flow",
      "1. step",
      "## Variants & edge cases",
      "- e",
      "## Appendix",
      "- extra",
    ].join("\n"),
    "utf8",
  );
  const problems = lintFeatureMd(dir);
  const issues = problems.map((p) => p.issue);
  assert.ok(issues.includes("out-of-order"));
  assert.ok(issues.includes("unexpected"));
});
