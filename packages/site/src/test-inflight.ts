import { type InFlight, WikiExport } from "@repowiki/core";
import {
  codeCitation,
  DEMO_REPO,
  makeInFlightIssue,
  makeInFlightPull,
  SHA_C,
} from "@repowiki/core/test-fixtures";
import { fixtureExport } from "./test-fixtures.ts";

/** A pull request title GitHub would accept: markup, a bidi-free wikilink, a link and quotes. */
export const HOSTILE_PULL_TITLE =
  "<script>alert(1)</script> [[signals]] [x](javascript:alert(1)) \"q\" & 'p'";
const HEAD_12 = "e".repeat(40);

/**
 * The work in flight on the site's fixture wiki, derived against its head (spec v2 #9 §9): #12
 * would make two signals claims stale, has a summary and closes #7; #13 is a hostile-titled bot
 * draft against another base whose head could not be fetched; #7 maps through #12, #8 by name
 * to deliverables, #9 to nothing. Two more pull requests were past the cap. Test-only.
 */
export function fixtureInFlight(overrides: Partial<InFlight> = {}): InFlight {
  return {
    repo: DEMO_REPO,
    fetchedAt: "2026-09-30T09:00:00Z",
    derivedAt: "2026-09-30T10:00:00Z",
    wikiHead: SHA_C,
    pulls: [
      makeInFlightPull({
        headSha: HEAD_12,
        mergeBase: SHA_C,
        effects: [
          {
            featureId: "signals",
            revisionId: "signals-2",
            claimId: "s-o1",
            reason: "src/signals/ingest.py:12-12 at bbbbbbb: the cited lines changed",
            certain: true,
          },
          {
            featureId: "signals",
            revisionId: "signals-2",
            claimId: "s-lead-1",
            reason: "it summarizes s-o1, which changed",
            certain: false,
          },
        ],
        summary: {
          model: "claude-haiku-4-5-20251001",
          generatedAt: "2026-09-30T10:00:00Z",
          tokens: { in: 4000, out: 300, cacheRead: 0, cacheWrite: 0 },
          claims: [
            {
              id: "p12-c1",
              text: "It makes [[signals|signal ingestion]] page through long chunks with `next_page`.",
              citations: [codeCitation({ sha: HEAD_12, startLine: 12, endLine: 14 })],
              features: ["signals"],
            },
          ],
        },
      }),
      makeInFlightPull({
        number: 13,
        title: HOSTILE_PULL_TITLE,
        author: { login: "dependabot", bot: true },
        draft: true,
        updatedAt: "2026-09-29T09:00:00Z",
        baseRef: "release/1.x",
        labels: ["<b>x</b>"],
        closes: [],
        head: "missing",
        headSha: "d".repeat(40),
        mergeBase: null,
        merge: "unknown",
        files: [],
        features: [
          {
            featureId: "deliverables",
            files: 1,
            changedLines: 0,
            added: 0,
            removed: 0,
            churn: null,
            drifts: false,
          },
        ],
        effects: [],
        summary: null,
      }),
    ],
    issues: [
      makeInFlightIssue(),
      makeInFlightIssue({
        number: 8,
        title: "Deliverables <em>export</em> fails",
        author: null,
        labels: [],
        features: [{ featureId: "deliverables", kind: "name", detail: "Deliverables" }],
        pulls: [],
      }),
      makeInFlightIssue({ number: 9, title: "Docs are thin", features: [], pulls: [] }),
    ],
    omitted: { pulls: 2, issues: 0 },
    ...overrides,
  };
}

/** The site's fixture export carrying `fixtureInFlight()`. */
export function inflightExport(overrides: Partial<InFlight> = {}): WikiExport {
  return WikiExport.parse({ ...fixtureExport(), inflight: fixtureInFlight(overrides) });
}
