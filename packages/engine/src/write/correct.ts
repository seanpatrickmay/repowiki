import {
  Architecture,
  type ArchitectureClaim,
  ArchitectureSectionKey,
  type Claim,
  Revision,
  type SectionKey,
  type TokenUsage,
  type WikiExport,
} from "@repowiki/core";
import type { LlmMessage, Provider } from "@repowiki/llm";
import { z } from "zod";
import {
  type ArchitectureContext,
  quote,
  sourceLines,
  type VerifyContext,
  verifyArchitectureClaim,
  verifyClaim,
} from "../verify/index.ts";
import { clean, clip, numbered } from "./pack.ts";
import { createClaimLinker, orderedSections, pageSections } from "./page.ts";
import { STYLE_GUIDE } from "./prompt.ts";

/** At most this many sentences a job (the spec's ruling: no request rewrites a whole page). */
export const MAX_CORRECTIONS = 10;
/** What a student may write about one sentence, in UTF-16 units. */
export const MAX_NOTE_LENGTH = 500;
/** The `page` of a request for the About article, which has no feature id. */
export const ABOUT_ARTICLE = "@about";
/** Lines shown on each side of a cited range. */
const CONTEXT_LINES = 15;
/** Sites shown for each edge a flagged About claim may state. */
const SITES_PER_EDGE = 3;

export interface CorrectionRequest {
  /** The feature id of the article, or ABOUT_ARTICLE. */
  page: string;
  /** The claim's id in that article's current revision in the export. */
  claimId: string;
  /** Why the student says it is wrong: a hint for the model, never stored. */
  note: string;
}

export interface CorrectionOutcome {
  page: string;
  claimId: string;
  /** Rewritten from the code, removed because no version held up, or not attempted. */
  outcome: "rewritten" | "removed" | "refused";
  detail: string | null;
}

const AnsweredClaim = z.object({
  id: z.string(),
  /** True when no version of the sentence is supported by the lines shown. */
  drop: z.boolean(),
  text: z.string(),
  cite: z.array(z.string()),
  supports: z.array(z.string()),
});
/** What one correction call returns: a rewrite or a drop for each flagged id. */
export const CorrectionAnswer = z.object({ claims: z.array(AnsweredClaim) });
export type CorrectionAnswer = z.infer<typeof CorrectionAnswer>;
/** The About article's answer: a body claim may also name the feature pages that back it. */
export const AboutCorrectionAnswer = z.object({
  claims: z.array(AnsweredClaim.extend({ pages: z.array(z.string()) })),
});
export type AboutCorrectionAnswer = z.infer<typeof AboutCorrectionAnswer>;
type Answered = CorrectionAnswer["claims"][number] & { pages?: string[] };

const SYSTEM = [
  "You correct sentences of one article in a wiki about a code repository. The student who built the project flagged some of them as wrong and said why.",
  "For each flagged id, return a rewritten claim that states only what the shown lines support, in the same section, or set drop to true when no version of the sentence is supported. The student's note says what is wrong; it is a hint, not a source: never repeat it, and state nothing the shown lines do not show.",
  'A body claim cites ranges of the shown lines as "path:start-end", or "commit:<sha7>" for a commit the article already cites. A lead claim cites nothing; its supports are the ids of the body claims it summarizes, which you keep unless one of them is dropped.',
  "In the project's About article, a body claim may also name in pages the ids of at most 3 listed feature pages that back it, and a dependencies claim cites a listed edge's site and names only the two features it joins.",
  "Return only the flagged ids. Link another feature's page only as [[feature-id]] or [[feature-id|words]], as the article does; cite nothing in the text.",
  STYLE_GUIDE.trim(),
].join("\n\n");

/** A claim's line in the prompt: id, section, text and where it points. */
function claimLine(key: string, claim: Claim & { pages?: string[] }): string {
  if (key === "lead") {
    return `- [${clean(claim.id)}] (lead) ${clean(claim.text)} (summarizes ${claim.supports.map(clean).join(", ")})`;
  }
  const refs = [
    ...claim.citations.map((c) =>
      c.kind === "code"
        ? `${clean(c.path)}:${c.startLine}-${c.endLine}`
        : `commit:${c.sha.slice(0, 7)}`,
    ),
    ...(claim.pages ?? []).map((id) => `page ${clean(id)}`),
  ];
  return `- [${clean(claim.id)}] (${key}) ${clean(claim.text)} (cites ${refs.join(", ")})`;
}

