import { z } from "zod";

/** A full 40-character lowercase git commit sha. */
export const GitSha = z.string().regex(/^[0-9a-f]{40}$/, "expected a full 40-character git sha");

/** A lowercase SHA-256 hex digest. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "expected a sha256 hex digest");

/** An ISO-8601 timestamp with an explicit offset, as git reports commit dates. */
export const IsoDateTime = z.string().datetime({ offset: true });

/** A repo-relative POSIX path: no leading slash, no backslashes, no empty, "." or ".." segments. */
export const RepoPath = z
  .string()
  .min(1)
  .refine(isRepoRelativePath, "expected a repo-relative POSIX path");

function isRepoRelativePath(path: string): boolean {
  if (path.startsWith("/") || path.includes("\\")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
