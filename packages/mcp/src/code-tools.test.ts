import type { WikiExport } from "@repowiki/core";
import { type HistoryWiki, historyWiki } from "@repowiki/query/test-wiki";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentTools } from "./agent-tools.ts";
import { repoRelative } from "./code-tools.ts";
import { serveWiki } from "./served.ts";

let h: HistoryWiki;
let after: string;
beforeAll(() => {
  h = historyWiki();
  after = h.commits.after.slice(0, 7);
});
afterAll(() => h.repo.remove());

const tools = (pinned: string | null = null) => {
  const served = serveWiki(h.wiki, { repo: h.repo.dir, pinned });
  return createAgentTools(() => served);
};
const text = (name: string, input: unknown, pinned: string | null = null) => {
  const out = tools(pinned).run(name, input) as { text: string; isError: boolean };
  return out.isError ? `ERROR ${out.text}` : out.text;
};

describe("repoRelative", () => {
  it("reads a relative or absolute path by string rules alone", () => {
    expect(repoRelative("/r/repo", "./src//a.py")).toBe("src/a.py");
    expect(repoRelative("/r/repo/", "/r/repo/src/a.py")).toBe("src/a.py");
    expect(repoRelative("/r/repo", "src/a#b%20.py")).toBe("src/a#b%20.py");
    expect(() => repoRelative("/r/repo", "/r/repo-other/a.py")).toThrow(/outside the repository/);
    expect(() => repoRelative("/r/repo", "/etc/passwd")).toThrow(/outside the repository/);
    expect(() => repoRelative("/r/repo", "src/../../x")).toThrow(/cannot use \.\./);
    expect(() => repoRelative("/r/repo", "./")).toThrow(/give the path of a file/);
  });
});

describe("pages_for_file", () => {
  it("names the owning feature, the pages citing the file with their references, and its change", () => {
    expect(text("pages_for_file", { path: "src/signals/store.py" })).toBe(
      [
        "src/signals/store.py:",
        "- Owned by signals (Signal ingestion), weight 0.9, 1 symbol: save_signal.",
        "- Cited by signals (Signal ingestion): references [2].",
        `Changed since the wiki's commit (compared with commit ${after}): read it in the working tree; read_page marks the claims whose cited lines changed.`,
        "Read a reference's code with cited_code(id, ref).",
        "",
      ].join("\n"),
    );
    expect(text("pages_for_file", { path: `${h.repo.dir}/src/signals/ingest.py` })).toContain(
      "- Owned by signals (Signal ingestion), weight 1, the whole file.\n- Cited by signals (Signal ingestion): references [1], [3].\n- Cited by special:about (sample): references [1].\n",
    );
  });

  it("says when a file is new since the wiki's commit, or one the wiki does not describe", () => {
    h.repo.write("src/new.py", "x = 1\n");
    const next = h.repo.commit("feat: new file");
    try {
      expect(text("pages_for_file", { path: "src/new.py" })).toBe(
        `src/new.py:\nAdded after the wiki's commit (compared with commit ${next.slice(0, 7)}): not in the wiki yet; read it in the working tree.\n`,
      );
    } finally {
      h.repo.git("reset", "-q", "--hard", h.commits.after);
    }
    expect(text("pages_for_file", { path: "docs/none.md" })).toBe(
      [
        "docs/none.md:",
        `Unchanged since the wiki's commit (compared with commit ${after}).`,
        "No page owns or cites this file: the wiki does not describe it. Try search with words from it.",
        "",
      ].join("\n"),
    );
  });

  it("refuses a path outside the repository or with .., and never reads the file", () => {
    expect(text("pages_for_file", { path: "/etc/passwd" })).toBe(
      'ERROR "/etc/passwd" is outside the repository; give a path relative to its root',
    );
    expect(text("pages_for_file", { path: "../secrets.txt" })).toBe(
      "ERROR paths are relative to the repository root and cannot use ..",
    );
  });
});

