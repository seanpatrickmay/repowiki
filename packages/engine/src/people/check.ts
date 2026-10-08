import {
  featureLinkTargets,
  linkRoutes,
  type Manifest,
  type PeopleSnapshot,
  type PersonRevision,
} from "@repowiki/core";
import type { AuthoredCommit } from "../index/index.ts";
import type { PersonPack } from "./pack.ts";
import type { PeopleRead } from "./refresh.ts";
import {
  commitFeaturesOf,
  pullRequestAuthors,
  pullRequestLandings,
  topologicalNewestFirst,
} from "./snapshot.ts";
import { personVerifyContext, verifyPersonClaim } from "./verify.ts";

export interface PeopleCheckInput {
  /** readPeople at the snapshot's sha: the identity map as it stands now. */
  read: PeopleRead;
  snapshot: PeopleSnapshot;
  /** The current narrative revisions. */
  revisions: readonly PersonRevision[];
  /** Every stored manifest, newest first (R19). */
  manifests: readonly Manifest[];
  /** The manifest a revision was written against. */
  manifestAt: (sha: string) => Manifest;
  /** The latest manifest and the features with a stored page: where a link must still route. */
  latest: Manifest;
  pages: ReadonlySet<string>;
}

/**
 * Re-verifies every current narrative of a person with a page (spec v2 #6 §9): each claim, as the
 * write round verified it, against the identity map as it stands, so a citation must still be
 * the person's own non-merge commit or a pull request landing they authored or merged (R17), and
 * the dates, names, words and statistics rules hold (R18); every [[id]] link names a feature of
 * the manifest the revision was written against, and one that was valid there still leads to a
 * page today (storedLinkViolations' rule, the Task 28 ruling). One line per problem, naming the person by
 * id only. Narratives of people not in the snapshot are not exported, so they are not checked.
 */
export function personRevisionProblems(input: PeopleCheckInput): string[] {
  const { read, snapshot } = input;
  const commits = topologicalNewestFirst(read.commits);
  const groupOf = (c: AuthoredCommit) => read.identities.groupOf(c.authorName, c.authorEmail);
  const landings = pullRequestLandings(commits, groupOf);
  const authors = pullRequestAuthors(landings, commits, groupOf);
  const commitFeatures = commitFeaturesOf(commits, input.manifests);
  const humans = new Set(snapshot.people.filter((p) => p.kind === "human").map((p) => p.id));
  const problems: string[] = [];
  const routes = linkRoutes(input.latest, input.pages);
  for (const revision of input.revisions) {
    if (!humans.has(revision.personId)) continue;
    const group = read.assigned.ids.indexOf(revision.personId);
    const where = `person ${revision.personId} (${revision.id})`;
    if (group === -1) {
      problems.push(`${where}: no identity group has this id`);
      continue;
    }
    // Every commit the person could cite: their own, and the landings of their pull requests.
    const dates = new Map<string, string>();
    for (const c of commits)
      if (c.parents.length <= 1 && groupOf(c) === group) dates.set(c.sha, c.authorDate);
    for (const l of landings.values())
      if (l.merger === group || authors.get(l.number) === group) dates.set(l.sha, l.mergedAt);
    const pack = { personId: revision.personId, shas: new Set(dates.keys()), dates } as PersonPack;
    const manifest = input.manifestAt(revision.sha);
    const ctx = personVerifyContext(
      { sha: snapshot.sha, commits: read.commits, identities: read.identities, commitFeatures },
      group,
      pack,
      manifest,
    );
    const ownKind = new Map(manifest.features.map((f) => [f.id, f.status.kind]));
    for (const section of revision.sections) {
      for (const claim of section.claims) {
        const draft = {
          id: claim.id,
          text: claim.text,
          cite: claim.citations.map((c) =>
            c.kind === "commit" ? `commit:${c.sha}` : `${c.path}:${c.startLine}-${c.endLine}`,
          ),
          supports: claim.supports,
        };
        const found = [...verifyPersonClaim(section.key, draft, ctx).problems];
        for (const target of new Set(featureLinkTargets(claim.text))) {
          const kind = ownKind.get(target);
          if (kind === undefined) found.push(`links to nowhere: [[${target}]]`);
          else if ((kind === "active" || kind === "disambiguation") && !routes(target))
            found.push(`a link to ${target} no longer leads to a page`);
        }
        for (const problem of found) problems.push(`${where}: ${claim.id}: ${problem}`);
      }
    }
  }
  return problems;
}
