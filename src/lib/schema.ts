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

// Actions are intent-level prose. FEE writes what the user is trying to
// accomplish; QA opens the live page, snapshots it, picks the real locators,
// and writes the Playwright spec. There is no deterministic typed form —
// every use case goes through QA.
export const actionSchema = z.string();
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
