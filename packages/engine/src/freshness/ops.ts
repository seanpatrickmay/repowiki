import {
  aliasProblem,
  type Feature,
  FeatureId,
  Manifest,
  type Membership,
  parseMemberId,
} from "@repowiki/core";
import { z } from "zod";
import type { Cluster } from "../cluster/index.ts";
import { linkNameKey } from "../link/index.ts";
import {
  aliasProblems,
  cleanAliases,
  limitProblems,
  MAX_ALIASES,
  MAX_FEATURE_ID_LENGTH,
  MIN_ALIASES,
  quote,
  titleProblems,
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
 * is used by one operation at most. Every title and alias an operation writes must differ, as a
 * link target (`linkNameKey`), from every other feature's id, title and aliases, so no existing
 * `[[…]]` link changes page. Only features the operations touch must end with files. Every rule
 * broken is reported, and then nothing is applied.
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
  /** Why `name` cannot be written for a feature other than `except`: another feature has it. */
  const takenBy = (name: string, except?: string): string | null => {
    const key = linkNameKey(name);
    for (const other of features.values()) {
      if (other.id === except) continue;
      const role =
        other.id === key
          ? "id"
          : linkNameKey(other.title) === key
            ? "title"
            : other.aliases.some((alias) => linkNameKey(alias) === key)
              ? "alias"
              : null;
      if (role !== null) return `is taken by ${quote(other.id)} as its ${role}`;
    }
    return null;
  };
  const checkName = (where: string, kind: string, name: string, except?: string): boolean => {
    const taken = takenBy(name, except);
    if (taken !== null) problems.push(`${where}: the ${kind} ${quote(name.trim())} ${taken}`);
    return taken === null;
  };
  const checkTitle = (where: string, title: string, except?: string): boolean => {
    const trimmed = title.trim();
    const own = titleProblems(where, trimmed);
    problems.push(...own);
    return own.length === 0 && checkName(where, "title", trimmed, except);
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
    } else checkName(where, "id", id);
    checkTitle(where, title);
    const clean = cleanAliases(title, aliases);
    const usable = clean.filter((a) => aliasProblem(a) === null);
    if (usable.length < MIN_ALIASES) {
      problems.push(
        `${where} has ${usable.length} usable aliases; give ${MIN_ALIASES} to ${MAX_ALIASES}`,
      );
    }
    problems.push(...aliasProblems(where, clean));
    for (const alias of usable) checkName(where, "alias", alias);
    return problems.length === before ? usable.slice(0, MAX_ALIASES) : null;
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
        if (feature === undefined) return;
        if (linkNameKey(title) === linkNameKey(feature.title)) {
          problems.push(`${where}: ${quote(title)} is already its title`);
          return;
        }
        // The old title becomes an alias (spec §5 rule 1), so it must be one M3 would accept.
        const keep = !feature.aliases.includes(feature.title);
        const before = problems.length;
        const unusable = aliasProblem(feature.title);
        if (keep && unusable !== null) {
          problems.push(
            `${where}: its old title ${quote(feature.title)} cannot be kept as an alias: it ${unusable}`,
          );
        }
        if (keep && feature.aliases.length + 1 > MAX_ALIASES) {
          problems.push(
            `${where}: it would have ${feature.aliases.length + 1} aliases; at most ${MAX_ALIASES}`,
          );
        }
        if (keep && unusable === null) checkName(where, "alias", feature.title, feature.id);
        const titleOk = checkTitle(where, title, feature.id);
        if (!titleOk || problems.length > before) return;
        feature.lineage.push({ kind: "rename", sha, fromTitle: feature.title });
        if (keep) feature.aliases.push(feature.title);
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
  // A feature the operations did not touch may already be empty; that is not theirs to refuse.
  for (const id of changed) {
    if (isActive(id) && filesOfFeature(id).length === 0) {
      problems.push(`${quote(id)} would have no files; merge or retire it`);
    }
  }
  if (problems.length > 0) {
    return { manifest: null, affected: [], problems: limitProblems(problems) };
  }
  const revised = Manifest.safeParse({ sha, features: [...features.values()], membership });
  if (!revised.success) {
    return { manifest: null, affected: [], problems: ["the operations leave an invalid manifest"] };
  }
  const affected = [...changed].filter((id) => isActive(id)).sort();
  return { manifest: revised.data, affected, problems: [] };
}