/** One article to correct: its sections, and how a rewrite of one of its claims is checked. */
interface Target<C extends Claim> {
  title: string;
  sections: readonly { key: string; claims: readonly C[] }[];
  schema: typeof CorrectionAnswer | typeof AboutCorrectionAnswer;
  /** Extra lines for the prompt (the About article's pages and edges). */
  extra: string[];
  /** Lines to show besides the cited ranges: path to line numbers. */
  sites: ReadonlyMap<string, readonly number[]>;
  verify(
    key: string,
    answered: Answered,
    shown: ReadonlyMap<string, ReadonlySet<number>>,
  ): { claim: C | null; problems: string[] };
}

/** The lines shown for an article: every cited range and every extra site, with context. */
function shownLines<C extends Claim>(
  target: Target<C>,
  ctx: VerifyContext,
): Map<string, Set<number>> {
  const ranges = new Map<string, Set<number>>();
  const show = (path: string, start: number, end: number) => {
    const text = ctx.sources.get(path);
    if (text === undefined) return;
    const count = sourceLines(text).length;
    const shown = ranges.get(path) ?? new Set<number>();
    const last = Math.min(count, end + CONTEXT_LINES);
    for (let n = Math.max(1, start - CONTEXT_LINES); n <= last; n++) shown.add(n);
    ranges.set(path, shown);
  };
  for (const section of target.sections) {
    for (const claim of section.claims) {
      for (const c of claim.citations) if (c.kind === "code") show(c.path, c.startLine, c.endLine);
    }
  }
  for (const [path, lines] of target.sites) for (const line of lines) show(path, line, line);
  return ranges;
}

/** The article, any extra lines, the flagged claims with their notes, and the lines shown. */
function prompt<C extends Claim>(
  target: Target<C>,
  flagged: readonly CorrectionRequest[],
  ctx: VerifyContext,
  shown: ReadonlyMap<string, ReadonlySet<number>>,
): string {
  const claims = target.sections.flatMap((s) => s.claims.map((c) => claimLine(s.key, c)));
  const notes = flagged.map(
    (f) =>
      `- [${clean(f.claimId)}] the student says: ${JSON.stringify(clean(clip(f.note, MAX_NOTE_LENGTH)))}`,
  );
  const sources = [...shown]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, lines]) => {
      const all = sourceLines(ctx.sources.get(path) ?? "");
      const numbers = [...lines].sort((a, b) => a - b);
      return `### ${clean(path)}\n${numbered(all, numbers, String(all.length).length)}`;
    });
  return [
    `# Article: ${clean(target.title)}`,
    "## The article",
    ...claims,
    ...target.extra,
    "## Flagged",
    ...notes,
    `## Source at ${ctx.sha.slice(0, 7)}`,
    ...sources,
    "Correct the flagged claims.",
  ].join("\n");
}

const add = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  in: a.in + b.in,
  out: a.out + b.out,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

interface Corrected<C> {
  /** Each section's claims after the correction, flagged ones replaced or removed. */
  claims: Map<string, C[]>;
  rewritten: Set<string>;
  tokens: TokenUsage;
  model: string | null;
}

/**
 * One call for an article's flagged claims, and one retry for rewrites that fail their check. A
 * drop, or a rewrite that fails twice, removes the claim (the spec's ruling: the student said it
 * is wrong). Throws when a call fails.
 */
