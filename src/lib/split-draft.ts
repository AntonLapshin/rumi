import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { slugify } from "./paths.js";
import { testsDir, writeUseCase } from "./tests-io.js";

// FEE writes draft.json in one shot. The orchestrator splits it into one file
// per use case under tests/, then deletes the draft so resume doesn't resplit.
export const draftUseCaseSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  actions: z.array(z.string().min(1)).min(1),
});

export const draftSchema = z.object({
  description: z.string().default(""),
  useCases: z.array(draftUseCaseSchema).min(1),
});
export type Draft = z.infer<typeof draftSchema>;

export function draftPath(sessionDir: string): string {
  return path.join(sessionDir, "draft.json");
}

export interface SplitResult {
  created: string[];
  skipped: string[];
}

export function splitDraft(sessionDir: string): SplitResult {
  const file = draftPath(sessionDir);
  if (!fs.existsSync(file)) return { created: [], skipped: [] };

  const draft = draftSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  fs.mkdirSync(testsDir(sessionDir), { recursive: true });

  const created: string[] = [];
  const skipped: string[] = [];
  const usedIds = new Set<string>();

  for (const uc of draft.useCases) {
    let id = slugify(uc.name);
    const base = id;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${base}_${suffix++}`;
    }
    usedIds.add(id);

    const out = path.join(testsDir(sessionDir), `${id}.json`);
    if (fs.existsSync(out)) {
      skipped.push(id);
      continue;
    }
    writeUseCase(out, {
      id,
      name: uc.name,
      description: uc.description,
      actions: uc.actions,
      status: "pending",
      reason: null,
      updatedAt: new Date().toISOString(),
    });
    created.push(id);
  }

  fs.unlinkSync(file);
  return { created, skipped };
}
