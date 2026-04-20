import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const useCaseStatusSchema = z.enum([
  "pending",
  "running",
  "passed",
  "failed",
  "blocked",
]);
export type UseCaseStatus = z.infer<typeof useCaseStatusSchema>;

export const useCaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  actions: z.array(z.string()).default([]),
  status: useCaseStatusSchema.default("pending"),
  reason: z.string().nullable().default(null),
  updatedAt: z.string().default(() => new Date().toISOString()),
});
export type UseCase = z.infer<typeof useCaseSchema>;

export function testsDir(sessionDir: string): string {
  return path.join(sessionDir, "tests");
}

export function useCaseFile(sessionDir: string, id: string): string {
  return path.join(testsDir(sessionDir), `${id}.json`);
}

export function readUseCase(file: string): UseCase {
  const raw = fs.readFileSync(file, "utf8");
  return useCaseSchema.parse(JSON.parse(raw));
}

export function writeUseCase(file: string, uc: UseCase): void {
  const validated = useCaseSchema.parse({
    ...uc,
    updatedAt: new Date().toISOString(),
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(validated, null, 2) + "\n", "utf8");
}

export function listUseCaseFiles(sessionDir: string): string[] {
  const dir = testsDir(sessionDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(dir, f))
    .sort();
}

export function isTerminal(status: UseCaseStatus): boolean {
  return status === "passed" || status === "failed" || status === "blocked";
}
