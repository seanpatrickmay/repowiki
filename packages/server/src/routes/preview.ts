import { authorize, biographyEntry, type Project, type RefusalCode } from "@repowiki/hosted";
import type { Deps } from "../app.ts";
import type { Reply, Route } from "../http/router.ts";
import { html, redirect } from "../http/server.ts";
import type { Session } from "../http/session.ts";
import { assertKey, contentTypeFor, type ObjectStore } from "../objects/store.ts";
import { page } from "../pages/layout.ts";
import { pageSession, refusalPage } from "../pages/refusal.ts";
import { buildTree, SITE_DIR } from "../render/build.ts";
import { hostedExport } from "../render/hosted-export.ts";
import { accountById, activeHandle } from "../store/accounts.ts";
import { generationById, latestRevision, previewOf, savePreview } from "../store/drafts.ts";
import { mintPreviewToken, previewByToken } from "../store/preview-tokens.ts";
import { projectById } from "../store/projects.ts";
import { biographyPage, publishedEntries, storedEntry } from "./biography-page.ts";
import { auditAuthor, mutation, storedExport } from "./drafts.ts";
import { ownedProject, repoFullName } from "./live.ts";

/** Built-site responses (Pagefind needs WebAssembly; Mermaid sets inline styles). */
export const SITE_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** Where a preview tree lives: written once under its own hash, never rewritten (M14e A1). */
export const previewKey = (projectId: string, revision: number, siteHash: string) =>
  `previews/${projectId}/r${revision}/${siteHash}/`;

/** The path a project's wiki is served under (ADR-0013). */
export const siteBase = (handle: string, slug: string) => `/${handle}/${slug}/`;

const TEXT = /^(text\/|application\/(json|javascript|xml))/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One file of a stored tree; a directory serves its index.html. Text files have the path `from`
 * (the public wiki base) rewritten to `to` wherever it starts a path, not inside another URL such
 * as the GitHub link `github.com/<owner>/<repo>/…`, so a preview's links stay inside the preview
 * (spec 2 S13); an empty `from` serves the bytes as stored.
 */
export async function serveTreeFile(
  objects: ObjectStore,
  prefix: string,
  rest: string,
  from = "",
  to = "",
): Promise<{ body: string | Uint8Array; contentType: string } | null> {
  const path = rest === "" || rest.endsWith("/") ? `${rest}index.html` : rest;
  const key = `${prefix}${path}`;
  try {
    assertKey(key);
  } catch {
    return null;
  }
  const last = path.split("/").at(-1) ?? "";
  const object =
    (await objects.get(key)) ??
    (last.includes(".") ? null : await objects.get(`${key}/index.html`));
  if (object === null) return null;
  if (from === "" || !TEXT.test(object.contentType)) {
    return { body: object.body, contentType: object.contentType };
  }
  const at = new RegExp(`(?<![A-Za-z0-9.:_~-])${escapeRe(from)}`, "g");
  const text = new TextDecoder().decode(object.body).replace(at, to);
  return { body: text, contentType: object.contentType };
}

