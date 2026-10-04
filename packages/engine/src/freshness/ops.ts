import {
  aliasProblem,
  controlCharacters,
  type Feature,
  FeatureId,
  Manifest,
  type Membership,
  parseMemberId,
} from "@repowiki/core";
import { z } from "zod";
import type { Cluster } from "../cluster/index.ts";
import {
  cleanAliases,
  MAX_ALIASES,
  MAX_FEATURE_ID_LENGTH,
  MAX_TITLE_LENGTH,
  MIN_ALIASES,
} from "../manifest/index.ts";

/**
 * One change to the manifest, in a flat shape (fields an operation does not use are "" or []):
 * - rename `feature` to `title`;
 * - move every file of `clusters` into the existing feature `feature`;
 * - create `feature` with `title` and `aliases` from every file of `clusters`;
 * - merge `feature` into `into` (it becomes a redirect);
 * - split `feature` into `targets`, new features each taking its files in their `clusters` (it
 *   becomes a disambiguation page);
 * - retire `feature`, which must have no files left.
 */
export const ManifestOperation = z.object({
  kind: z.enum(["rename", "move", "create", "merge", "split", "retire"]),
  feature: z.string(),
  title: z.string(),
  aliases: z.array(z.string()),
  clusters: z.array(z.string()),
  into: z.string(),
  targets: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      aliases: z.array(z.string()),
      clusters: z.array(z.string()),
    }),
  ),
});
export type ManifestOperation = z.infer<typeof ManifestOperation>;

/** What the drift call returns: the operations, in the order they apply; none is an answer. */
export const ManifestOperations = z.object({ operations: z.array(ManifestOperation) });
export type ManifestOperations = z.infer<typeof ManifestOperations>;

/** Problems listed back to the model; the rest are counted. */
const MAX_PROBLEMS = 20;
const MAX_QUOTED = 80;
const quote = (text: string): string => {
  const chars = [...text];
  return JSON.stringify(
    chars.length <= MAX_QUOTED ? text : `${chars.slice(0, MAX_QUOTED).join("")}…`,
  );
};

export interface AppliedOperations {
  /** The revised manifest, or null when a problem stops it. */
  manifest: Manifest | null;
  /**
   * Active features whose files or title the operations changed, sorted: each gets a page
   * written whole, `reason: "manifest-change"`. Merged, split and retired features get none.
   */
  affected: string[];
  /** Every rule the operations break; empty when `manifest` is set. */
  problems: string[];
}

/**
 * Applies the drift call's operations, in order, to `manifest` (the update's membership at `sha`,
 * not yet revised), with lineage events at `sha` so status and lineage agree (spec §5 rule 1).
 * Ids are permanent: a new id must be new to the manifest, and no feature is removed. A cluster
 * is used by one operation at most. Every rule broken is reported, and then nothing is applied.
 */
