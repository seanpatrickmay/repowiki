import { authorize, type Project, type RefusalCode } from "@repowiki/hosted";
import type { Deps } from "../app.ts";
import type { Reply, Route } from "../http/router.ts";
import { html, redirect } from "../http/server.ts";
import type { Session } from "../http/session.ts";
import { assertKey, contentTypeFor, type ObjectStore } from "../objects/store.ts";
import { page } from "../pages/layout.ts";
import { pageSession, refusalPage } from "../pages/refusal.ts";
import { buildTree } from "../render/build.ts";
import { hostedExport } from "../render/hosted-export.ts";
import { PortfolioData, portfolioData, portfolioHtml } from "../render/portfolio.ts";
import { activeHandle } from "../store/accounts.ts";
import { generationById, latestRevision, previewOf, savePreview } from "../store/drafts.ts";
import { mintPreviewToken, previewByToken } from "../store/preview-tokens.ts";
import { projectById } from "../store/projects.ts";
import { auditAuthor, mutation, storedExport } from "./drafts.ts";
import { ownedProject, repoFullName } from "./live.ts";

/** Built-site responses (Pagefind needs WebAssembly; Mermaid sets inline styles). */
export const SITE_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** Where a preview tree lives: written once under its own hash, never rewritten (M14e A1). */
export const previewKey = (projectId: string, revision: number, siteHash: string) =>
  `previews/${projectId}/r${revision}/${siteHash}/`;

/** The path a project's site is served under; its wiki is at `<base>docs/`. */
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
    const data = portfolioData({ generation, revision: latest, exp: hosted, repoFullName: repo });
    const tree = await build({
      exp: hosted,
      base: `${siteBase(await handleOf(session), project.slug)}docs/`,
      repoUrl: `https://github.com/${repo}`,
      portfolio: new TextEncoder().encode(JSON.stringify(data)),
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
        const preview = Number.isSafeInteger(revision)
          ? await previewOf(deps.db, project.id, revision)
          : null;
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

/** What every preview reply carries: never cached, never indexed, never a referrer (ADR-0012). */
const PREVIEW_HEADERS = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex",
  "referrer-policy": "no-referrer",
};

/**
 * The pages origin's preview links (ADR-0012): `/_preview/<token>/` serves the previewed portfolio
 * page and `/_preview/<token>/docs/…` its wiki, with the public wiki base rewritten into the link,
 * while the token lives. Anything else is a 404.
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
        const base = `/_preview/${token}/`;
        const rest = request.params["*"] ?? "";
        const moved = (location: string): Reply => ({
          status: 301,
          headers: { ...PREVIEW_HEADERS, location },
        });
        if (rest === "") {
          if (!request.path.endsWith("/")) return moved(base);
          const stored = await deps.objects.get(`${preview.siteKey}portfolio.json`);
          if (stored === null) return notFound;
          const data = PortfolioData.parse(JSON.parse(new TextDecoder().decode(stored.body)));
          const options = {
            base,
            publishedAt: null,
            preview: true,
            appOrigin: deps.config.appOrigin,
          };
          return html(200, portfolioHtml(data, options), PREVIEW_HEADERS);
        }
        if (rest === "docs") return moved(`${base}docs/`);
        if (!rest.startsWith("docs/")) return notFound;
        const handle = (await activeHandle(deps.db, project.accountId)) ?? "";
        const from = `${siteBase(handle, project.slug)}docs/`;
        const file = await serveTreeFile(deps.objects, preview.siteKey, rest, from, `${base}docs/`);
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
