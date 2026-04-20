import fs from "node:fs";
import path from "node:path";
import { readSession, writeSession } from "../lib/session-io.js";
import { normalize } from "../lib/normalize.js";
import { projectRumiRoot, slugify } from "../lib/paths.js";
import { appendLog, appendLogEvent } from "../lib/logger.js";
import {
  Action,
  ActionObject,
  actionObjectSchema,
  Session,
  UseCase,
  useCaseStatusSchema,
} from "../lib/schema.js";
import { lintFeatureMd, scaffoldFeatureMd } from "../lib/feature-md.js";

// Narrow, CLI-driven mutations on session.json. Personas call these instead
// of editing the JSON file by hand — schema is enforced by the CLI, not by
// the model, so a small model can't produce a malformed session.

export interface BaseOpts {
  sessionDir?: string;
  projectRoot?: string;
  persona?: string; // for logging
}

function resolveSessionDir(opts: BaseOpts): string {
  if (opts.sessionDir) return opts.sessionDir;
  const envDir = process.env.RUMI_SESSION;
  if (envDir) return envDir;
  const dir = newestSession(opts.projectRoot ?? process.cwd());
  if (!dir) {
    throw new Error(
      "No active QA session found. Pass --session, set RUMI_SESSION, or run `rumi init` first.",
    );
  }
  return dir;
}

function newestSession(projectRoot: string): string | null {
  const root = projectRumiRoot(projectRoot);
  if (!fs.existsSync(root)) return null;
  let newest: { dir: string; mtime: number } | null = null;
  for (const slug of fs.readdirSync(root)) {
    const dir = path.join(root, slug);
    if (!fs.statSync(dir).isDirectory()) continue;
    const sj = path.join(dir, "session.json");
    if (!fs.existsSync(sj)) continue;
    const m = fs.statSync(sj).mtimeMs;
    if (!newest || m > newest.mtime) newest = { dir, mtime: m };
  }
  return newest?.dir ?? null;
}

function mutate(opts: BaseOpts, fn: (s: Session) => void): Session {
  const dir = resolveSessionDir(opts);
  const s = readSession(dir);
  fn(s);
  const normalized = normalize(s);
  writeSession(dir, normalized);
  return normalized;
}

function logAction(opts: BaseOpts, msg: string): void {
  try {
    const dir = resolveSessionDir(opts);
    appendLog(dir, opts.persona ?? process.env.RUMI_ROLE ?? "system", msg);
  } catch {
    // logging best-effort
  }
}

function logEvent(
  opts: BaseOpts,
  event: string,
  message: string,
  fields?: Record<string, unknown>,
): void {
  try {
    const dir = resolveSessionDir(opts);
    appendLogEvent(
      dir,
      opts.persona ?? process.env.RUMI_ROLE ?? "system",
      event,
      message,
      fields,
    );
  } catch {
    // best-effort
  }
}

function findUseCase(s: Session, id: string): UseCase {
  const uc = s.useCases.find((u) => u.id === id);
  if (!uc) {
    const known = s.useCases.map((u) => u.id).join(", ") || "(none)";
    throw new Error(`Use case not found: "${id}". Known ids: ${known}`);
  }
  return uc;
}

// --- set-description -------------------------------------------------------

export function runSetDescription(text: string, opts: BaseOpts = {}): void {
  if (!text || text.trim() === "") throw new Error("description is empty");
  mutate(opts, (s) => {
    s.description = text.trim();
  });
  logEvent(opts, "set-description", `set description (${text.length} chars)`, {
    length: text.length,
  });
  console.log("ok");
}

// --- add-use-case ----------------------------------------------------------

export interface AddUseCaseOpts extends BaseOpts {
  title: string;
  description: string;
}

export function runAddUseCase(opts: AddUseCaseOpts): void {
  const title = opts.title?.trim();
  const description = opts.description?.trim();
  if (!title) throw new Error("--title is required");
  if (!description) throw new Error("--description is required");

  let assignedId = "";
  mutate(opts, (s) => {
    // Reject near-duplicates so personas don't append "user login" twice.
    const want = slugify(title);
    const existing = s.useCases.find((u) => slugify(u.title) === want);
    if (existing) {
      assignedId = existing.id || want;
      return; // no-op; already present
    }
    const uc: UseCase = { id: "", title, description };
    s.useCases.push(uc);
    // normalize() will assign the id from title.
  });
  // Re-read to get the normalized id.
  const dir = resolveSessionDir(opts);
  if (!assignedId) {
    const s = readSession(dir);
    const uc = s.useCases.find((u) => slugify(u.title) === slugify(title));
    assignedId = uc?.id ?? slugify(title);
  }
  logEvent(opts, "add-use-case", `add-use-case ${assignedId}: ${title}`, {
    id: assignedId,
    title,
  });
  console.log(assignedId);
}

// --- add-action ------------------------------------------------------------

export interface AddActionOpts extends BaseOpts {
  useCaseId: string;
  // Either a free-text prose step (legacy) or a typed action object.
  text?: string;
  typed?: ActionObject;
}

const ACTION_MIN = 5;
const ACTION_MAX = 15;