/** Building a revision's exact site and serving it privately to its owner (spec 2 S13, §7). */
export function previewRoutes(deps: Deps, build = buildTree): Route[] {
  /** Accounts with a preview build in flight; one each (M14e A3). */
  const building = new Set<string>();
  const handleOf = async (session: Session) =>
    (await activeHandle(deps.db, session.account.id)) ?? session.account.login.toLowerCase();

  async function buildPreview(
    session: Session,
    project: Project,
    revision: number,
  ): Promise<Reply> {
    const shown = pageSession(session);
    const back = `/projects/${project.id}`;
    /** A refusal, audited in its own transaction (spec 2 S5). */
    const refused = async (code: RefusalCode) => {
      await deps.db.transaction((tx) => auditAuthor(tx, deps, "preview.build", project.id, code));
      return refusalPage(code, shown, { back });
    };
    const latest = await latestRevision(deps.db, project.id);
    if (latest === null || latest.number !== revision) return refused("stale-revision");
    const generation = await generationById(deps.db, latest.generationId);
    const exp = generation === null ? null : await storedExport(deps, generation);
    if (generation === null || exp === null) return refused("invalid-transition");
    const repo =
      (await repoFullName(deps.db, project.githubRepoId)) ?? `${session.account.login}/${exp.repo}`;
    const hosted = hostedExport(exp);
    const entry = biographyEntry({
      generation,
      contribution: latest.content.contribution,
      exp: hosted,
      repoFullName: repo,
    });
    const tree = await build({
      exp: hosted,
      base: siteBase(await handleOf(session), project.slug),
      repoUrl: `https://github.com/${repo}`,
      entry: new TextEncoder().encode(JSON.stringify(entry)),
    });
    const prefix = previewKey(project.id, revision, tree.hash);
    for (const file of tree.files) {
      await deps.objects.put(`${prefix}${file.path}`, file.bytes, contentTypeFor(file.path));
    }
    // The build took a while: the policy and "still the latest" are checked again with the
    // project locked, in the transaction that saves the preview.
    const saved = await deps.db.transaction(async (tx): Promise<RefusalCode | null> => {
      const now = deps.now();
      const locked = await ownedProject(tx, session, project.id, true);
      if (locked === null) return "not-found";
      const caller = { kind: "account" as const, account: session.account };
      const verdict = authorize("preview.read", { now, caller, project: locked });
      if (!verdict.ok) return verdict.code;
      if ((await latestRevision(tx, project.id))?.number !== revision) return "stale-revision";
      await savePreview(tx, {
        projectId: project.id,
        revision,
        siteKey: prefix,
        siteHash: tree.hash,
        createdAt: now,
      });
      await auditAuthor(tx, deps, "preview.build", project.id, "allowed");
      return null;
    });
    return saved === null ? redirect(back) : refused(saved);
  }

  return [
    {
      method: "POST",
      pattern: "/projects/:id/preview",
      handler: async (request) => {
        const { session, form } = await mutation(deps, request);
        const shown = pageSession(session);
        const project = await ownedProject(deps.db, session, request.params.id ?? "");
        if (project === null) return refusalPage("not-found", shown);
        const caller = { kind: "account" as const, account: session.account };
        const verdict = authorize("preview.read", { now: deps.now(), caller, project });
        if (!verdict.ok) {
          await deps.db.transaction((tx) =>
            auditAuthor(tx, deps, "preview.build", project.id, verdict.code),
          );
          return refusalPage(verdict.code, shown);
        }
        const account = session.account.id;
        if (building.has(account)) {
          const body = `<h1>Please wait</h1><p>A preview is already being built.</p><p><a href="/projects/${project.id}">Back</a></p>`;
          return html(429, page({ title: "Please wait", body, session: shown }), {
            "cache-control": "private, no-store",
          });
        }
        building.add(account);
        try {
          return await buildPreview(session, project, Number(form.get("revision")));
        } finally {
          building.delete(account);
        }
      },
    },
    {
      // A capability link to the preview on the pages origin (ADR-0012).
      method: "POST",
      pattern: "/projects/:id/preview/open",
      handler: async (request) => {
        const { session, form } = await mutation(deps, request);
        const shown = pageSession(session);
        const project = await ownedProject(deps.db, session, request.params.id ?? "");
        if (project === null) return refusalPage("not-found", shown);
        const caller = { kind: "account" as const, account: session.account };
        const verdict = authorize("preview.read", { now: deps.now(), caller, project });
        if (!verdict.ok) return refusalPage(verdict.code, shown);
        const revision = Number(form.get("revision"));
        // Only the latest revision is the one to review and publish (Contract §6.3).
        if (revision !== project.latestRevision) {
          return refusalPage("stale-revision", shown, { back: `/projects/${project.id}` });
        }
        const preview = await previewOf(deps.db, project.id, revision);
        if (preview === null) return refusalPage("not-found", shown);
        const token = await deps.db.transaction(async (tx) => {
          const minted = await mintPreviewToken(
            tx,
            { projectId: project.id, revision },
            deps.now(),
          );
          await auditAuthor(tx, deps, "preview.open", project.id, "allowed");
          return minted;
        });
        return redirect(`${deps.config.publicOrigin}/_preview/${token}/`);
      },
    },
  ];
}

