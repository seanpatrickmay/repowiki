import type { InFlight } from "@repowiki/core";
import { describe, expect, it } from "vitest";
import { inflightIndexView, inflightStatus, pullView } from "./inflight.ts";
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

  it("says a pull request whose head is missing could not be worked out, and has no summary", () => {
    const s = site();
    const inflight = inflightOf(s);
    const view = pullView(s, inflight, inflight.pulls[1] as InFlight["pulls"][number]);
    expect(view.merge).toBe(
      "Its head commit could not be fetched, so its impact could not be computed.",
    );
    expect(view.summary).toBeNull();
    expect(view.title).toBe(HOSTILE_PULL_TITLE);
  });
});
