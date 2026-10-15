import {
  type Architecture,
  type Feature,
  type LineageEvent,
  type Manifest,
  WikiExport,
} from "@repowiki/core";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The hidden features plus every feature that only pointed at them: a redirect to one, or a
 * disambiguation left with fewer than two targets. Those would otherwise name a hidden id.
 */
function removedFeatures(manifest: Manifest, hidden: ReadonlySet<string>): Set<string> {
  const removed = new Set(hidden);
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of manifest.features) {
      if (removed.has(f.id)) continue;
      const s = f.status;
      const orphaned =
        (s.kind === "redirect" && removed.has(s.to)) ||
        (s.kind === "disambiguation" && s.to.filter((id) => !removed.has(id)).length < 2);
      if (orphaned) {
        removed.add(f.id);
        changed = true;
      }
    }
  }
  return removed;
}

/** The manifest without the removed features, and with nothing left that names them. */
function keptManifest(manifest: Manifest, removed: ReadonlySet<string>): Manifest {
  const kept = (id: string) => !removed.has(id);
  const features = manifest.features
    .filter((f) => kept(f.id))
    .map((f): Feature => {
      const status =
        f.status.kind === "disambiguation"
          ? { ...f.status, to: f.status.to.filter(kept) }
          : f.status;
      const lineage = f.lineage.flatMap((event): LineageEvent[] => {
        if (event.kind === "merge") return kept(event.into) ? [event] : [];
        if (event.kind === "split") {
          const into = event.into.filter(kept);
          return into.length >= 2 ? [{ ...event, into }] : [];
        }
        return [event];
      });
      return { ...f, status, lineage };
    });
  const membership = Object.fromEntries(
    Object.entries(manifest.membership).filter(([, m]) => kept(m.featureId)),
  );
  return { ...manifest, features, membership };
}

/** A Mermaid diagram without a line naming a removed feature or a node labelled with one. */
function scrubDiagram(source: string, names: readonly string[]): string | null {
  if (names.length === 0) return source;
  const lines = source.split("\n");
  const named = (line: string) => names.some((n) => line.includes(n));
  const nodes = lines.flatMap((line) => {
    const id = /^\s*([A-Za-z0-9_]+)\s*[[({>]/.exec(line)?.[1];
    return id !== undefined && named(line) ? [id] : [];
  });
  const node =
    nodes.length === 0
      ? null
      : new RegExp(`(^|[^A-Za-z0-9_])(${nodes.map(escapeRe).join("|")})($|[^A-Za-z0-9_])`);
  const kept = lines.filter((line, i) => i === 0 || !(named(line) || node?.test(line)));
  return kept.slice(1).some((line) => line.trim() !== "") ? kept.join("\n") : null;
}

/**
 * The export a hosted site is built from (spec 2 S10, S13; Contract §8; M14e A4): hidden features
 * leave the manifest, the pages, the history, every link, See also, About claim, edge, basis
 * entry and diagram line; People, work in flight, run costs and Wikipedia summaries are dropped.
 * Throws when no valid export remains.
 */
export function hostedExport(exp: WikiExport, hiddenFeatureIds: readonly string[]): WikiExport {
  const removed = removedFeatures(exp.manifest, new Set(hiddenFeatureIds));
  const titles = new Map(exp.manifest.features.map((f) => [f.id as string, f.title]));
  const ids = [...removed];
  // A diagram names features by title; the ids and titles of removed features both go.
  const names = [...ids, ...ids.map((id) => titles.get(id) ?? id)];
  const link =
    ids.length === 0
      ? null
      : new RegExp(`\\[\\[(${ids.map(escapeRe).join("|")})(?:\\|([^\\]]+))?\\]\\]`, "g");

  /** Strings lose links to removed pages; string lists lose removed ids; diagrams lose lines. */
  const scrub = (value: Json, key: string): Json => {
    if (typeof value === "string") {
      if (key === "diagram") return scrubDiagram(value, names);
      if (link === null) return value;
      return value.replace(link, (_m, id: string, label?: string) => label ?? titles.get(id) ?? id);
    }
    if (Array.isArray(value)) {
      return value
        .filter((item) => !(typeof item === "string" && removed.has(item)))
        .map((item) => scrub(item, key));
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)]));
    }
    return value;
  };
  const scrubbed = <T>(value: T): T => scrub(value as unknown as Json, "") as unknown as T;

  const removedRevisions = new Set(
    ids.flatMap((id) => [
      ...(exp.history[id] ?? []).map((r) => r.id),
      ...exp.pages.filter((p) => p.featureId === id).map((p) => p.id),
    ]),
  );
  const architecture = exp.architecture.map((original): Architecture => {
    const article = scrubbed(original);
    const edges = article.edges.filter((e) => !removed.has(e.from) && !removed.has(e.to));
    const basis = article.basis.filter((id) => !removedRevisions.has(id));
    // A body claim that rested only on removed pages goes, then any lead left supporting nothing.
    const bodies = article.sections.map((section) =>
      section.key === "lead"
        ? section
        : {
            ...section,
            claims: section.claims.filter((c) => c.citations.length > 0 || c.pages.length > 0),
          },
    );
    const left = new Set(
      bodies.flatMap((s) => (s.key === "lead" ? [] : s.claims.map((c) => c.id))),
    );
    const sections = bodies
      .map((section) =>
        section.key !== "lead"
          ? section
          : {
              ...section,
              claims: section.claims
                .map((c) => ({ ...c, supports: c.supports.filter((id) => left.has(id)) }))
                .filter((c) => c.supports.length > 0),
            },
      )
      .filter((section) => section.claims.length > 0);
    return { ...article, edges, basis, sections };
  });

  const pages = exp.pages.filter((p) => !removed.has(p.featureId)).map(scrubbed);
  const history = Object.fromEntries(
    Object.entries(exp.history)
      .filter(([id]) => !removed.has(id))
      .map(([id, revisions]) => [id, revisions.map(scrubbed)]),
  );
  const base = {
    ...exp,
    manifest: keptManifest(exp.manifest, removed),
    pages,
    history,
    people: null,
    inflight: null,
    runs: [],
    wikipedia: {},
  };
  const withArticle = WikiExport.safeParse({ ...base, architecture });
  if (withArticle.success) return withArticle.data;
  // An article the removal left invalid (no lead, an empty required section) is dropped whole.
  return WikiExport.parse({ ...base, architecture: [] });
}
