import type { InFlight } from "@repowiki/core";
import { makeInFlightPull } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { articleView } from "./article.ts";
import { articleInflight, MAX_CLAIM_MARKERS } from "./inflight-article.ts";
import { buildSiteModel } from "./model.ts";
import { pageFor, wikiRoutes } from "./routes.ts";
import { fixtureInFlight, inflightExport } from "./test-inflight.ts";

const site = (overrides: Partial<InFlight> = {}) => buildSiteModel(inflightExport(overrides), null);

describe("articleInflight (spec v2 #9 §6.2)", () => {
  it("marks each changed claim, counts them in the notice, and lists the work on the feature", () => {
    const view = articleInflight(site(), "signals");
    expect(view?.notice).toBe("Open pull requests would change 2 claims on this page.");
    expect(view?.markers.get("s-o1")).toBe(
      '<sup class="inflight-marker" data-pagefind-ignore="all"><a href="/special/in-progress/pr/12/#feature-signals">[changing in #12]</a></sup>',
    );
    expect([...(view?.markers.keys() ?? [])]).toEqual(["s-o1", "s-lead-1"]);
    expect(view?.pulls).toEqual([
      {
        number: 12,
        title: "Page through long chunks",
        href: "/special/in-progress/pr/12/#feature-signals",
        badges: [],
        changes: "would change 2 claims here",
        behind: null,
        claims: [expect.stringContaining("page through long chunks with <code>next_page</code>")],
      },
    ]);
    expect(view?.issues).toEqual([
      {
        number: 7,
        title: "Long chunks lose signals",
        href: "https://github.com/acme/demo/issues/7",
        evidence: "closed by #12",
      },
    ]);
  });

  it("shows at most three pull requests on a claim, then one +k to the index", () => {
    const base = fixtureInFlight().pulls[0] as InFlight["pulls"][number];
    const pulls = [12, 14, 15, 16, 17].map((number) =>
      makeInFlightPull({ ...base, number, summary: null, closes: [] }),
    );
    const markers = articleInflight(site({ pulls, issues: [] }), "signals")?.markers.get("s-o1");
    expect(markers?.match(/\[changing in #\d+\]/g)).toEqual([
      "[changing in #12]",
      "[changing in #14]",
      "[changing in #15]",
    ]);
    expect(MAX_CLAIM_MARKERS).toBe(3);
    expect(markers).toContain('<a href="/special/in-progress/">[+2]</a>');
  });

  it("adds nothing to a feature nothing open touches, a retired one, or an export without a snapshot", () => {
    expect(articleInflight(site(), "scheduler")).toBeNull();
    expect(articleInflight(site(), "exporter")).toBeNull();
    const plain = buildSiteModel({ ...inflightExport(), inflight: null }, null);
    expect(articleInflight(plain, "signals")).toBeNull();
  });

  it("adds the section to the current article's Contents and markers, never to an old revision", () => {
    const s = site();
    const route = wikiRoutes(s).find((r) => r.kind === "article" && r.featureId === "signals");
    if (route === undefined) throw new Error("the fixture has a signals article");
    const page = pageFor(s, route);
    if (page.kind !== "article") throw new Error("signals is an article");
    expect(page.view.toc.map((e) => e.anchor)).toContain("in-progress");
    expect(page.view.toc.map((e) => e.anchor).indexOf("in-progress")).toBe(
      page.view.toc.findIndex((e) => e.anchor === "see-also") - 1,
    );
    expect(page.view.sections.some((sec) => sec.html.includes("[changing in #12]"))).toBe(true);
    const old = articleView(s, s.history.get("signals")?.[0] as never);
    expect(old.inflight).toBeUndefined();
    expect(old.toc.map((e) => e.anchor)).not.toContain("in-progress");
  });
});
