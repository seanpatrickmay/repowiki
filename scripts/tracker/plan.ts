import { z } from "zod";

export const SeedLabel = z.object({
  name: z.string().min(1),
  color: z.string().regex(/^[0-9a-f]{6}$/),
  description: z.string(),
});
export type SeedLabel = z.infer<typeof SeedLabel>;

export const SeedIssue = z.object({
  key: z.string().regex(/^(F\d{2}|M\d+-\d+)$/),
  title: z.string().min(1),
  labels: z.array(z.string().min(1)).min(1),
  body: z.string().min(1),
  parent: z.string().optional(),
  closed: z.boolean().optional(),
});
export type SeedIssue = z.infer<typeof SeedIssue>;

export const Seed = z
  .object({ labels: z.array(SeedLabel), issues: z.array(SeedIssue) })
  .superRefine((seed, ctx) => {
    const labelNames = new Set(seed.labels.map((label) => label.name));
    const keys = new Set<string>();
    const titles = new Set<string>();
    seed.issues.forEach((issue, index) => {
      if (keys.has(issue.key)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate key ${issue.key}`,
          path: ["issues", index],
        });
      }
      if (titles.has(issue.title)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate title ${issue.title}`,
          path: ["issues", index],
        });
      }
      keys.add(issue.key);
      titles.add(issue.title);
      for (const label of issue.labels) {
        if (!labelNames.has(label)) {
          ctx.addIssue({
            code: "custom",
            message: `undefined label ${label}`,
            path: ["issues", index],
          });
        }
      }
    });
    seed.issues.forEach((issue, index) => {
      if (issue.parent !== undefined && !keys.has(issue.parent)) {
        ctx.addIssue({
          code: "custom",
          message: `unknown parent ${issue.parent}`,
          path: ["issues", index],
        });
      }
    });
  });
export type Seed = z.infer<typeof Seed>;

export interface ExistingIssue {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  parentNumber: number | null;
}

export type Action =
  | { kind: "upsert-label"; label: SeedLabel }
  | { kind: "create-issue"; issue: SeedIssue }
  | { kind: "link-parent"; childKey: string; parentKey: string }
  | { kind: "close-issue"; key: string };

/**
 * Plans an idempotent, resumable sync. Labels are always upserted; issues are matched by exact
 * title. Links and closes are derived from observed GitHub state (a missing parent, an open
 * issue), so a run that died part-way is finished by the next run.
 */
export function planSeed(seed: Seed, existing: readonly ExistingIssue[]): Action[] {
  const byTitle = new Map(existing.map((issue) => [issue.title, issue]));
  const fresh = seed.issues.filter((issue) => !byTitle.has(issue.title));
  const needsLink = seed.issues.filter((issue) => {
    if (issue.parent === undefined) return false;
    const found = byTitle.get(issue.title);
    return found === undefined || found.parentNumber === null;
  });
  const needsClose = seed.issues.filter((issue) => {
    if (issue.closed !== true) return false;
    const found = byTitle.get(issue.title);
    return found === undefined || found.state === "OPEN";
  });
  return [
    ...seed.labels.map((label): Action => ({ kind: "upsert-label", label })),
    ...fresh.map((issue): Action => ({ kind: "create-issue", issue })),
    ...needsLink.flatMap((issue): Action[] =>
      issue.parent === undefined
        ? []
        : [{ kind: "link-parent", childKey: issue.key, parentKey: issue.parent }],
    ),
    ...needsClose.map((issue): Action => ({ kind: "close-issue", key: issue.key })),
  ];
}