/** A project whose preview may still be shown: not purged, taken down or being deleted. */
const previewable = (project: Project) =>
  project.state !== "purged" &&
  !(
    project.state === "withdrawn" &&
    (project.withdrawReason === "operator" || project.withdrawReason === "account-deleted")
  );

/** What every preview reply carries: never cached, never indexed, never a referrer (ADR-0012). */
const PREVIEW_HEADERS = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex",
  "referrer-policy": "no-referrer",
};

/**
 * The pages origin's preview links (ADR-0012, ADR-0013): `/_preview/<token>/` is the author's
 * biography as it will read with this revision published, and `/_preview/<token>/<slug>/…` the
 * revision's wiki, with the public wiki path rewritten into the link, while the token lives.
 * Anything else is a 404.
 */
export function previewPageRoutes(deps: Deps): Route[] {
  const notFound: Reply = {
    status: 404,
    headers: { ...PREVIEW_HEADERS, "content-type": "text/plain; charset=utf-8" },
    body: "Not found",
  };
  return [
    {
      method: "GET",
      pattern: "/_preview/:token/*",
      handler: async (request): Promise<Reply> => {
        const token = request.params.token ?? "";
        const target = await previewByToken(deps.db, token, deps.now());
        if (target === null) return notFound;
        const [project, preview] = await Promise.all([
          projectById(deps.db, target.projectId),
          previewOf(deps.db, target.projectId, target.revision),
        ]);
        if (project === null || preview === null) return notFound;
        // A link stops working the moment its project or its owner may no longer be shown.
        const owner = await accountById(deps.db, project.accountId);
        if (owner?.status !== "active" || !previewable(project)) return notFound;
        const base = `/_preview/${token}/`;
        const wiki = `${base}${project.slug}/`;
        const rest = request.params["*"] ?? "";
        const moved = (location: string): Reply => ({
          status: 301,
          headers: { ...PREVIEW_HEADERS, location },
        });
        const handle = (await activeHandle(deps.db, project.accountId)) ?? "";
        if (rest === "") {
          if (!request.path.endsWith("/")) return moved(base);
          const entry = await storedEntry(deps.objects, preview.siteKey);
          if (entry === null) return notFound;
          // This revision in place of the project's published version, beside the others.
          const others = (await publishedEntries(deps, owner.id))
            .filter((p) => p.projectId !== project.id)
            .map((p) => ({ slug: p.slug, href: `/${handle}/${p.slug}/`, entry: p.entry }));
          const mine = { slug: project.slug, href: wiki, entry };
          const options = { asOf: deps.now(), self: base, preview: true };
          return html(200, biographyPage(deps, owner, [mine, ...others], options), PREVIEW_HEADERS);
        }
        if (rest === project.slug) return moved(wiki);
        if (!rest.startsWith(`${project.slug}/`)) return notFound;
        const file = await serveTreeFile(
          deps.objects,
          `${preview.siteKey}${SITE_DIR}`,
          rest.slice(project.slug.length + 1),
          siteBase(handle, project.slug),
          wiki,
        );
        if (file === null) return notFound;
        return {
          status: 200,
          headers: {
            ...PREVIEW_HEADERS,
            "content-type": file.contentType,
            "content-security-policy": SITE_CSP,
          },
          body: file.body,
        };
      },
    },
  ];
}
