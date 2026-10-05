import { contentHash } from "@repowiki/core";
import { sourceLines } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { sampleWiki } from "./test-wiki.ts";

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
