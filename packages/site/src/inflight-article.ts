import { githubUrl } from "@repowiki/core";
import {
  badges,
  evidenceText,
  type InflightStatus,
  inflightStatus,
  pullFeatureAnchor,
} from "./inflight.ts";
import { escapeHtml, renderInline } from "./inline.ts";
import type { SiteModel } from "./model.ts";
import { inlineOptions } from "./preview.ts";
import { IN_PROGRESS_URL, pullUrl } from "./urls.ts";

/** A claim shows at most this many pull requests' markers, then one "+k" (spec v2 #9 §6.2). */
export const MAX_CLAIM_MARKERS = 3;

/** The anchor of an article's In progress section, listed in its Contents. */
export const IN_PROGRESS_ANCHOR = "in-progress";

/**
 * What the work in flight adds to an active feature's current article. Every field is plain text
 * except `notice`-free `markers` and the summary claims' `html`, which are trusted HTML. All of
 * it is printed under data-pagefind-ignore, so no GitHub text enters search (R17, C9).
 */
export interface ArticleInflight {
  /** Plain text: "Open pull requests would change N claims on this page.", or null for none. */
  notice: string | null;
  /** Trusted HTML per claim id: its "[changing in #n]" markers, appended inside the claim. */
  markers: ReadonlyMap<string, string>;
  status: InflightStatus;
  pulls: {
    number: number;
    /** Plain text. */
    title: string;
    href: string;
    badges: string[];
    /** Plain text: how many of this page's claims it would change. */
    changes: string;
    /** Trusted HTML: its summary claims that name this feature. */
    claims: string[];
  }[];
  issues: { number: number; title: string; href: string; evidence: string }[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The work in flight on `featureId`'s article, or null when the export has no snapshot, the
 * feature is not active, or nothing open touches it. Markers link each pull request's part of
 * its page; past MAX_CLAIM_MARKERS, one "+k" links the index.
 */
export function articleInflight(site: SiteModel, featureId: string): ArticleInflight | null {
  const inflight = site.wiki.inflight;
  if (inflight === null || site.features.get(featureId)?.status.kind !== "active") return null;
  const pulls = inflight.pulls.filter(
    (p) =>
      p.features.some((f) => f.featureId === featureId) ||
      p.effects.some((e) => e.featureId === featureId),
  );
  const issues = inflight.issues.flatMap((issue) =>
    issue.features
      .filter((e) => e.featureId === featureId)
      .slice(0, 1)
      .map((evidence) => ({
        number: issue.number,
        title: issue.title,
        href: githubUrl(inflight.repo, "issues", issue.number),
        evidence: evidenceText(site, evidence),
      })),
  );
  if (pulls.length === 0 && issues.length === 0) return null;

  const byClaim = new Map<string, number[]>();
  for (const pull of pulls)
    for (const effect of pull.effects) {
      if (effect.featureId !== featureId) continue;
      const numbers = byClaim.get(effect.claimId) ?? [];
      if (!numbers.includes(pull.number)) numbers.push(pull.number);
      byClaim.set(effect.claimId, numbers);
    }
  const markers = new Map(
    [...byClaim].map(([claimId, numbers]) => {
      const shown = numbers
        .slice(0, MAX_CLAIM_MARKERS)
        .map(
          (n) =>
            `<sup class="inflight-marker" data-pagefind-ignore="all"><a href="${escapeHtml(`${pullUrl(n)}#${pullFeatureAnchor(featureId)}`)}">[changing in #${n}]</a></sup>`,
        );
      const more = numbers.length - shown.length;
      if (more > 0)
        shown.push(
          `<sup class="inflight-marker" data-pagefind-ignore="all"><a href="${IN_PROGRESS_URL}">[+${more}]</a></sup>`,
        );
      return [claimId, shown.join("")];
    }),
  );
  const links = inlineOptions(site);
  return {
    notice:
      byClaim.size === 0
        ? null
        : `Open pull requests would change ${plural(byClaim.size, "claim", "claims")} on this page.`,
    markers,
    status: inflightStatus(site, inflight),
    pulls: pulls.map((pull) => {
      const mine = new Set(
        pull.effects.filter((e) => e.featureId === featureId).map((e) => e.claimId),
      );
      return {
        number: pull.number,
        title: pull.title,
        href: `${pullUrl(pull.number)}#${pullFeatureAnchor(featureId)}`,
        badges: badges(inflight, pull),
        changes:
          pull.head === "fetched"
            ? `would change ${plural(mine.size, "claim", "claims")} here`
            : "its impact could not be computed",
        claims: (pull.summary?.claims ?? [])
          .filter((c) => c.features.includes(featureId))
          .map((c) => renderInline(c.text, links)),
      };
    }),
    issues,
  };
}
