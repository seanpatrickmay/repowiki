import { authorize, publish, type Result, unpublish } from "@repowiki/hosted";
import type { Deps } from "../app.ts";
import type { Route } from "../http/router.ts";
import { redirect } from "../http/server.ts";
import type { ObjectStore } from "../objects/store.ts";
import { pageSession, refusalPage } from "../pages/refusal.ts";
import { treeHash } from "../render/tree.ts";
import { latestRevision, previewOf, reviewOf, saveVersion, versionOf } from "../store/drafts.ts";
import { saveProject, usageFor } from "../store/projects.ts";
import { auditAuthor, mutation } from "./drafts.ts";
import { liveEligibility, ownedProject } from "./live.ts";

/**
 * Copy a stored tree byte for byte (Contract §6.4: publish promotes the exact preview), after
 * hashing what was read: a tree whose bytes no longer match `expectedHash` is not copied and
 * the copy answers false (M14e A1). `to` ends up holding exactly the tree. Both prefixes end
 * with "/".
 */
export async function copyTree(
  objects: ObjectStore,
  from: string,
  to: string,
  expectedHash: string,
): Promise<boolean> {
  if (!from.endsWith("/") || !to.endsWith("/"))
    throw new Error("copyTree prefixes must end with /");
  const files = [];
  for (const key of await objects.list(from)) {
    const object = await objects.get(key);
    if (object === null) return false;
    files.push({
      path: key.slice(from.length),
      bytes: object.body,
      contentType: object.contentType,
    });
  }
  if (treeHash(files) !== expectedHash) return false;
  // A publish that failed halfway may have left files at `to`. The version number is nobody's
  // until its row commits, so they are cleared; anything that survives refuses the copy.
  const leftovers = await objects.list(to);
  if (leftovers.length > 0) await objects.delete(leftovers);
  if ((await objects.list(to)).length > 0) return false;
  for (const file of files) await objects.put(`${to}${file.path}`, file.bytes, file.contentType);
  return true;
}

/** Publish and unpublish (Contract §6.4, spec 2 §7). */
export function publishRoutes(deps: Deps): Route[] {
  return [
    {
      method: "POST",
      pattern: "/projects/:id/publish",
      handler: async (request) => {
        const { session, form } = await mutation(deps, request);
        const shown = pageSession(session);
        const owned = await ownedProject(deps.db, session, request.params.id ?? "");
        if (owned === null) return refusalPage("not-found", shown);
        const live = await liveEligibility(deps, session, owned.githubRepoId);
        if (!live.ok) return live.reply;
        const back = `/projects/${owned.id}`;
        const revision = Number(form.get("revision"));
        const expectedVersion = Number(form.get("expectedVersion"));
        const previewHash = String(form.get("previewHash") ?? "");
        const result = await deps.db.transaction(async (tx): Promise<Result<true>> => {
          const project = await ownedProject(tx, session, owned.id, true);
          if (project === null) return { ok: false, code: "not-found" };
          const now = deps.now();
          const usage = await usageFor(tx, session.account.id, now);
          const caller = { kind: "account" as const, account: session.account };
          const context = { now, caller, project, facts: live.facts, usage };
          const verdict = authorize("project.publish", context);
          if (!verdict.ok) return verdict;
          const latest = await latestRevision(tx, project.id);
          if (latest === null) return { ok: false, code: "invalid-transition" };
          const asked = Number.isSafeInteger(revision) && revision > 0;
          const preview = asked ? await previewOf(tx, project.id, revision) : null;
          const current =
            project.currentVersion === 0
              ? null
              : await versionOf(tx, project.id, project.currentVersion);
          const published = publish({
            project,
            latest,
            review: asked ? await reviewOf(tx, project.id, revision) : null,
            preview,
            current,
            revision,
            expectedVersion,
            previewHash,
            authorization: live.facts,
            now,
          });
          if (!published.ok) return published;
          if (!published.value.created) return { ok: true, value: true };
          // The version row is written only once its files exist and still hash to the preview.
          const { version } = published.value;
          if (
            preview === null ||
            !(await copyTree(deps.objects, preview.siteKey, version.siteKey, preview.siteHash))
          ) {
            return { ok: false, code: "preview-mismatch" };
          }
          await saveVersion(tx, version);
          await saveProject(tx, published.value.project);
          await auditAuthor(tx, deps, "project.publish", project.id, "allowed");
          return { ok: true, value: true };
        });
        if (result.ok) return redirect(back);
        await deps.db.transaction((tx) =>
          auditAuthor(tx, deps, "project.publish", owned.id, result.code),
        );
        return refusalPage(result.code, shown, { back });
      },
    },
    {
      method: "POST",
      pattern: "/projects/:id/unpublish",
      handler: async (request) => {
        const { session } = await mutation(deps, request);
        const id = request.params.id ?? "";
        const result = await deps.db.transaction(async (tx): Promise<Result<true>> => {
          const project = await ownedProject(tx, session, id, true);
          if (project === null) return { ok: false, code: "not-found" };
          const caller = { kind: "account" as const, account: session.account };
          const verdict = authorize("project.unpublish", { now: deps.now(), caller, project });
          if (!verdict.ok) return verdict;
          const next = unpublish(project, deps.now());
          if (!next.ok) return next;
          await saveProject(tx, next.value);
          await auditAuthor(tx, deps, "project.unpublish", project.id, "allowed");
          return { ok: true, value: true };
        });
        const back = `/projects/${id}`;
        if (result.ok) return redirect(back);
        if ((await ownedProject(deps.db, session, id)) !== null) {
          await deps.db.transaction((tx) =>
            auditAuthor(tx, deps, "project.unpublish", id, result.code),
          );
        }
        return refusalPage(result.code, pageSession(session), { back });
      },
    },
  ];
}
