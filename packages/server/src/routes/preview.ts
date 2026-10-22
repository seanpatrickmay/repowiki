import {
  authorize,
  biographyEntry,
  biographyName,
  type Project,
  REFUSALS,
  type RefusalCode,
} from "@repowiki/hosted";
import { type Deps, logOf, nameOf } from "../app.ts";
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
import { previewBuildStates } from "./preview-state.ts";

/** Built-site responses (Pagefind needs WebAssembly; Mermaid sets inline styles). */
export const SITE_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** Where a preview tree lives: written once under its own hash, never rewritten (M14e A1). */
export const previewKey = (projectId: string, revision: number, siteHash: string) =>
  `previews/${projectId}/r${revision}/${siteHash}/`;

/** The path a project's wiki is served under (ADR-0013). */
export const siteBase = (handle: string, slug: string) => `/${handle}/${slug}/`;
/** The path of an author's biography, which each of their wikis links to (ADR-0013). */
export const authorUrl = (handle: string) => `/${handle}`;

const TEXT = /^(text\/|application\/(json|javascript|xml))/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One file of a stored tree; a directory serves its index.html. Text files have each `[from, to]`
 * of `rewrites` applied wherever `from` starts a path, not inside another URL such as the GitHub
 * link `github.com/<owner>/<repo>/…`, so a preview's links stay inside the preview (spec 2 S13);
 * with none, the bytes are served as stored.
 */
export async function serveTreeFile(
  objects: ObjectStore,
  prefix: string,
  rest: string,
  rewrites: readonly (readonly [string, string])[] = [],
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
  if (rewrites.length === 0 || !TEXT.test(object.contentType)) {
    return { body: object.body, contentType: object.contentType };
  }
  let text = new TextDecoder().decode(object.body);
  for (const [from, to] of rewrites) {
    text = text.replace(new RegExp(`(?<![A-Za-z0-9.:_~-])${escapeRe(from)}`, "g"), to);
  }
  return { body: text, contentType: object.contentType };
}

/**
 * How long a preview request waits for its build before answering and letting the build finish
 * in the background: a site build can take minutes on a shared CPU.
 */
/** What the project page says when a background build failed for no stated reason. */
const BUILD_FAILED = "The preview could not be built. Try again.";

export const PREVIEW_WAIT_MS = 2000;

export interface PreviewRouteOptions {
  /** Milliseconds a request waits for its build (PREVIEW_WAIT_MS in production); default: all. */
  waitMs?: number;
}

/** Building a revision's exact site and serving it privately to its owner (spec 2 S13, §7). */
export function previewRoutes(
  deps: Deps,
  build = buildTree,
  options: PreviewRouteOptions = {},
): Route[] {
  /** Accounts with a preview build in flight; one each (M14e A3). */
  const building = new Set<string>();
  const states = previewBuildStates(deps);
  const waitMs = options.waitMs ?? Number.POSITIVE_INFINITY;
  const handleOf = async (session: Session) =>
    (await activeHandle(deps.db, session.account.id)) ?? session.account.login.toLowerCase();

  /** The build's answer, and its refusal code when it saved no preview. */
  async function buildPreview(
    session: Session,
    project: Project,
    revision: number,
  ): Promise<{ reply: Reply; code: RefusalCode | null }> {
    const shown = pageSession(session);
    const back = `/projects/${project.id}`;
    /** A refusal, audited in its own transaction (spec 2 S5). */
    const refused = async (code: RefusalCode) => {
      await deps.db.transaction((tx) => auditAuthor(tx, deps, "preview.build", project.id, code));
      return { reply: refusalPage(code, shown, { back }), code };
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
    const handle = await handleOf(session);
    const { login, displayName } = session.account;
    const tree = await build({
      exp: hosted,
      base: siteBase(handle, project.slug),
      repoUrl: `https://github.com/${repo}`,
      entry: new TextEncoder().encode(JSON.stringify(entry)),
      author: { name: biographyName(displayName, login), url: authorUrl(handle) },
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
    return saved === null ? { reply: redirect(back), code: null } : refused(saved);
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
        const revision = Number(form.get("revision"));
        states.set(project.id, { kind: "building", revision });
        const settled = buildPreview(session, project, revision)
          .then(
            ({ reply, code }) => {
              if (code === null) states.delete(project.id);
              else
                states.set(project.id, {
                  kind: "failed",
                  revision,
                  message: REFUSALS[code].message,
                });
              return reply;
            },
            (error: unknown) => {
              states.set(project.id, { kind: "failed", revision, message: BUILD_FAILED });
              throw error;
            },
          )
          .finally(() => building.delete(account));
        if (waitMs === Number.POSITIVE_INFINITY) return settled;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const waited = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), waitMs);
        });
        const first = await Promise.race([settled, waited]).finally(() => clearTimeout(timer));
        if (first !== null) return first;
        // Too slow to wait for: the project page shows it building, then its outcome.
        settled.catch((error: unknown) => logOf(deps)({ preview: "failed", error: nameOf(error) }));
        return redirect(`/projects/${project.id}`);
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
        // With no active handle there is no public path to show or rewrite (review M4).
        const handle = await activeHandle(deps.db, project.accountId);
        if (handle === null) return notFound;
        if (rest === "") {
          if (!request.path.endsWith("/")) return moved(base);
          const entry = await storedEntry(deps.objects, preview.siteKey);
          if (entry === null) return notFound;
          // This revision in place of the project's published version, beside the others.
          const others = (await publishedEntries(deps, owner.id))
            .filter((p) => p.projectId !== project.id)
            .map((p) => ({
              slug: p.slug,
              href: `/${handle}/${p.slug}/`,
              entry: p.entry,
              publishedAt: p.publishedAt,
            }));
          const mine = { slug: project.slug, href: wiki, entry };
          const options = { asOf: deps.now(), self: base, preview: true };
          return html(200, biographyPage(deps, owner, [mine, ...others], options), PREVIEW_HEADERS);
        }
        if (rest === project.slug) return moved(wiki);
        if (!rest.startsWith(`${project.slug}/`)) return notFound;
        // The wiki's own paths, and its link to the biography (ADR-0013), stay in the preview.
        const file = await serveTreeFile(
          deps.objects,
          `${preview.siteKey}${SITE_DIR}`,
          rest.slice(project.slug.length + 1),
          [
            [siteBase(handle, project.slug), wiki],
            [`${authorUrl(handle)}"`, `${base}"`],
          ],
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
