import {
  ATTESTATIONS,
  type DraftRevision,
  type Generation,
  JOB_STEPS,
  type Job,
  PLATFORM,
  type Preview,
  type Project,
  type PublishedVersion,
  REFUSALS,
  type Review,
} from "@repowiki/hosted";
import { escapeHtml as e, type PageSession, page } from "./layout.ts";

export interface ProjectView {
  project: Project;
  publicUrl: string;
  repoFullName: string | null;
  job: Job | null;
  revision: DraftRevision | null;
  generation: Generation | null;
  review: Review | null;
  preview: Preview | null;
  current: PublishedVersion | null;
  titles: ReadonlyMap<string, string>;
  session: PageSession;
}

const field = (name: string, value: string | number) =>
  `<input type="hidden" name="${e(name)}" value="${e(String(value))}">`;
const form = (action: string, session: PageSession, inner: string, cls = "") =>
  `<form method="post" action="${e(action)}"${cls ? ` class="${cls}"` : ""}>${field("csrf", session.csrf)}${inner}</form>`;
const isActive = (job: Job | null) =>
  job !== null && (job.status === "queued" || job.status === "running");

/** What the author can do about the last job: cancel it, retry it, or start again (M14e A2). */
function jobActions(v: ProjectView): string {
  const { job, project, session } = v;
  if (job === null) return "";
  const base = `/projects/${project.id}`;
  if (isActive(job)) {
    return form(
      `${base}/jobs/${job.id}/cancel`,
      session,
      `<button class="secondary">Cancel</button>`,
    );
  }
  if (job.status !== "failed") return "";
  const retryable =
    job.refusal !== null &&
    REFUSALS[job.refusal].retryable &&
    job.attempt < PLATFORM.jobMaxAttempts;
  if (retryable) return form(`${base}/jobs/${job.id}/retry`, session, "<button>Retry</button>");
  if (project.latestRevision === 0) {
    return form(
      "/projects",
      session,
      `${field("githubRepoId", project.githubRepoId)}<button>Start over</button>`,
    );
  }
  return form(
    `${base}/refresh`,
    session,
    `<button class="secondary">Refresh from the latest commit</button>`,
  );
}

function jobSection(v: ProjectView): string {
  const { job } = v;
  if (job === null) return "";
  const active = isActive(job);
  const steps = JOB_STEPS.map((step) => {
    const done = job.step !== null && JOB_STEPS.indexOf(step) < JOB_STEPS.indexOf(job.step);
    const current = job.step === step && active;
    const label = current ? `<strong>${e(step)}</strong> …` : e(step);
    return `<li${done ? ' class="muted"' : ""}>${label}</li>`;
  }).join("");
  const why =
    job.refusal === null ? "" : `<p class="notice">${e(REFUSALS[job.refusal].message)}</p>`;
  const title = `${job.kind === "refresh" ? "Refresh" : "Generation"}: ${job.status}`;
  return `<section class="card"><h2>${e(title)}</h2><ol>${steps}</ol>${why}${jobActions(v)}</section>`;
}

function editor(v: ProjectView): string {
  const { revision, generation, project, session, titles } = v;
  if (revision === null || generation === null) return "";
  const o = revision.overrides;
  const s = generation.suggestions;
  const flags =
    revision.flags.length === 0
      ? ""
      : `<p class="notice">Check these before review: ${revision.flags.map(e).join(", ")}</p>`;
  const rows = generation.facts.featureIds
    .map((id) => {
      const lit = o.highlights.find((h) => h.featureId === id);
      const hidden = o.hiddenFeatureIds.includes(id);
      return `<tr><td>${e(titles.get(id) ?? id)}</td>
<td><input type="checkbox" name="highlight" value="${e(id)}"${lit ? " checked" : ""} aria-label="Highlight"> <input name="blurb:${e(id)}" maxlength="140" value="${e(lit?.blurb ?? "")}" aria-label="Highlight text"></td>
<td><input type="checkbox" name="hidden" value="${e(id)}"${hidden ? " checked" : ""} aria-label="Hide"></td></tr>`;
    })
    .join("");
  const inner = `${field("baseRevision", revision.number)}
<label for="tagline">Tagline</label><input id="tagline" name="tagline" maxlength="90" value="${e(o.tagline ?? s.tagline)}">
<label for="summary">Summary</label><textarea id="summary" name="summary" maxlength="900">${e(o.summary ?? s.summary)}</textarea>
<label for="contribution">Your contribution</label><p class="muted">Required to publish. Describe your own work; the suggestion is only a start.</p>
<textarea id="contribution" name="contribution" maxlength="1200">${e(o.contribution || s.contributionDraft)}</textarea>
<table><thead><tr><th>Feature</th><th>Highlight (up to 4)</th><th>Hide</th></tr></thead><tbody>${rows}</tbody></table>
<button>Save</button>`;
  return `<section class="card"><h2>Portfolio (revision ${revision.number})</h2>${flags}${form(`/projects/${project.id}/revisions`, session, inner)}</section>`;
}

function reviewSection(v: ProjectView): string {
  const { revision, review, project, session } = v;
  if (revision === null) return "";
  if (review !== null && review.revision === revision.number) {
    return `<section class="card"><h2>Review</h2><p>You reviewed revision ${revision.number}.</p></section>`;
  }
  const inner = `${field("revision", revision.number)}<label><input type="checkbox" name="attest" value="yes"> ${e(ATTESTATIONS[1])}</label><button>Record review</button>`;
  return `<section class="card"><h2>Review</h2>${form(`/projects/${project.id}/review`, session, inner)}</section>`;
}

function publishSection(v: ProjectView): string {
  const { revision, preview, project, session, current, publicUrl } = v;
  if (revision === null) return "";
  const base = `/projects/${project.id}`;
  const live =
    project.state === "published"
      ? `<p>Live at <a href="${e(publicUrl)}">${e(publicUrl)}</a> (version ${project.currentVersion}).</p>${form(`${base}/unpublish`, session, `<button class="secondary">Unpublish</button>`)}`
      : "";
  const build = form(
    `${base}/preview`,
    session,
    `${field("revision", revision.number)}<button class="secondary">Build preview of revision ${revision.number}</button>`,
  );
  const ready =
    preview !== null && preview.revision === revision.number
      ? `<p><a href="/preview/${e(project.id)}/${revision.number}/">Open the preview of revision ${revision.number}</a></p>${form(
          `${base}/publish`,
          session,
          `${field("revision", revision.number)}${field("expectedVersion", current?.version ?? project.currentVersion)}${field("previewHash", preview.siteHash)}<button>Publish revision ${revision.number}</button>`,
        )}`
      : `<p class="muted">Build a preview of the latest revision before publishing.</p>`;
  return `<section class="card"><h2>Preview and publish</h2>${live}${build}${ready}</section>`;
}

/** The author's working page for one project (spec 2 §7); refreshes itself while a job runs. */
export function projectPage(v: ProjectView): string {
  const repo = v.repoFullName === null ? "" : `<p class="muted">${e(v.repoFullName)}</p>`;
  return page({
    title: v.project.slug,
    head: isActive(v.job) ? '<meta http-equiv="refresh" content="3">' : "",
    body: `<h1>${e(v.project.slug)}</h1>${repo}<p class="muted">State: ${e(v.project.state)}</p>${jobSection(v)}${editor(v)}${reviewSection(v)}${publishSection(v)}`,
    session: v.session,
  });
}