export function applyOperations(
  manifest: Manifest,
  operations: readonly ManifestOperation[],
  clusters: readonly Cluster[],
  sha: string,
): AppliedOperations {
  const problems: string[] = [];
  const features = new Map<string, Feature>(
    manifest.features.map((f) => [f.id, structuredClone(f)]),
  );
  const membership: Record<string, Membership> = structuredClone(manifest.membership);
  const filesOf = new Map(clusters.map((c) => [c.id, c.files]));
  const usedClusters = new Set<string>();
  const changed = new Set<string>();
  const isActive = (id: string) => features.get(id)?.status.kind === "active";
  const titleTaken = (title: string, except?: string) =>
    [...features.values()].some(
      (f) => f.id !== except && f.title.trim().toLowerCase() === title.trim().toLowerCase(),
    );

  const checkTitle = (where: string, title: string, except?: string): boolean => {
    const trimmed = title.trim();
    const length = [...trimmed].length;
    const before = problems.length;
    if (trimmed === "") problems.push(`${where} has an empty title`);
    else if (titleTaken(trimmed, except))
      problems.push(`${where}: the title ${quote(trimmed)} is taken`);
    if (length > MAX_TITLE_LENGTH) {
      problems.push(
        `${where} has a title of ${length} characters; use at most ${MAX_TITLE_LENGTH}`,
      );
    }
    if (controlCharacters(trimmed).length > 0) {
      problems.push(`${where} has a control or invisible character in its title`);
    }
    return problems.length === before;
  };
  const checkNew = (
    where: string,
    id: string,
    title: string,
    aliases: readonly string[],
  ): string[] | null => {
    const before = problems.length;
    if (!FeatureId.safeParse(id).success || id.length > MAX_FEATURE_ID_LENGTH) {
      problems.push(
        `${where}: ${quote(id)} is not a kebab-case slug of at most ${MAX_FEATURE_ID_LENGTH} characters`,
      );
    } else if (features.has(id)) {
      problems.push(`${where}: ${quote(id)} is already a feature id; ids are never reused`);
    }
    checkTitle(where, title);
    const clean = cleanAliases(title, aliases).filter((a) => aliasProblem(a) === null);
    if (clean.length < MIN_ALIASES) {
      problems.push(
        `${where} has ${clean.length} usable aliases; give ${MIN_ALIASES} to ${MAX_ALIASES}`,
      );
    }
    return problems.length === before ? clean.slice(0, MAX_ALIASES) : null;
  };
  const takeClusters = (where: string, ids: readonly string[]): string[] | null => {
    const files: string[] = [];
    let ok = ids.length > 0;
    if (!ok) problems.push(`${where} names no cluster`);
    for (const id of ids) {
      const inCluster = filesOf.get(id);
      if (inCluster === undefined) {
        problems.push(`${where}: cluster ${quote(id)} does not exist`);
        ok = false;
      } else if (usedClusters.has(id)) {
        problems.push(`${where}: cluster ${quote(id)} is used by two operations`);
        ok = false;
      } else {
        usedClusters.add(id);
        files.push(...inCluster);
      }
    }
    return ok ? files : null;
  };
  /** Moves files (with their symbols) to `to`, noting which features gave them up. */
  const moveFiles = (files: ReadonlySet<string>, to: string) => {
    for (const [member, entry] of Object.entries(membership)) {
      const path = parseMemberId(member)?.path;
      if (path === undefined || !files.has(path) || entry.featureId === to) continue;
      changed.add(entry.featureId);
      membership[member] = { ...entry, featureId: to };
    }
    changed.add(to);
  };
  const filesOfFeature = (id: string): string[] =>
    Object.entries(membership).flatMap(([member, entry]) => {
      const parsed = parseMemberId(member);
      return entry.featureId === id && parsed !== null && parsed.symbol === null
        ? [parsed.path]
        : [];
    });

  operations.forEach((op, n) => {
    const where = `operation ${n + 1} (${op.kind} ${quote(op.feature)})`;
    const feature = features.get(op.feature);
    if (op.kind !== "create" && !isActive(op.feature)) {
      problems.push(`${where}: ${quote(op.feature)} is not an active feature`);
      return;
    }
    switch (op.kind) {
      case "rename": {
        const title = op.title.trim();
        if (feature === undefined || !checkTitle(where, title, feature.id)) return;
        feature.lineage.push({ kind: "rename", sha, fromTitle: feature.title });
        if (!feature.aliases.includes(feature.title)) feature.aliases.push(feature.title);
        feature.title = title;
        changed.add(feature.id);
        return;
      }
      case "move": {
        const files = takeClusters(where, op.clusters);
        if (files !== null) moveFiles(new Set(files), op.feature);
        return;
      }
      case "create": {
        const aliases = checkNew(where, op.feature, op.title, op.aliases);
        const files = takeClusters(where, op.clusters);
        if (aliases === null || files === null) return;
        features.set(op.feature, {
          id: op.feature,
          title: op.title.trim(),
          aliases,
          status: { kind: "active" },
          lineage: [{ kind: "create", sha }],
        });
        moveFiles(new Set(files), op.feature);
        return;
      }
      case "merge": {
        if (op.into === op.feature || !isActive(op.into)) {
          problems.push(`${where}: ${quote(op.into)} is not another active feature`);
          return;
        }
        moveFiles(new Set(filesOfFeature(op.feature)), op.into);
        if (feature === undefined) return;
        feature.status = { kind: "redirect", to: op.into };
        feature.lineage.push({ kind: "merge", sha, into: op.into });
        changed.delete(op.feature);
        return;
      }
      case "split": {
        if (op.targets.length < 2) {
          problems.push(`${where} needs at least two targets`);
          return;
        }
        const own = new Set(filesOfFeature(op.feature));
        const placed: [string, Set<string>][] = [];
        for (const target of op.targets) {
          const at = `${where}, target ${quote(target.id)}`;
          const aliases = checkNew(at, target.id, target.title, target.aliases);
          const files = takeClusters(at, target.clusters);
          if (aliases === null || files === null) return;
          features.set(target.id, {
            id: target.id,
            title: target.title.trim(),
            aliases,
            status: { kind: "active" },
            lineage: [{ kind: "create", sha }],
          });
          placed.push([target.id, new Set(files.filter((f) => own.has(f)))]);
        }
        const left = [...own].filter((f) => !placed.some(([, files]) => files.has(f)));
        if (left.length > 0) {
          problems.push(
            `${where} leaves ${left.length} of its files without a target; list their clusters`,
          );
          return;
        }
        for (const [id, files] of placed) moveFiles(files, id);
        if (feature === undefined) return;
        feature.status = { kind: "disambiguation", to: op.targets.map((t) => t.id) };
        feature.lineage.push({ kind: "split", sha, into: op.targets.map((t) => t.id) });
        changed.delete(op.feature);
        return;
      }
      case "retire": {
        const left = filesOfFeature(op.feature).length;
        if (left > 0) {
          problems.push(
            `${where} would leave ${left} files without a feature; move or merge them first`,
          );
          return;
        }
        if (feature === undefined) return;
        feature.status = { kind: "retired" };
        feature.lineage.push({ kind: "retire", sha });
        changed.delete(op.feature);
        return;
      }
    }
  });
  for (const feature of features.values()) {
    if (feature.status.kind === "active" && filesOfFeature(feature.id).length === 0) {
      problems.push(`${quote(feature.id)} would have no files; merge or retire it`);
    }
  }
  if (problems.length > 0) {
    const listed = problems.slice(0, MAX_PROBLEMS);
    if (problems.length > MAX_PROBLEMS)
      listed.push(`and ${problems.length - MAX_PROBLEMS} more problems`);
    return { manifest: null, affected: [], problems: listed };
  }
  const revised = Manifest.safeParse({ sha, features: [...features.values()], membership });
  if (!revised.success) {
    return { manifest: null, affected: [], problems: ["the operations leave an invalid manifest"] };
  }
  const affected = [...changed].filter((id) => isActive(id)).sort();
  return { manifest: revised.data, affected, problems: [] };
}
