import { z } from "zod";

export const useCaseStatusSchema = z.enum([
  "draft",
  "ready",
  "testing",
  "passed",
  "failed",
  "blocked",
]);
export type UseCaseStatus = z.infer<typeof useCaseStatusSchema>;

// Typed actions (Theme 3). A small, closed set of discriminated objects that
// can be:
//   1. Translated 1:1 to a playwright-cli invocation at runtime (`rumi exec-action`).
//   2. Emitted as a single line of @playwright/test code deterministically.
// This removes two layers of LLM judgment (selector strategy + code
// generation) — smaller models can just pick the shape that matches the step.
//
// The legacy free-prose string form is still accepted so in-flight sessions
// from the previous schema don't break.
export const actionObjectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("goto"), url: z.string().url() }),
  z.object({ type: z.literal("click"), role: z.string().min(1), name: z.string().min(1) }),
  z.object({ type: z.literal("fill"), label: z.string().min(1), value: z.string() }),
  z.object({ type: z.literal("press"), key: z.string().min(1) }),
  z.object({ type: z.literal("wait_for_url"), url: z.string().min(1) }),
  z.object({ type: z.literal("expect_text"), text: z.string().min(1) }),
  z.object({ type: z.literal("expect_role"), role: z.string().min(1), name: z.string().min(1) }),
]);
export type ActionObject = z.infer<typeof actionObjectSchema>;

export const actionSchema = z.union([z.string(), actionObjectSchema]);
export type Action = z.infer<typeof actionSchema>;

export const useCaseSchema = z.object({
  // `id` is normalized from `title` by the orchestrator after every persona
  // run; personas may leave it empty/stale and it will be regenerated.
  id: z.string().default(""),
  title: z.string().min(1),
  description: z.string().min(1),
  actions: z.array(actionSchema).optional(),
  status: useCaseStatusSchema.optional(),
  reason: z.string().optional(),
});
export type UseCase = z.infer<typeof useCaseSchema>;

export const sessionStatusSchema = z.enum([
  "initialized",
  "scoping",
  "ready",
  "testing",
  "complete",
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const sessionSchema = z.object({
  url: z.string().url(),
  description: z.string(),
  status: sessionStatusSchema,
  useCases: z.array(useCaseSchema),
  createdAt: z.string(),
});
export type Session = z.infer<typeof sessionSchema>;

export function emptySession(url: string): Session {
  return {
    url,
    description: "",
    status: "initialized",
    useCases: [],
    createdAt: new Date().toISOString(),
  };
}

// Helpers for working with the union.
export function isTypedAction(a: Action): a is ActionObject {
  return typeof a === "object" && a !== null && "type" in (a as object);
}

export function actionSummary(a: Action): string {
  if (typeof a === "string") return a;
  switch (a.type) {
    case "goto":          return `Navigate to ${a.url}`;
    case "click":         return `Click ${a.role} "${a.name}"`;
    case "fill":          return `Fill "${a.label}" with "${a.value}"`;
    case "press":         return `Press ${a.key}`;
    case "wait_for_url":  return `Wait for URL ~= ${a.url}`;
    case "expect_text":   return `Expect text "${a.text}"`;
    case "expect_role":   return `Expect ${a.role} "${a.name}" visible`;
  }
}
