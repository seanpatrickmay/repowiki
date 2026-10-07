import type { InFlight } from "@repowiki/core";
import { describe, expect, it } from "vitest";
import { inflightIndexView, inflightStatus, pullView } from "./inflight.ts";
import { articleInflight } from "./inflight-article.ts";
import { buildSiteModel } from "./model.ts";
import { fixtureInFlight, HOSTILE_PULL_TITLE, inflightExport } from "./test-inflight.ts";

const site = (overrides: Partial<InFlight> = {}) => buildSiteModel(inflightExport(overrides), null);
const inflightOf = (s: ReturnType<typeof site>): InFlight => {
  if (s.wiki.inflight === null) throw new Error("the fixture has a snapshot");
  return s.wiki.inflight;
};

describe("inflightStatus (R16)", () => {
  it("dates the snapshot, and warns only against the export, never the clock", () => {
    const s = site();
    expect(inflightStatus(s, inflightOf(s))).toEqual({
      line: "From GitHub on 30 September 2026, against commit ccccccc.",
      stale: null,
    });
    const old = site({ fetchedAt: "2026-09-22T09:00:00Z" });
    expect(inflightStatus(old, inflightOf(old)).stale).toBe(
      "GitHub was read 8 days before this wiki was exported; run pnpm wiki:inflight to refresh it.",
    );
    const week = site({ fetchedAt: "2026-09-23T21:00:00Z" });
    expect(inflightStatus(week, inflightOf(week)).stale).toBeNull();
  });

  it("warns when the wiki has moved on from the snapshot's commit", () => {
    const moved = site({ wikiHead: "b".repeat(40), pulls: [], issues: [] });
    expect(inflightStatus(moved, inflightOf(moved))).toEqual({
      line: "From GitHub on 30 September 2026, against commit bbbbbbb.",
      stale:
        "The wiki has moved on to commit ccccccc since this was worked out; run pnpm wiki:inflight to refresh it.",
    });
  });
});

describe("inflightIndexView", () => {
  it("lists the pull requests with badges and effects, and the issues under their features", () => {
    const s = site();
    const view = inflightIndexView(s, inflightOf(s));
    expect(view.pulls).toEqual([
      {
        number: 12,
        title: "Page through long chunks",
        href: "/special/in-progress/pr/12/",
        badges: [],
        author: "octo-dev",
        updated: "3 October 2026",
        features: [{ title: "Signal ingestion", href: "/wiki/signals/" }],
        claims: "1 (+1 may change)",
      },
      {
        number: 13,
        title: HOSTILE_PULL_TITLE,
        href: "/special/in-progress/pr/13/",
        badges: ["Draft", "Bot", "targets release/1.x"],
        author: "dependabot",
        updated: "29 September 2026",
        features: [{ title: "Deliverables", href: "/wiki/deliverables/" }],
        claims: "not computed",
      },
    ]);
    expect(
      view.planned.map((g) => [g.feature.title, g.issues.map((i) => [i.number, i.evidence])]),
    ).toEqual([
      ["Signal ingestion", [[7, "closed by #12"]]],
      ["Deliverables", [[8, "names Deliverables"]]],
    ]);
    expect(view.unmapped.map((i) => [i.number, i.href])).toEqual([
      [9, "https://github.com/acme/demo/issues/9"],
    ]);
    expect(view.more).toEqual(["And 2 more open pull requests, not read."]);
  });
});

