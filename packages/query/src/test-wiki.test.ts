import { contentHash } from "@repowiki/core";
import { sourceLines } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { historyWiki, sampleWiki } from "./test-wiki.ts";

describe("sampleWiki", () => {
  it("cites the repository's real lines and commits, at fixed shas", () => {
    const { repo, sha, commits, wiki } = sampleWiki();
    try {
      expect(wiki.head).toBe(sha);
      expect(repo.git("log", "--format=%H %s")).toBe(
        `${sha} feat: add deliverables (#7)\n${commits.signals} feat: add signal ingestion`,
      );
      // createTestRepo fixes identity and dates, so a recorded cassette always sees these shas.
      expect(sha.slice(0, 7)).toBe("6767d44");
      for (const page of wiki.pages) {
        for (const claim of page.sections.flatMap((s) => s.claims)) {
          for (const c of claim.citations) {
            if (c.kind === "commit") {
              expect(repo.git("log", "-1", "--format=%s", c.sha)).toBe(c.subject);
              continue;
            }
            const text = repo.git("show", `${c.sha}:${c.path}`);
            expect(contentHash(sourceLines(`${text}\n`, c.startLine, c.endLine))).toBe(
              c.contentHash,
            );
          }
        }
      }
    } finally {
      repo.remove();
    }
  });
});

describe("historyWiki", () => {
  it("cites the repository's real lines at each revision's commit, at fixed shas", () => {
    const { repo, sha, commits, wiki } = historyWiki();
    try {
      expect(wiki.head).toBe(sha);
      expect(sha).toBe(commits.third);
      expect(repo.git("log", "--format=%h %cs %s")).toBe(
        [
          `${commits.after.slice(0, 7)} 2026-01-05 refactor: tidy ingestion`,
          "3d751d3 2026-01-04 feat: export deliverables (#9)",
          "594d833 2026-01-03 feat: add deliverables (#7)",
          "d08c5a4 2026-01-02 feat: add signal ingestion",
        ].join("\n"),
      );
      const revisions = [...Object.values(wiki.history).flat(), ...wiki.architecture];
      expect(revisions).toHaveLength(7);
      for (const revision of revisions) {
        expect(revision.commitDate.slice(0, 10)).toBe(
          repo.git("log", "-1", "--format=%cs", revision.sha),
        );
        for (const claim of revision.sections.flatMap((s) => s.claims)) {
          for (const c of claim.citations) {
            if (c.kind === "commit") {
              expect(repo.git("log", "-1", "--format=%s", c.sha)).toBe(c.subject);
              continue;
            }
            const text = repo.git("show", `${c.sha}:${c.path}`);
            expect(contentHash(sourceLines(`${text}\n`, c.startLine, c.endLine)), c.path).toBe(
              c.contentHash,
            );
          }
        }
      }
    } finally {
      repo.remove();
    }
  });
});
