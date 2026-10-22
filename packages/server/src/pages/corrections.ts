import type { Claim, WikiExport } from "@repowiki/core";
import { CORRECTION } from "@repowiki/hosted";
import { escapeHtml as e, type PageSession, page } from "./layout.ts";

/** A claim's text as a reader sees it, without the wiki's link and emphasis markup. */
export function plainClaim(text: string, titles: ReadonlyMap<string, string>): string {
  return text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_, id: string) => titles.get(id) ?? id.replace(/^wp:/, ""))
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

/** A section's heading: the lead is the article's opening. */
const sectionTitle = (key: string) =>
  key === "lead" ? "Opening" : `${key[0]?.toUpperCase() ?? ""}${key.slice(1).replace(/-/g, " ")}`;

const titlesOf = (exp: WikiExport) => new Map(exp.manifest.features.map((f) => [f.id, f.title]));

const HOW = `<p class="muted">Tick a sentence that's wrong and say what's wrong with it. RepoWiki rewrites it from the code it cites and checks the rewrite like every other sentence; if no version holds up, the sentence is removed. What you write only guides the rewrite: it is never shown, and it is deleted when the correction ends. Up to ${CORRECTION.items} sentences at a time.</p>`;

/** The articles of the draft's export, to choose one to correct. */
export function correctionsIndex(input: {
  projectId: string;
  slug: string;
  exp: WikiExport;
  session: PageSession;
}): string {
  const base = `/projects/${input.projectId}/corrections`;
  const titles = titlesOf(input.exp);
  const about =
    input.exp.architecture.length === 0
      ? ""
      : `<li><a href="${base}/about">About ${e(input.exp.architecture.at(-1)?.title ?? input.slug)}</a></li>`;
  const pages = [...input.exp.pages]
    .map((p) => ({ id: p.featureId, title: titles.get(p.featureId) ?? p.featureId }))
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((p) => `<li><a href="${base}/pages/${e(p.id)}">${e(p.title)}</a></li>`)
    .join("");
  return page({
    title: `Correct ${input.slug}`,
    body: `<h1>Correct a sentence</h1>${HOW}<section class="card"><h2>Choose the article</h2><ul>${about}${pages}</ul></section><p><a href="/projects/${e(input.projectId)}">Back to the project</a></p>`,
    session: input.session,
  });
}

/** One article's sentences in page order, each with a box to tick and a note to write. */
export function correctionForm(input: {
  projectId: string;
  title: string;
  action: string;
  generationId: string;
  sections: readonly { key: string; claims: readonly Claim[] }[];
  exp: WikiExport;
  session: PageSession;
}): string {
  const titles = titlesOf(input.exp);
  const sections = input.sections
    .map((section) => {
      const sentences = section.claims
        .map(
          (c) =>
            `<li><label><input type="checkbox" name="claim" value="${e(c.id)}"> ${e(plainClaim(c.text, titles))}</label><textarea name="note-${e(c.id)}" maxlength="${CORRECTION.noteLength}" rows="2" placeholder="What's wrong with it?"></textarea></li>`,
        )
        .join("");
      return `<h3>${e(sectionTitle(section.key))}</h3><ol class="sentences">${sentences}</ol>`;
    })
    .join("");
  const fields = `<input type="hidden" name="csrf" value="${e(input.session.csrf)}"><input type="hidden" name="generation" value="${e(input.generationId)}">`;
  return page({
    title: `Correct ${input.title}`,
    body: `<h1>Correct ${e(input.title)}</h1>${HOW}<form method="post" action="${e(input.action)}">${fields}<section class="card">${sections}</section><button>Correct the ticked sentences</button></form><p><a href="/projects/${e(input.projectId)}/corrections">Choose another article</a></p>`,
    session: input.session,
  });
}
