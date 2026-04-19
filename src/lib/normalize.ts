import { Session, UseCase } from "./schema.js";
import { slugify } from "./paths.js";

// Deterministic post-processing the orchestrator applies after every persona
// run. Personas only produce the creative fields (title, description, actions,
// reason, terminal status). Everything mechanical — ids, uniqueness, session
// status transitions, promoting use cases from "has actions" to "ready" — is
// enforced here so prompts don't have to specify it.
export function normalize(s: Session): Session {
  for (const uc of s.useCases) normalizeUseCase(uc);
  reassignIds(s.useCases);
  normalizeTopStatus(s);
  return s;
}

function normalizeUseCase(uc: UseCase): void {
  // Promote use cases that have actions to "ready" unless already in a later
  // state. Preserves terminal statuses (passed/failed/blocked) and transient
  // "testing" so a leftover mid-run state is retried, not overwritten.
  const hasActions = (uc.actions?.length ?? 0) > 0;
  if (!hasActions) return;
  if (!uc.status || uc.status === "draft") uc.status = "ready";
}

function reassignIds(useCases: UseCase[]): void {
  const used = new Set<string>();
  for (const uc of useCases) {
    if (!uc.title || uc.title.trim() === "") continue;
    const base = slugify(uc.title);
    let id = base;
    let n = 1;
    while (used.has(id)) {
      n++;
      id = `${base}_${n}`;
    }
    used.add(id);
    uc.id = id;
  }
}

function normalizeTopStatus(s: Session): void {
  if (s.useCases.length === 0) {
    s.status = s.description.trim() === "" ? "initialized" : "scoping";
    return;
  }
  const terminal = (uc: UseCase) =>
    uc.status === "passed" || uc.status === "failed" || uc.status === "blocked";
  const allTerminal = s.useCases.every(terminal);
  if (allTerminal) {
    s.status = "complete";
    return;
  }
  const anyTesting = s.useCases.some((uc) => uc.status === "testing");
  if (anyTesting) {
    s.status = "testing";
    return;
  }
  const allHaveActions = s.useCases.every((uc) => (uc.actions?.length ?? 0) > 0);
  if (allHaveActions) {
    s.status = "ready";
    return;
  }
  s.status = "scoping";
}
