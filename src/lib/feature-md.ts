import fs from "node:fs";
import { featureDocPath } from "./paths.js";

// Deterministic feature.md handling. We own the section order and the
// skeleton so PM just fills each section — no prose-dictated formatting
// rules for the model to drift on.

export const FEATURE_SECTIONS = [
  "Summary",
  "Entry points",
  "Data model",
  "Primary flow",
  "Variants & edge cases",
  "External dependencies",
  "Known gaps / TODOs",
] as const;

// Sections that are always expected to have content.
const REQUIRED_SECTIONS: ReadonlyArray<string> = [
  "Summary",
  "Entry points",
  "Primary flow",
  "Variants & edge cases",
];

const PLACEHOLDER_RE = /^\s*<!--[^]*?-->\s*$/; // a lone html comment counts as empty

export function scaffoldFeatureMd(sessionDir: string, opts: { force?: boolean } = {}): string {
  const p = featureDocPath(sessionDir);
  if (!opts.force && fs.existsSync(p)) return p;
  const body = [
    "# <Feature Name>",
    "",
    "## Summary",
    "<!-- 2-4 sentences: what the feature is, who uses it, what outcome it produces. -->",
    "",
    "## Entry points",
    "<!-- UI routes/screens/buttons, API endpoints, CLI entries. Include file refs (path/to/file.ts:LINE). -->",
    "",
    "## Data model",
    "<!-- Tables / types / schemas read and written. One bullet per entity: name, key fields, lifecycle. -->",
    "",
    "## Primary flow",
    "<!-- Numbered happy-path steps. Name the component/function that performs each step (file ref). -->",
    "",
    "## Variants & edge cases",
    "<!-- One line each. Cover permission/role gating, validation, error surfaces, empty states, retries, timeouts, offline, feature flags. -->",
    "",
    "## External dependencies",
    "<!-- Third-party services, SDKs, webhooks, env vars (name + purpose, no secrets). -->",
    "",
    "## Known gaps / TODOs",
    "<!-- Literal TODO/FIXME comments or code that looks unfinished. -->",
    "",
  ].join("\n");
  fs.writeFileSync(p, body, "utf8");
  return p;
}

export interface FeatureMdProblem {
  section: string;
  issue: "missing" | "empty" | "out-of-order" | "unexpected";
}

export function lintFeatureMd(sessionDir: string): FeatureMdProblem[] {
  const p = featureDocPath(sessionDir);
  if (!fs.existsSync(p)) {
    return [{ section: "(file)", issue: "missing" }];
  }
  const text = fs.readFileSync(p, "utf8");
  const sections = parseSections(text);
  const problems: FeatureMdProblem[] = [];

  // Required sections present?
  for (const req of REQUIRED_SECTIONS) {
    const found = sections.find((s) => s.name === req);
    if (!found) {
      problems.push({ section: req, issue: "missing" });
    } else if (isEffectivelyEmpty(found.body)) {
      problems.push({ section: req, issue: "empty" });
    }
  }

  // Section order — present ones should appear in canonical order.
  const presentNames = sections.map((s) => s.name).filter((n) => FEATURE_SECTIONS.includes(n as typeof FEATURE_SECTIONS[number]));
  const canonicalFiltered = FEATURE_SECTIONS.filter((n) => presentNames.includes(n));
  for (let i = 0; i < presentNames.length; i++) {
    if (presentNames[i] !== canonicalFiltered[i]) {
      problems.push({ section: presentNames[i], issue: "out-of-order" });
      break; // one is enough to flag
    }
  }

  // Unexpected sections (not in canonical list).
  for (const s of sections) {
    if (!FEATURE_SECTIONS.includes(s.name as typeof FEATURE_SECTIONS[number])) {
      problems.push({ section: s.name, issue: "unexpected" });
    }
  }

  return problems;
}

function parseSections(text: string): { name: string; body: string }[] {
  const lines = text.split(/\r?\n/);
  const out: { name: string; body: string }[] = [];
  let current: { name: string; body: string[] } | null = null;
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (current) out.push({ name: current.name, body: current.body.join("\n") });
      current = { name: m[1].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) out.push({ name: current.name, body: current.body.join("\n") });
  return out;
}

function isEffectivelyEmpty(body: string): boolean {
  const stripped = body
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && !PLACEHOLDER_RE.test(l))
    .join("\n")
    .trim();
  return stripped === "";
}