async function correctArticle<C extends Claim>(
  target: Target<C>,
  flagged: readonly CorrectionRequest[],
  featureId: string | null,
  ctx: VerifyContext,
  provider: Provider,
): Promise<Corrected<C>> {
  const keyOf = new Map(target.sections.flatMap((s) => s.claims.map((c) => [c.id, s.key])));
  const hookOf = new Map(target.sections.flatMap((s) => s.claims.map((c) => [c.id, c.hook])));
  const shown = shownLines(target, ctx);
  const replaced = new Map<string, C>();
  const removed = new Set<string>();
  let failing = new Map<string, string[]>();
  let tokens: TokenUsage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  let model: string | null = null;
  const judge = (answer: { claims: readonly Answered[] }, only: ReadonlySet<string>) => {
    const next = new Map<string, string[]>();
    const answered = new Map(answer.claims.map((c) => [c.id.trim(), c]));
    for (const id of only) {
      const claim = answered.get(id);
      if (claim === undefined) {
        next.set(id, ["no corrected version was returned; return one, or drop it"]);
      } else if (claim.drop) {
        removed.add(id);
      } else {
        const verified = target.verify(keyOf.get(id) ?? "", { ...claim, id }, shown);
        if (verified.claim === null) next.set(id, verified.problems);
        else replaced.set(id, { ...verified.claim, hook: hookOf.get(id) ?? false });
      }
    }
    failing = next;
  };
  const call = async (messages: LlmMessage[]): Promise<{ claims: Answered[] }> => {
    const result = await provider.generate<{ claims: Answered[] }>({
      purpose: "write",
      featureId,
      system: SYSTEM,
      messages,
      schema: target.schema,
      maxTokens: 2000,
    });
    tokens = add(tokens, result.usage);
    model = result.model;
    return result.output;
  };

  const messages: LlmMessage[] = [{ role: "user", content: prompt(target, flagged, ctx, shown) }];
  const first = await call(messages);
  judge(first, new Set(flagged.map((f) => f.claimId)));
  if (failing.size > 0) {
    const listed = [...failing].map(
      ([id, problems]) => `- ${quote(id)}: ${problems.slice(0, 3).join("; ")}`,
    );
    const second = await call([
      ...messages,
      { role: "assistant", content: JSON.stringify(first) },
      {
        role: "user",
        content: `These claims failed:\n${listed.join("\n")}\nReturn corrected versions of only these claims, under the same ids, citing only the shown lines, or drop them.`,
      },
    ]);
    judge(second, new Set(failing.keys()));
  }
  for (const id of failing.keys()) removed.add(id);

  const claims = new Map<string, C[]>();
  for (const section of target.sections) {
    claims.set(
      section.key,
      section.claims.flatMap((c) => (removed.has(c.id) ? [] : [replaced.get(c.id) ?? c])),
    );
  }
  const rewritten = new Set([...replaced.keys()].filter((id) => !removed.has(id)));
  return { claims, rewritten, tokens, model };
}

/** The feature-page target: claims checked by verifyClaim, as the write step checks them. */
function pageTarget(page: Revision, ctx: VerifyContext): Target<Claim> {
  return {
    title: page.featureId,
    sections: page.sections,
    schema: CorrectionAnswer,
    extra: [],
    sites: new Map(),
    verify: (key, answered) =>
      verifyClaim(
        key as SectionKey,
        {
          id: answered.id,
          text: answered.text,
          cite: answered.cite,
          supports: answered.supports,
          hook: false,
        },
        ctx,
      ),
  };
}

/**
 * The About article's target: claims checked by verifyArchitectureClaim against the lines shown,
 * the export's pages and the edges given, which are listed for the model with their first sites.
 */
function aboutTarget(
  article: Architecture,
  exp: WikiExport,
  ctx: VerifyContext,
  edges: ArchitectureContext["edges"],
): Target<ArchitectureClaim> {
  const pages = new Set(exp.pages.map((p) => p.featureId));
  const titleOf = new Map(exp.manifest.features.map((f) => [f.id, f.title]));
  const sites = new Map<string, number[]>();
  for (const edge of edges) {
    for (const site of edge.sites.slice(0, SITES_PER_EDGE)) {
      sites.set(site.path, [...(sites.get(site.path) ?? []), site.line]);
    }
  }
  const edgeLine = (e: ArchitectureContext["edges"][number]) =>
    `- ${clean(e.from)} -> ${clean(e.to)} at ${e.sites
      .slice(0, SITES_PER_EDGE)
      .map((s) => `${clean(s.path)}:${s.line}`)
      .join(", ")}`;
  return {
    title: article.title,
    sections: article.sections,
    schema: AboutCorrectionAnswer,
    extra: [
      "## Feature pages",
      ...[...pages].sort().map((id) => `- ${clean(id)}: ${clean(titleOf.get(id) ?? id)}`),
      ...(edges.length === 0 ? [] : ["## Cross-feature edges", ...edges.map(edgeLine)]),
    ],
    sites,
    verify: (key, answered, shown) =>
      verifyArchitectureClaim(
        key as ArchitectureSectionKey,
        {
          id: answered.id,
          text: answered.text,
          cite: answered.cite,
          supports: answered.supports,
          pages: answered.pages ?? [],
        },
        { ...ctx, pages, shown, edges },
      ),
  };
}

/**
 * Corrects the claims a student flagged (the sentence corrections spec): one call per article,
 * then one retry for rewrites that fail verification. A rewrite that verifies replaces the claim,
 * linked as a built claim is; a drop, or a rewrite that fails twice, removes it, and a lead left
 * summarizing nothing goes with it. Each changed feature page gets a `correction` revision at the
 * export's head, and the About article (page ABOUT_ARTICLE, checked against `edges`) its next
 * revision. A request naming no article or claim of the export is refused, as is every request of
 * an article whose call failed or that would be left with no lead or body. Nothing here touches a
 * store; the note reaches only the model.
 */