describe("pullView", () => {
  it("links the summary's references at the head and each effect to its claim", () => {
    const s = site();
    const inflight = inflightOf(s);
    const view = pullView(s, inflight, inflight.pulls[0] as InFlight["pulls"][number]);
    expect(view.githubHref).toBe("https://github.com/acme/demo/pull/12");
    expect(view.merge).toBe("It merges cleanly with the wiki's commit.");
    expect(view.summary).toEqual([
      {
        html: 'It makes <a class="wikilink" href="/wiki/signals/" title="Signal ingestion" data-preview="signals">signal ingestion</a> page through long chunks with <code>next_page</code>.',
        refs: [
          {
            n: 1,
            label: "src/signals/ingest.py:L12-L14",
            href: `https://github.com/acme/demo/blob/${"e".repeat(40)}/src/signals/ingest.py#L12-L14`,
          },
        ],
      },
    ]);
    expect(view.features[0]?.anchor).toBe("feature-signals");
    expect(view.features[0]?.effects).toEqual([
      {
        text: expect.any(String),
        href: "/wiki/signals/#claim-s-o1",
        reason: "src/signals/ingest.py:12-12 at bbbbbbb: the cited lines changed",
        certain: true,
      },
      {
        text: expect.any(String),
        href: "/wiki/signals/#claim-s-lead-1",
        reason: "it summarizes s-o1, which changed",
        certain: false,
      },
    ]);
    expect(view.closes).toEqual([{ number: 7, href: "https://github.com/acme/demo/issues/7" }]);
  });

  it("links an effect whose claim is gone from the page (a stale snapshot) to the article", () => {
    const pull = fixtureInFlight().pulls[0] as InFlight["pulls"][number];
    const gone = {
      ...pull,
      closes: [],
      effects: [
        { ...(pull.effects[0] as InFlight["pulls"][number]["effects"][number]), claimId: "s-gone" },
      ],
    };
    const s = site({ wikiHead: "b".repeat(40), pulls: [gone], issues: [] });
    const view = pullView(s, inflightOf(s), gone);
    expect(view.features[0]?.effects).toEqual([
      {
        text: "s-gone",
        href: "/wiki/signals/",
        reason: "src/signals/ingest.py:12-12 at bbbbbbb: the cited lines changed",
        certain: true,
      },
    ]);
  });

  it("links a claim whose id cannot be an anchor to its section, or the article for the lead", () => {
    const s = site();
    const inflight = inflightOf(s);
    const pull = inflight.pulls[0] as InFlight["pulls"][number];
    const page = s.pages.get("signals");
    if (page === undefined) throw new Error("the fixture has a signals page");
    const rename = (id: string) => (id === "s-o1" ? "s.o1" : id === "s-lead-1" ? "s lead" : id);
    (s.pages as Map<string, typeof page>).set("signals", {
      ...page,
      sections: page.sections.map((section) => ({
        ...section,
        claims: section.claims.map((claim) => ({ ...claim, id: rename(claim.id) })),
      })),
    });
    const odd = {
      ...pull,
      effects: pull.effects.map((e) => ({ ...e, claimId: rename(e.claimId) })),
    };
    expect(pullView(s, inflight, odd).features[0]?.effects.map((e) => e.href)).toEqual([
      "/wiki/signals/#overview",
      "/wiki/signals/",
    ]);
  });

  it("counts a feature's files added and removed as files, and marks the inferred ones", () => {
    const pull = fixtureInFlight().pulls[0] as InFlight["pulls"][number];
    const file = (path: string, status: "added" | "deleted", placement: "member" | "inferred") => ({
      path,
      oldPath: status === "added" ? null : path,
      status,
      additions: status === "added" ? 5 : 0,
      deletions: status === "added" ? 0 : 3,
      featureId: "signals",
      placement,
    });
    const placed = {
      ...pull,
      closes: [],
      files: [
        ...pull.files,
        file("src/signals/page.py", "added", "inferred"),
        file("src/signals/next.py", "added", "inferred"),
        file("src/signals/old.py", "deleted", "member"),
      ],
      features: pull.features.map((f) => ({
        ...f,
        files: 4,
        changedLines: 21,
        added: 2,
        removed: 1,
      })),
    };
    const s = site({ pulls: [placed], issues: [] });
    const [signals] = pullView(s, inflightOf(s), placed).features;
    expect(signals?.files).toBe("4 files, 21 lines, 2 files added and 1 removed");
    expect(signals?.inferred).toBe(2);
    const plain = pullView(site(), inflightOf(site()), pull).features[0];
    expect([plain?.files, plain?.inferred]).toEqual(["1 file, 8 lines", 0]);
  });

  it("says a pull request whose head is missing could not be worked out, and has no summary", () => {
    const s = site();
    const inflight = inflightOf(s);
    const view = pullView(s, inflight, inflight.pulls[1] as InFlight["pulls"][number]);
    expect(view.merge).toBe(
      "Its head commit could not be fetched, so its impact could not be computed.",
    );
    expect(view.summary).toBeNull();
    expect(view.summaryNote).toBe("No summary of this pull request yet.");
    expect(view.title).toBe(HOSTILE_PULL_TITLE);
  });

  it("says there is nothing to summarise for a fetched pull with no added or changed lines", () => {
    const pull = fixtureInFlight().pulls[0] as InFlight["pulls"][number];
    const deletes = {
      ...pull,
      closes: [],
      summary: null,
      files: pull.files.map((f) => ({ ...f, status: "deleted" as const, additions: 0 })),
    };
    const s = site({ pulls: [deletes], issues: [] });
    const view = pullView(s, inflightOf(s), deletes);
    expect(view.summary).toBeNull();
    expect(view.summaryNote).toBe(
      "There is nothing to summarise: it adds or changes no lines of text.",
    );
    const fetched = { ...pull, closes: [], summary: null };
    const t = site({ pulls: [fetched], issues: [] });
    expect(pullView(t, inflightOf(t), fetched).summaryNote).toBe(
      "No summary of this pull request yet.",
    );
  });
});

describe("a pull request forked past the wiki's head (R27)", () => {
  const BEHIND =
    "The wiki is behind this pull's base (aaaaaaa); run wiki:update for exact predictions.";
  const behind = () => {
    const pull = fixtureInFlight().pulls[0] as InFlight["pulls"][number];
    return {
      ...pull,
      closes: [],
      baseSha: "a".repeat(40),
      behind: true,
      merge: "unknown" as const,
      effects: pull.effects.map((e) => ({ ...e, certain: false })),
    };
  };

  it("says so on its page and in the article's In progress section, and only may change", () => {
    const pull = behind();
    const s = site({ pulls: [pull], issues: [] });
    const view = pullView(s, inflightOf(s), pull);
    expect(view.behind).toBe(BEHIND);
    expect(view.merge).not.toMatch(/git 2\.38/);
    expect(view.features[0]?.effects.every((e) => !e.certain)).toBe(true);
    expect(articleInflight(s, "signals")?.pulls[0]?.behind).toBe(BEHIND);
  });

  it("says nothing for a pull request the wiki's head already holds the base of", () => {
    const s = site();
    const inflight = inflightOf(s);
    expect(pullView(s, inflight, inflight.pulls[0] as InFlight["pulls"][number]).behind).toBeNull();
    expect(articleInflight(s, "signals")?.pulls[0]?.behind).toBeNull();
  });
});
