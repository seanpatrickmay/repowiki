import { z } from "zod";
import { GitSha, RepoPath, Sha256Hex } from "./primitives.ts";

export const CodeCitation = z
  .object({
    kind: z.literal("code"),
    path: RepoPath,
    startLine: z.int().positive(),
    endLine: z.int().positive(),
    sha: GitSha,
    symbol: z.string().min(1).nullable(),
    contentHash: Sha256Hex,
  })
  .refine((c) => c.endLine >= c.startLine, {
    message: "endLine must be >= startLine",
    path: ["endLine"],
  });
export type CodeCitation = z.infer<typeof CodeCitation>;

export const CommitCitation = z.object({
  kind: z.literal("commit"),
  sha: GitSha,
  subject: z.string().min(1),
  pr: z.int().positive().nullable(),
});
export type CommitCitation = z.infer<typeof CommitCitation>;

export const Citation = z.discriminatedUnion("kind", [CodeCitation, CommitCitation]);
export type Citation = z.infer<typeof Citation>;