export async function correctClaims(input: {
  exp: WikiExport;
  requests: readonly CorrectionRequest[];
  ctx: VerifyContext;
  provider: Provider;
  now: string;
  /** The cross-feature edges at the export's head, for the About article's dependencies. */
  edges?: ArchitectureContext["edges"];
}): Promise<{ exp: WikiExport; outcomes: CorrectionOutcome[] }> {
  const { exp, ctx, provider, now } = input;
  const outcomes: CorrectionOutcome[] = [];
  const refuse = (r: CorrectionRequest, detail: string) =>
    outcomes.push({ page: r.page, claimId: r.claimId, outcome: "refused", detail });
  const report = (flagged: readonly CorrectionRequest[], rewritten: ReadonlySet<string>) => {
    for (const f of flagged) {
      const outcome = rewritten.has(f.claimId) ? "rewritten" : "removed";
      outcomes.push({ page: f.page, claimId: f.claimId, outcome, detail: null });
    }
  };
  const about = exp.architecture.at(-1);
  const sectionsOf = (page: string) =>
    page === ABOUT_ARTICLE
      ? about?.sections
      : exp.pages.find((p) => p.featureId === page)?.sections;
  const byPage = new Map<string, CorrectionRequest[]>();
  input.requests.forEach((request, i) => {
    const sections = sectionsOf(request.page);
    if (i >= MAX_CORRECTIONS) refuse(request, `at most ${MAX_CORRECTIONS} sentences a correction`);
    else if (sections === undefined) refuse(request, "the wiki has no such article");
    else if (!sections.some((s) => s.claims.some((c) => c.id === request.claimId)))
      refuse(request, "the article has no such sentence");
    else byPage.set(request.page, [...(byPage.get(request.page) ?? []), request]);
  });

  const pages = [...exp.pages];
  const history = { ...exp.history };
  const architecture = [...exp.architecture];
  const noneLeft = (flagged: readonly CorrectionRequest[]) => {
    for (const f of flagged) refuse(f, "the article would have no sentences left");
  };
  for (const [page, flagged] of byPage) {
    const linkClaim = createClaimLinker(
      exp.manifest,
      page === ABOUT_ARTICLE ? "" : page,
      new Map(),
    );
    try {
      if (page === ABOUT_ARTICLE && about !== undefined) {
        const target = aboutTarget(about, exp, ctx, input.edges ?? []);
        const done = await correctArticle(target, flagged, null, ctx, provider);
        const link = (c: ArchitectureClaim) => (done.rewritten.has(c.id) ? linkClaim(c) : c);
        const linked = new Map(
          [...done.claims].map(([key, claims]) => [
            key as ArchitectureSectionKey,
            claims.map(link),
          ]),
        );
        const sections = orderedSections(ArchitectureSectionKey.options, linked);
        if (sections === null) {
          noneLeft(flagged);
          continue;
        }
        architecture.push(
          Architecture.parse({
            ...about,
            id: `architecture-${about.sha.slice(0, 12)}-${architecture.length + 1}`,
            parentId: about.id,
            reason: "correction",
            pr: null,
            generatedAt: now,
            model: done.model ?? about.model,
            tokens: add(about.tokens, done.tokens),
            sections,
          }),
        );
        report(flagged, done.rewritten);
        continue;
      }
      const at = pages.findIndex((p) => p.featureId === page);
      const revision = pages[at] as Revision;
      const done = await correctArticle(pageTarget(revision, ctx), flagged, page, ctx, provider);
      const link = (c: Claim) => (done.rewritten.has(c.id) ? linkClaim(c) : c);
      const sections = pageSections(
        new Map([...done.claims].map(([key, claims]) => [key as SectionKey, claims.map(link)])),
      );
      if (sections === null) {
        noneLeft(flagged);
        continue;
      }
      const corrections = (history[page] ?? []).filter((r) => r.reason === "correction").length;
      const corrected = Revision.parse({
        ...revision,
        id: `${revision.id.replace(/-correction-\d+$/, "")}-correction-${corrections + 1}`,
        parentId: revision.id,
        reason: "correction",
        generatedAt: now,
        model: done.model ?? revision.model,
        tokens: add(revision.tokens, done.tokens),
        sections,
      });
      pages[at] = corrected;
      history[page] = [...(history[page] ?? []), corrected];
      report(flagged, done.rewritten);
    } catch {
      for (const f of flagged) refuse(f, "the correction call failed");
    }
  }
  const order = new Map(input.requests.map((r, i) => [`${r.page}\0${r.claimId}`, i]));
  const position = (o: CorrectionOutcome) => order.get(`${o.page}\0${o.claimId}`) ?? 0;
  outcomes.sort((a, b) => position(a) - position(b));
  return { exp: { ...exp, pages, history, architecture }, outcomes };
}
