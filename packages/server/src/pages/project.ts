import {
  ATTESTATION_VERSION,
  ATTESTATIONS,
  type DraftRevision,
  GENERATED_LABEL,
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
  // The page reloads itself only before there is an editor to type into (fresh review I4).
  const progress =
    active && v.revision !== null
      ? `<p class="muted">Refreshing… <a href="/projects/${e(v.project.id)}">reload</a> to see progress.</p>`
      : "";
  return `<section class="card"><h2>${e(title)}</h2>${progress}<ol>${steps}</ol>${why}${jobActions(v)}</section>`;
}

/**
 * The revision's generated content, read-only: the author reviews it and edits nothing
 * (ADR-0012). The biography quotes it beside the wiki's About lead (ADR-0013).
 */
function content(v: ProjectView): string {
  const { revision, generation } = v;
  if (revision === null || generation === null) return "";
  return `<section class="card"><h2>Revision ${revision.number}</h2><p class="muted">Generated from the repository and its git history. Your biography quotes this contribution beside the first sentences of the wiki's About article; the preview shows both pages as readers will see them.</p>
<h3>Contribution</h3><p>${e(revision.content.contribution)}</p><p class="muted">${e(GENERATED_LABEL(generation.commitSha))}</p></section>`;
}

function reviewSection(v: ProjectView): string {
  const { revision, review, project, session } = v;
  if (revision === null) return "";
  if (review !== null && review.revision === revision.number) {
    return `<section class="card"><h2>Review</h2><p>You reviewed revision ${revision.number}.</p></section>`;
  }
  const inner = `${field("revision", revision.number)}<label><input type="checkbox" name="attest" value="yes"> ${e(ATTESTATIONS[ATTESTATION_VERSION])}</label><button>Record review</button>`;
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
      ? `${form(`${base}/preview/open`, session, `${field("revision", revision.number)}<button class="secondary">Open the preview of revision ${revision.number}</button>`)}<p class="muted">The preview opens on the public pages' site at a private link that works for an hour.</p>${form(
          `${base}/publish`,
          session,
          `${field("revision", revision.number)}${field("expectedVersion", current?.version ?? project.currentVersion)}${field("previewHash", preview.siteHash)}<button>Publish revision ${revision.number}</button>`,
        )}`
      : `<p class="muted">Build a preview of the latest revision before publishing.</p>`;
  return `<section class="card"><h2>Preview and publish</h2>${live}${build}${ready}</section>`;
}

/**
 * The author's working page for one project (spec 2 §7); reloads itself while the first
 * generation runs, and never once there is a revision being edited.
 */
export function projectPage(v: ProjectView): string {
  const repo = v.repoFullName === null ? "" : `<p class="muted">${e(v.repoFullName)}</p>`;
  return page({
    title: v.project.slug,
    head: isActive(v.job) && v.revision === null ? '<meta http-equiv="refresh" content="3">' : "",
    body: `<h1>${e(v.project.slug)}</h1>${repo}<p class="muted">State: ${e(v.project.state)}</p>${jobSection(v)}${content(v)}${reviewSection(v)}${publishSection(v)}`,
    session: v.session,
  });
}
