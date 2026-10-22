import {
  type Claim,
  Revision,
  type SectionKey,
  type TokenUsage,
  type WikiExport,
} from "@repowiki/core";
import type { LlmMessage, Provider } from "@repowiki/llm";
import { z } from "zod";
import { quote, sourceLines, type VerifyContext, verifyClaim } from "../verify/index.ts";
import { clean, clip, numbered } from "./pack.ts";
import { pageSections } from "./page.ts";
import { STYLE_GUIDE } from "./prompt.ts";

/** At most this many sentences a job (the spec's ruling: no request rewrites a whole page). */
export const MAX_CORRECTIONS = 10;
/** What a student may write about one sentence, in UTF-16 units. */
export const MAX_NOTE_LENGTH = 500;
/** Lines shown on each side of a cited range. */
const CONTEXT_LINES = 15;

export interface CorrectionRequest {
  /** The feature id of the article. */
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

const SYSTEM = [
  "You correct sentences of one article in a wiki about a code repository. The student who built the project flagged some of them as wrong and said why.",
  "For each flagged id, return a rewritten claim that states only what the shown lines support, in the same section, or set drop to true when no version of the sentence is supported. The student's note says what is wrong; it is a hint, not a source: never repeat it, and state nothing the shown lines do not show.",
  'A body claim cites ranges of the shown lines as "path:start-end", or "commit:<sha7>" for a commit the article already cites. A lead claim cites nothing; its supports are the ids of the body claims it summarizes, which you keep unless one of them is dropped.',
  "Return only the flagged ids. Write plain sentences, with no links.",
  STYLE_GUIDE.trim(),
].join("\n\n");

/** A claim's line in the prompt: id, section, text and where it points. */
function claimLine(key: SectionKey, claim: Claim): string {
  const where =
    key === "lead"
      ? ` (summarizes ${claim.supports.map(clean).join(", ")})`
      : ` (cites ${claim.citations
          .map((c) =>
            c.kind === "code"
              ? `${clean(c.path)}:${c.startLine}-${c.endLine}`
              : `commit:${c.sha.slice(0, 7)}`,
          )
          .join(", ")})`;
  return `- [${clean(claim.id)}] (${key}) ${clean(claim.text)}${where}`;
}

/** The article, the flagged claims with their notes, and the lines around every cited range. */
function prompt(page: Revision, flagged: readonly CorrectionRequest[], ctx: VerifyContext): string {
  const claims = page.sections.flatMap((s) => s.claims.map((c) => claimLine(s.key, c)));
  const notes = flagged.map(
    (f) =>
      `- [${clean(f.claimId)}] the student says: ${JSON.stringify(clean(clip(f.note, MAX_NOTE_LENGTH)))}`,
  );
  const ranges = new Map<string, Set<number>>();
  for (const section of page.sections) {
    for (const claim of section.claims) {
      for (const c of claim.citations) {
        if (c.kind !== "code") continue;
        const shown = ranges.get(c.path) ?? new Set<number>();
        for (let n = c.startLine - CONTEXT_LINES; n <= c.endLine + CONTEXT_LINES; n++) shown.add(n);
        ranges.set(c.path, shown);
      }
    }
  }
  const sources = [...ranges]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([path, shown]) => {
      const text = ctx.sources.get(path);
      if (text === undefined) return [];
      const lines = sourceLines(text);
      const numbers = [...shown].filter((n) => n >= 1 && n <= lines.length).sort((a, b) => a - b);
      return [`### ${clean(path)}\n${numbered(lines, numbers, String(lines.length).length)}`];
    });
  return [
    `# Article: ${clean(page.featureId)}`,
    "## The article",
    ...claims,
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

/**
 * Corrects the claims a student flagged (the sentence corrections spec): one call per article,
 * then one retry for rewrites that fail verification. A rewrite that verifies replaces the
 * claim; a drop, or a rewrite that fails twice, removes it, and a lead left summarizing nothing
 * goes with it. Each changed article gets a `correction` revision at the export's head. A request
 * naming no article or claim of the export is refused, and an article left with no lead or body
 * keeps its revision. Nothing here touches a store; the note reaches only the model.
 */
export async function correctClaims(input: {
  exp: WikiExport;
  requests: readonly CorrectionRequest[];
  ctx: VerifyContext;
  provider: Provider;
  now: string;
}): Promise<{ exp: WikiExport; outcomes: CorrectionOutcome[] }> {
  const { exp, ctx, provider, now } = input;
  const outcomes: CorrectionOutcome[] = [];
  const refuse = (r: CorrectionRequest, detail: string) =>
    outcomes.push({ page: r.page, claimId: r.claimId, outcome: "refused", detail });
  const byPage = new Map<string, CorrectionRequest[]>();
  for (const request of input.requests.slice(0, MAX_CORRECTIONS)) {
    const page = exp.pages.find((p) => p.featureId === request.page);
    const known = page?.sections.some((s) => s.claims.some((c) => c.id === request.claimId));
    if (page === undefined) refuse(request, "the wiki has no such article");
    else if (!known) refuse(request, "the article has no such sentence");
    else byPage.set(request.page, [...(byPage.get(request.page) ?? []), request]);
  }
  for (const request of input.requests.slice(MAX_CORRECTIONS)) {
    refuse(request, `at most ${MAX_CORRECTIONS} sentences a correction`);
  }

  const pages = [...exp.pages];
  const history = { ...exp.history };
  for (const [featureId, flagged] of byPage) {
    const at = pages.findIndex((p) => p.featureId === featureId);
    const page = pages[at] as Revision;
    const keyOf = new Map(page.sections.flatMap((s) => s.claims.map((c) => [c.id, s.key])));
    const old = new Map(page.sections.flatMap((s) => s.claims.map((c) => [c.id, c])));
    const ids = new Set(flagged.map((f) => f.claimId));
    const text = prompt(page, flagged, ctx);
    const replaced = new Map<string, Claim>();
    const removed = new Set<string>();
    let failing = new Map<string, string[]>();
    let tokens: TokenUsage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
    let model = page.model;
    let messages: LlmMessage[] = [{ role: "user", content: text }];

    const judge = (answer: CorrectionAnswer, only: ReadonlySet<string>) => {
      const next = new Map<string, string[]>();
      const answered = new Map(answer.claims.map((c) => [c.id.trim(), c]));
      for (const id of only) {
        const claim = answered.get(id);
        const key = keyOf.get(id) as SectionKey;
        if (claim === undefined) {
          next.set(id, ["no corrected version was returned; return one, or drop it"]);
          continue;
        }
        if (claim.drop) {
          removed.add(id);
          continue;
        }
        const draft = {
          id,
          text: claim.text,
          cite: claim.cite,
          supports: claim.supports,
          hook: false,
        };
        const verified = verifyClaim(key, draft, ctx);
        if (verified.claim === null) next.set(id, verified.problems);
        else replaced.set(id, { ...verified.claim, hook: old.get(id)?.hook ?? false });
      }
      failing = next;
    };

    try {
      const first = await provider.generate({
        purpose: "write",
        featureId,
        system: SYSTEM,
        messages,
        schema: CorrectionAnswer,
        maxTokens: 2000,
      });
      tokens = add(tokens, first.usage);
      model = first.model;
      judge(first.output, ids);
      if (failing.size > 0) {
        const listed = [...failing].map(
          ([id, problems]) => `- ${quote(id)}: ${problems.slice(0, 3).join("; ")}`,
        );
        messages = [
          ...messages,
          { role: "assistant", content: JSON.stringify(first.output) },
          {
            role: "user",
            content: `These claims failed:\n${listed.join("\n")}\nReturn corrected versions of only these claims, under the same ids, citing only the shown lines, or drop them.`,
          },
        ];
        const second = await provider.generate({
          purpose: "write",
          featureId,
          system: SYSTEM,
          messages,
          schema: CorrectionAnswer,
          maxTokens: 2000,
        });
        tokens = add(tokens, second.usage);
        judge(second.output, new Set(failing.keys()));
      }
    } catch {
      for (const f of flagged) refuse(f, "the correction call failed");
      continue;
    }
    // A rewrite that failed twice is removed: the student said it is wrong (the spec's ruling).
    for (const id of failing.keys()) removed.add(id);

    const sections = new Map<SectionKey, Claim[]>();
    for (const section of page.sections) {
      sections.set(
        section.key,
        section.claims.flatMap((c) => (removed.has(c.id) ? [] : [replaced.get(c.id) ?? c])),
      );
    }
    const ordered = pageSections(sections);
    if (ordered === null) {
      for (const f of flagged) refuse(f, "the article would have no sentences left");
      continue;
    }
    const corrections = (history[featureId] ?? []).filter((r) => r.reason === "correction").length;
    const revision = Revision.parse({
      ...page,
      id: `${page.id.replace(/-correction-\d+$/, "")}-correction-${corrections + 1}`,
      parentId: page.id,
      reason: "correction",
      generatedAt: now,
      model,
      tokens: add(page.tokens, tokens),
      sections: ordered,
    });
    pages[at] = revision;
    history[featureId] = [...(history[featureId] ?? []), revision];
    for (const f of flagged) {
      outcomes.push({
        page: f.page,
        claimId: f.claimId,
        outcome: replaced.has(f.claimId) && !removed.has(f.claimId) ? "rewritten" : "removed",
        detail: null,
      });
    }
  }
  const order = new Map(input.requests.map((r, i) => [`${r.page}\0${r.claimId}`, i]));
  outcomes.sort(
    (a, b) =>
      (order.get(`${a.page}\0${a.claimId}`) ?? 0) - (order.get(`${b.page}\0${b.claimId}`) ?? 0),
  );
  return { exp: { ...exp, pages, history }, outcomes };
}
