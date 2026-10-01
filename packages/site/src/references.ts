import type { Citation, CodeCitation, CommitCitation, Revision } from "@repowiki/core";
import { escapeHtml } from "./inline.ts";

/** One footnote marker after a claim: [n], with a unique anchor for the back-link. */
export interface RefMarker {
  n: number;
  id: string;
}

/** One entry of the References list. backlinks are the marker ids that cite it, in order. */
export interface RefNote {
  n: number;
  citation: Citation;
  backlinks: string[];
}

export interface References {
  notes: RefNote[];
  /** Markers per claim id. */
  markers: ReadonlyMap<string, RefMarker[]>;
}

/** Identical citations share one number, as Wikipedia's named references do. */
export function citationKey(citation: Citation): string {
  return citation.kind === "code"
    ? `code ${citation.sha} ${citation.startLine} ${citation.endLine} ${citation.path}`
    : `commit ${citation.sha}`;
}

/** Numbers citations in reading order across the page's sections. */
export function collectReferences(revision: Revision): References {
  const byKey = new Map<string, RefNote>();
  const markers = new Map<string, RefMarker[]>();
  for (const section of revision.sections) {
    for (const claim of section.claims) {
      const claimMarkers: RefMarker[] = [];
      for (const citation of claim.citations) {
        const key = citationKey(citation);
        let note = byKey.get(key);
        if (note === undefined) {
          note = { n: byKey.size + 1, citation, backlinks: [] };
          byKey.set(key, note);
        }
        const id = `cite-ref-${note.n}-${note.backlinks.length}`;
        note.backlinks.push(id);
        claimMarkers.push({ n: note.n, id });
      }
      markers.set(claim.id, claimMarkers);
    }
  }
  return { notes: [...byKey.values()], markers };
}

export function markersHtml(markers: readonly RefMarker[]): string {
  return markers
    .map(
      (m) => `<sup class="reference" id="${m.id}"><a href="#cite-note-${m.n}">[${m.n}]</a></sup>`,
    )
    .join("");
}

/** "^" for a single use; "^ a b c" when several claims cite the same source. */
export function backlinksHtml(note: RefNote): string {
  if (note.backlinks.length === 1) {
    return `<a class="ref-back" href="#${note.backlinks[0]}" aria-label="Back to the citing claim">^</a>`;
  }
  const letters = note.backlinks.map(
    (id, i) =>
      `<a class="ref-back" href="#${id}" aria-label="Back to citing claim ${i + 1}">${String.fromCharCode(97 + (i % 26))}</a>`,
  );
  return `^ ${letters.join(" ")}`;
}

const short = (sha: string): string => sha.slice(0, 7);
const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

/** GitHub-style permalink to the cited lines at the cited sha. */
export function codeUrl(repoUrl: string, c: CodeCitation): string {
  const lines = c.endLine > c.startLine ? `L${c.startLine}-L${c.endLine}` : `L${c.startLine}`;
  return `${repoUrl}/blob/${c.sha}/${encodePath(c.path)}#${lines}`;
}

function link(href: string | null, html: string): string {
  return href === null ? html : `<a class="external" href="${escapeHtml(href)}">${html}</a>`;
}

/** A References entry: path:Lstart-end@sha for code, sha "subject" (PR #n) for commits. */
export function citationHtml(citation: Citation, repoUrl: string | null): string {
  return citation.kind === "code" ? codeHtml(citation, repoUrl) : commitHtml(citation, repoUrl);
}

function codeHtml(c: CodeCitation, repoUrl: string | null): string {
  const lines = c.endLine > c.startLine ? `L${c.startLine}-${c.endLine}` : `L${c.startLine}`;
  const label = `<code>${escapeHtml(c.path)}:${lines}@${short(c.sha)}</code>`;
  const symbol = c.symbol === null ? "" : ` (<code>${escapeHtml(c.symbol)}</code>)`;
  return link(repoUrl === null ? null : codeUrl(repoUrl, c), label) + symbol;
}

function commitHtml(c: CommitCitation, repoUrl: string | null): string {
  const sha = link(
    repoUrl === null ? null : `${repoUrl}/commit/${c.sha}`,
    `<code>${short(c.sha)}</code>`,
  );
  const pr =
    c.pr === null
      ? ""
      : ` (${link(repoUrl === null ? null : `${repoUrl}/pull/${c.pr}`, `PR #${c.pr}`)})`;
  return `Commit ${sha}: &quot;${escapeHtml(c.subject)}&quot;${pr}`;
}
