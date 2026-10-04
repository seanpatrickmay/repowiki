import type { Architecture, Manifest, Revision } from "@repowiki/core";
import { MIN_ARCHITECTURE_PAGES } from "../write/index.ts";

/** Why an update rewrites the project's article. */
export type ArticleDue =
  | "no article"
  | "features changed"
  | "a lead changed"
  | "names an inactive feature";

const leadOf = (revision: Revision | null | undefined): string =>
  revision?.sections
    .find((s) => s.key === "lead")
    ?.claims.map((c) => c.text)
    .join("\n") ?? "";

/**
 * Why an update left the article alone: "too few pages" when fewer than MIN_ARCHITECTURE_PAGES
 * have a page (there is nothing to write, whether or not an article is stored), "current" when
 * the stored article still reads right; null when it was due (`due` is not null).
 */
export function articleSkipped(
  due: ArticleDue | null,
  pageCount: number,
): "too few pages" | "current" | null {
  if (due !== null) return null;
  return pageCount < MIN_ARCHITECTURE_PAGES ? "too few pages" : "current";
}

/**
 * Whether an update rewrites the project's article (spec §6.1, F27): its `basis` names the page
 * revisions it was written from, so it is current while the features with a page are the
 * basis's features, each one's lead reads as it did, and no claim names a feature that is no
 * longer active. With fewer than MIN_ARCHITECTURE_PAGES pages there is no article to write, and
 * the stored one (if any) is kept as it is. `revisionOf` reads a stored revision by id.
 */
export function articleDue(
  current: Architecture | null,
  pages: readonly Revision[],
  manifest: Manifest,
  revisionOf: (id: string) => Revision | null,
): ArticleDue | null {
  if (pages.length < MIN_ARCHITECTURE_PAGES) return null;
  if (current === null) return "no article";
  const basis = new Map(
    current.basis.flatMap((id) => {
      const revision = revisionOf(id);
      return revision === null ? [] : [[revision.featureId, revision] as const];
    }),
  );
  if (basis.size !== current.basis.length || basis.size !== pages.length) return "features changed";
  if (pages.some((p) => !basis.has(p.featureId))) return "features changed";
  const active = new Set(
    manifest.features.filter((f) => f.status.kind === "active").map((f) => f.id),
  );
  const named = current.sections.flatMap((s) => s.claims.flatMap((c) => c.pages));
  if (named.some((id) => !active.has(id))) return "names an inactive feature";
  if (pages.some((p) => leadOf(p) !== leadOf(basis.get(p.featureId)))) return "a lead changed";
  return null;
}