export function runAddAction(opts: AddActionOpts): void {
  const action: Action | null = opts.typed
    ? (actionObjectSchema.parse(opts.typed) as Action)
    : opts.text
      ? opts.text.trim()
      : null;
  if (!action) throw new Error("provide either a text step or a --<type> flag");
  if (typeof action === "string" && action.length > 300) {
    throw new Error("action too long (>300 chars); tighten it");
  }

  let summary = "";
  mutate(opts, (s) => {
    const uc = findUseCase(s, opts.useCaseId);
    uc.actions = [...(uc.actions ?? []), action];
    if (uc.actions.length > ACTION_MAX) {
      throw new Error(
        `use case "${opts.useCaseId}" has ${uc.actions.length} actions; cap is ${ACTION_MAX}`,
      );
    }
    summary = typeof action === "string" ? action : `[${action.type}]`;
  });
  logEvent(opts, "add-action", `add-action ${opts.useCaseId}: ${summary}`, {
    useCaseId: opts.useCaseId,
    typed: typeof action !== "string",
    type: typeof action === "string" ? null : action.type,
  });
  console.log("ok");
}

// --- set-actions (bulk replace from JSON array) ----------------------------

export interface SetActionsOpts extends BaseOpts {
  useCaseId: string;
  // Either strings or typed action objects. The union is validated against
  // actionSchema on write.
  actions: Action[];
}

export function runSetActions(opts: SetActionsOpts): void {
  const actions: Action[] = (opts.actions ?? [])
    .map((a) => (typeof a === "string" ? a.trim() : a))
    .filter((a) => (typeof a === "string" ? a.length > 0 : true));
  if (actions.length < ACTION_MIN || actions.length > ACTION_MAX) {
    throw new Error(
      `need ${ACTION_MIN}–${ACTION_MAX} actions, got ${actions.length}`,
    );
  }
  mutate(opts, (s) => {
    const uc = findUseCase(s, opts.useCaseId);
    uc.actions = actions;
  });
  logEvent(opts, "set-actions", `set-actions ${opts.useCaseId}: ${actions.length} steps`, {
    useCaseId: opts.useCaseId,
    count: actions.length,
  });
  console.log("ok");
}

// --- record-result ---------------------------------------------------------

export interface RecordResultOpts extends BaseOpts {
  useCaseId: string;
  status: string;
  reason?: string;
}

export function runRecordResult(opts: RecordResultOpts): void {
  const status = useCaseStatusSchema.parse(opts.status); // rejects unknowns
  if ((status === "failed" || status === "blocked") && !opts.reason?.trim()) {
    throw new Error(`--reason is required for status "${status}"`);
  }
  mutate(opts, (s) => {
    const uc = findUseCase(s, opts.useCaseId);
    uc.status = status;
    if (status === "passed") {
      delete uc.reason;
    } else if (opts.reason) {
      uc.reason = opts.reason.trim();
    }
  });
  logEvent(
    opts,
    "record-result",
    `${opts.useCaseId}: ${status}${opts.reason ? ` — ${opts.reason}` : ""}`,
    { useCaseId: opts.useCaseId, status, reason: opts.reason ?? null },
  );
  console.log("ok");
}

// --- dump (read helper) ----------------------------------------------------

export interface DumpOpts extends BaseOpts {
  useCaseId?: string;
  fields?: string[]; // filter top-level fields or use case fields
}

export function runDump(opts: DumpOpts = {}): void {
  const dir = resolveSessionDir(opts);
  const s = readSession(dir);
  if (opts.useCaseId) {
    const uc = findUseCase(s, opts.useCaseId);
    console.log(JSON.stringify(project(uc, opts.fields), null, 2));
    return;
  }
  const base: Record<string, unknown> = project(s, opts.fields);
  console.log(JSON.stringify(base, null, 2));
}

function project<T extends Record<string, unknown>>(obj: T, fields?: string[]): Record<string, unknown> {
  if (!fields || fields.length === 0) return obj;
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f in obj) out[f] = (obj as Record<string, unknown>)[f];
  return out;
}

// --- feature.md helpers ----------------------------------------------------

export function runScaffoldFeatureMd(opts: BaseOpts & { force?: boolean } = {}): void {
  const dir = resolveSessionDir(opts);
  const p = scaffoldFeatureMd(dir, { force: opts.force });
  console.log(p);
}

export function runLintFeatureMd(opts: BaseOpts = {}): void {
  const dir = resolveSessionDir(opts);
  const problems = lintFeatureMd(dir);
  if (problems.length === 0) {
    console.log("ok");
    return;
  }
  for (const p of problems) console.error(`- ${p.section}: ${p.issue}`);
  process.exit(1);
}

// --- validate (human-/CI-facing) -------------------------------------------

export function runValidate(opts: BaseOpts = {}): void {
  const dir = resolveSessionDir(opts);
  const s = readSession(dir);
  const problems: string[] = [];
  if (!s.description) problems.push("description is empty");
  if (s.useCases.length === 0) problems.push("no use cases");
  for (const uc of s.useCases) {
    if (!uc.title) problems.push(`use case ${uc.id}: empty title`);
    if (!uc.description) problems.push(`use case ${uc.id}: empty description`);
    if (uc.actions && (uc.actions.length < ACTION_MIN || uc.actions.length > ACTION_MAX)) {
      problems.push(
        `use case ${uc.id}: ${uc.actions.length} actions (expected ${ACTION_MIN}–${ACTION_MAX})`,
      );
    }
  }
  if (problems.length === 0) {
    console.log("ok");
    return;
  }
  for (const p of problems) console.error(`- ${p}`);
  process.exit(1);
}
