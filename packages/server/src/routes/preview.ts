import { authorize, type DraftRevision, type Generation, type Project } from "@repowiki/hosted";
import type { Deps } from "../app.ts";
import type { Reply, Route } from "../http/router.ts";
import { html, redirect } from "../http/server.ts";
import { currentSession, type Session } from "../http/session.ts";
import { assertKey, contentTypeFor, type ObjectStore } from "../objects/store.ts";
import { page } from "../pages/layout.ts";
import { pageSession, refusalPage } from "../pages/refusal.ts";
import { buildTree } from "../render/build.ts";
import { hostedExport } from "../render/hosted-export.ts";
import { PortfolioData, portfolioData, portfolioHtml } from "../render/portfolio.ts";
import { activeHandle } from "../store/accounts.ts";
import { generationById, latestRevision, previewOf, savePreview } from "../store/drafts.ts";
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

/** The resolved portfolio layer a revision previews; an unwritten contribution shows the draft. */
function previewData(
  generation: Generation,
  revision: DraftRevision,
  exp: Parameters<typeof portfolioData>[0]["exp"],
  repo: string,
) {
  const written = revision.overrides.contribution.trim() !== "";
  const contribution = written
    ? revision.overrides.contribution
    : generation.suggestions.contributionDraft || "Not written yet.";
  const shown = { ...revision, overrides: { ...revision.overrides, contribution } };
  return portfolioData({ generation, revision: shown, exp, repoFullName: repo });
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
    const latest = await latestRevision(deps.db, project.id);
    if (latest === null || latest.number !== revision)
      return refusalPage("stale-revision", shown, { back });
    const generation = await generationById(deps.db, latest.generationId);
    const exp = generation === null ? null : await storedExport(deps, generation);
    if (generation === null || exp === null)
      return refusalPage("invalid-transition", shown, { back });
    const repo =
      (await repoFullName(deps.db, project.githubRepoId)) ?? `${session.account.login}/${exp.repo}`;
    const hosted = hostedExport(exp, latest.overrides.hiddenFeatureIds);
    const data = previewData(generation, latest, hosted, repo);
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
    await deps.db.transaction(async (tx) => {
      const now = deps.now();
      await savePreview(tx, {
        projectId: project.id,
        revision,
        siteKey: prefix,
        siteHash: tree.hash,
        createdAt: now,
      });
      await auditAuthor(tx, deps, "preview.build", project.id, "allowed");
    });
    return redirect(back);
  }

  const notFound: Reply = {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
    body: "Not found",
  };

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
        if (!verdict.ok) return refusalPage(verdict.code, shown);
        const account = session.account.id;
        if (building.has(account)) {
          const body = `<h1>Please wait</h1><p>A preview is already being built.</p><p><a href="/projects/${project.id}">Back</a></p>`;
          return html(429, page({ title: "Please wait", body, session: shown }));
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
      method: "GET",
      pattern: "/preview/:id/:rev/*",
      handler: async (request): Promise<Reply> => {
        const session = await currentSession(deps.db, deps.config, request, deps.now());
        if (session === null) return notFound;
        const project = await ownedProject(deps.db, session, request.params.id ?? "");
        if (project === null) return notFound;
        const caller = { kind: "account" as const, account: session.account };
        if (!authorize("preview.read", { now: deps.now(), caller, project }).ok) return notFound;
        const revision = Number(request.params.rev);
        const preview = Number.isSafeInteger(revision)
          ? await previewOf(deps.db, project.id, revision)
          : null;
        if (preview === null) return notFound;
        const base = `/preview/${project.id}/${revision}/`;
        const rest = request.params["*"] ?? "";
        const headers = { "cache-control": "private, no-store" };
        if (rest === "") {
          if (!request.path.endsWith("/")) return redirect(base, 301);
          const stored = await deps.objects.get(`${preview.siteKey}portfolio.json`);
          if (stored === null) return notFound;
          const data = PortfolioData.parse(JSON.parse(new TextDecoder().decode(stored.body)));
          return html(
            200,
            portfolioHtml(data, { base, publishedAt: null, preview: true }),
            headers,
          );
        }
        if (rest === "docs") return redirect(`${base}docs/`, 301);
        if (!rest.startsWith("docs/")) return notFound;
        const from = `${siteBase(await handleOf(session), project.slug)}docs/`;
        const file = await serveTreeFile(deps.objects, preview.siteKey, rest, from, `${base}docs/`);
        if (file === null) return notFound;
        return {
          status: 200,
          headers: {
            ...headers,
            "content-type": file.contentType,
            "content-security-policy": SITE_CSP,
          },
          body: file.body,
        };
      },
    },
  ];
}