describe("cited_code", () => {
  it("shows the cited lines at their commit with context, and where they are now", () => {
    expect(text("cited_code", { id: "signals", ref: 2, context: 0 })).toBe(
      [
        "Reference [2] of signals: src/signals/store.py:6-8 (save_signal) at commit 3d751d3",
        "src/signals/store.py at commit 3d751d3, lines 6-8 of 8 (cited: 6-8, save_signal):",
        "> 6\tdef save_signal(signal):",
        '> 7\t    """Appends one signal to the in-memory store."""',
        "> 8\t    SIGNALS.append(signal)",
        `At commit ${after}: the cited lines changed; read src/signals/store.py in the working tree.`,
        "",
      ].join("\n"),
    );
    expect(text("cited_code", { id: "signals", ref: 1, context: 1 })).toContain(
      `  25\t\nAt commit ${after}: unchanged, moved to src/signals/ingest.py:12-26.\n`,
    );
    expect(text("cited_code", { id: "deliverables", ref: 1, context: 0 })).toContain(
      `At commit ${after}: unchanged at src/deliverables/crud.py:4-6.\n`,
    );
  });

  it("numbers references as read_page does, also as of a point", () => {
    const set = tools();
    for (const as_of of [undefined, "2026-01-02", "594d833"]) {
      const page = (set.run("read_page", { id: "signals", as_of }) as { text: string }).text;
      const refs = page
        .split("\nReferences\n")[1]
        ?.split("\n")
        .filter((l) => /^\[\d+\] /.test(l));
      for (const [i, line] of (refs ?? []).entries()) {
        const code = (
          set.run("cited_code", { id: "signals", ref: i + 1, as_of }) as { text: string }
        ).text;
        expect(code.split("\n")[0], `${as_of} [${i + 1}]`).toBe(
          `Reference [${i + 1}] of signals: ${line.slice(line.indexOf(" ") + 1)}`,
        );
      }
    }
  });

  it("shows a cited commit's details, and refuses a reference the page does not have", () => {
    expect(text("cited_code", { id: "signals", ref: 4 })).toBe(
      [
        'Reference [4] of signals: commit d08c5a4 "feat: add signal ingestion"',
        `commit ${h.commits.first}, 2026-01-02`,
        "Subject: feat: add signal ingestion",
        "3 changed files:",
        "- README.md: +3 -0",
        "- src/signals/ingest.py: +31 -0",
        "- src/signals/store.py: +8 -0",
        "",
      ].join("\n"),
    );
    expect(text("cited_code", { id: "signals", ref: 9 })).toBe(
      "ERROR signals has 4 references; ref is 1 to 4",
    );
    expect(text("cited_code", { id: "signals", ref: 0 })).toMatch(
      /^ERROR invalid input for cited_code: ref: /,
    );
  });

  it("answers as read_page does for a point before the page's history begins", () => {
    for (const id of ["deliverables", "special:about"]) {
      const asOf = { id, as_of: "2026-01-01" };
      const begins = text("read_page", asOf);
      expect(begins, id).toMatch(/^The wiki's history of \S+ begins on 2026-01-0\d/);
      expect(text("cited_code", { ...asOf, ref: 1 }), id).toBe(begins);
    }
    expect(text("cited_code", { id: "deliverables", ref: 1, as_of: "2026-01-02" })).toBe(
      "The wiki's history of deliverables begins on 2026-01-03 (commit 594d833).\n",
    );
  });

  it("lists the choices, as read_page does, for an id that named several pages then", () => {
    // "Deliverable records" is signals' alias and deliverables' old title; deliverables is merged
    // into signals later, so the name is ambiguous at the second commit and signals' now.
    const [signals, deliverables] = h.wiki.manifest.features;
    if (signals === undefined || deliverables === undefined) throw new Error("fixture");
    const wiki: WikiExport = {
      ...h.wiki,
      manifest: {
        ...h.wiki.manifest,
        features: [
          { ...signals, aliases: ["Deliverable records"] },
          {
            ...deliverables,
            status: { kind: "redirect", to: "signals" },
            lineage: [
              ...deliverables.lineage,
              { kind: "merge", sha: h.commits.after, into: "signals" },
            ],
          },
        ],
      },
    };
    const served = serveWiki(wiki, { repo: h.repo.dir, pinned: null });
    const set = createAgentTools(() => served);
    const run = (name: string, input: unknown) => {
      const out = set.run(name, input) as { text: string; isError: boolean };
      return out.isError ? `ERROR ${out.text}` : out.text;
    };
    const asOf = { id: "Deliverable records", as_of: h.commits.second.slice(0, 7) };
    expect(run("read_page", asOf)).toMatch(/^"?Deliverable records"? may refer to/);
    expect(run("cited_code", { ...asOf, ref: 1 })).toBe(
      'ERROR "Deliverable records" may refer to several pages: signals, deliverables; name one',
    );
  });
});

describe("page_changes", () => {
  it("diffs the revision before the current one against it by default", () => {
    expect(text("page_changes", { id: "signals" })).toBe(
      [
        "Changes to Signal ingestion (page id: signals) from revision 2 (commit 594d833, 2026-01-03) to revision 3 (commit 3d751d3, 2026-01-04):",
        "",
        "Known limitations",
        "- Long chunks are truncated rather than paged through, as a `TODO` notes.",
        "",
        "Revisions in this range, oldest first:",
        "- 2026-01-03 commit 594d833 (update, pull request #7)",
        "- 2026-01-04 commit 3d751d3 (update, pull request #9)",
        "",
      ].join("\n"),
    );
  });

  it("diffs any two points claim by claim, with a word diff of a rewritten claim", () => {
    expect(text("page_changes", { id: "signals", from: "2026-01-02", to: "594d833" })).toBe(
      [
        "Changes to Signal ingestion (page id: signals) from revision 1 (commit d08c5a4, 2026-01-02) to revision 2 (commit 594d833, 2026-01-03):",
        "",
        "Overview",
        "  `ingest_chunk` makes one signal per non-blank sentence of a chunk.",
        "+ `save_signal` appends each signal to the in-memory `SIGNALS` list.",
        "",
        "How it works",
        "~ Ingestion stops after `MAX_SIGNALS` [-(50)-]{+(100)+} signals.",
        "",
        "Revisions in this range, oldest first:",
        "- 2026-01-02 commit d08c5a4 (build)",
        "- 2026-01-03 commit 594d833 (update, pull request #7)",
        "",
      ].join("\n"),
    );
    expect(text("page_changes", { id: "special:about" })).toContain(
      "\nLead\n~ **sample** turns chunks of text into [-signals.-]{+signals, and signals into deliverables.+}\n",
    );
  });

  it("says when both points have the same revision, and where a history begins", () => {
    expect(text("page_changes", { id: "signals", from: "2026-01-04", to: "2030-01-01" })).toContain(
      "The same revision is current at both points: nothing changed between them.\n",
    );
    expect(text("page_changes", { id: "deliverables", from: "2026-01-01" })).toBe(
      "ERROR the wiki's history of deliverables begins on 2026-01-03 (commit 594d833), after 2026-01-01",
    );
  });
});
