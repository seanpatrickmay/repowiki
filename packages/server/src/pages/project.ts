import {
  ATTESTATION_VERSION,
  ATTESTATIONS,
  type DraftRevision,
  GENERATED_LABEL,
  type Generation,
  JOB_STEPS,
  type Job,
  type JobStatus,
  type JobStep,
  PLATFORM,
  type Plan,
  type Preview,
  type Project,
  type ProjectState,
  type PublishedVersion,
  REFUSALS,
  type Review,
  rebuildOffer,
} from "@repowiki/hosted";
import type { PreviewBuildState } from "../routes/preview-state.ts";
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
  /** A preview build still running in the background, or why the last one saved nothing. */
  previewBuild: PreviewBuildState | null;
  current: PublishedVersion | null;
  /** The owner's plan: what the page offers after a build (rebuildOffer). */
  plan: Plan;
  session: PageSession;
}

/** A project's state in the words a student uses (the persona review). */
export const STATE_WORDS: Record<ProjectState, string> = {
  draft: "Not published yet",
  published: "Published",
  withdrawn: "Taken down",
  purged: "Deleted",
};

/** What each step of a build does, in a student's words rather than the pipeline's. */
const STEP_WORDS: Record<JobStep, string> = {
  fetch: "Copying the repository",
  index: "Reading the code",
  cluster: "Grouping the files into features",
  manifest: "Planning the pages",
  write: "Writing the pages",
  verify: "Checking the citations",
  people: "Reading who made which commits",
  facts: "Working out your part",
  render: "Building the pages",
};

const STATUS_WORDS: Record<JobStatus, string> = {
  queued: "waiting to start",
  running: "in progress",
  succeeded: "done",
  failed: "failed",
  cancelled: "cancelled",
};

const field = (name: string, value: string | number) =>
  `<input type="hidden" name="${e(name)}" value="${e(String(value))}">`;
const form = (action: string, session: PageSession, inner: string, cls = "") =>
  `<form method="post" action="${e(action)}"${cls ? ` class="${cls}"` : ""}>${field("csrf", session.csrf)}${inner}</form>`;
const isActive = (job: Job | null) =>
  job !== null && (job.status === "queued" || job.status === "running");

/** The rebuild or refresh the plan offers, as a form; empty when it offers neither. */
function rebuildForm(v: ProjectView): string {
  const offer = rebuildOffer(v.plan, v.project);
  if (offer === null) return "";
  const action = `/projects/${v.project.id}/refresh`;
  if (offer === "refresh") {
    return form(
      action,
      v.session,
      `<button class="secondary">Refresh from the latest commit</button>`,
    );
  }
  return form(
    action,
    v.session,
    `<button class="secondary">Rebuild from the latest commit</button><p class="muted">Free includes one rebuild before you publish. It writes the entry again; a rebuild that fails doesn't count.</p>`,
  );
}

/** What the author can do about the last job: cancel it, retry it, rebuild, or start again (M14e A2). */
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
  if (job.status !== "failed") return rebuildForm(v);
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
  return rebuildForm(v);
}

function jobSection(v: ProjectView): string {
  const { job } = v;
  if (job === null) return "";
  const active = isActive(job);
  const steps = JOB_STEPS.map((step) => {
    const done = job.step !== null && JOB_STEPS.indexOf(step) < JOB_STEPS.indexOf(job.step);
    const current = job.step === step && active;
    const label = current ? `<strong>${STEP_WORDS[step]}</strong> …` : STEP_WORDS[step];
    return `<li${done ? ' class="muted"' : ""}>${label}</li>`;
  }).join("");
  const why =
    job.refusal === null ? "" : `<p class="notice">${e(REFUSALS[job.refusal].message)}</p>`;
  const title = `${job.kind === "refresh" ? "Refreshing your entry" : "Building your entry"}: ${STATUS_WORDS[job.status]}`;
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
  return `<section class="card"><h2>Draft ${revision.number}</h2><p class="muted">Written by an AI model from the repository and its git history. Your entry shows this paragraph beside the opening of the project's wiki; the preview shows both pages as readers will see them.</p>
<h3>Contribution</h3><p>${e(revision.content.contribution)}</p><p class="muted">${e(GENERATED_LABEL(generation.commitSha, "you"))}</p></section>`;
}

function reviewSection(v: ProjectView): string {
  const { revision, review, project, session } = v;
  if (revision === null) return "";
  if (review !== null && review.revision === revision.number) {
    return `<section class="card"><h2>Review</h2><p>You confirmed draft ${revision.number}.</p></section>`;
  }
  const inner = `${field("revision", revision.number)}<label><input type="checkbox" name="attest" value="yes"> ${e(ATTESTATIONS[ATTESTATION_VERSION])}</label><button>Confirm</button>`;
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
  const state = v.previewBuild?.revision === revision.number ? v.previewBuild : null;
  const build =
    state?.kind === "building"
      ? `<p>Building the preview of draft ${revision.number}. This page refreshes when it is ready.</p>`
      : `${state?.kind === "failed" ? `<p class="error">${e(state.message)}</p>` : ""}${form(
          `${base}/preview`,
          session,
          `${field("revision", revision.number)}<button class="secondary">${preview?.revision === revision.number ? "Build a new preview" : "Build a preview"}</button>`,
        )}`;
  const ready =
    preview !== null && preview.revision === revision.number
      ? `${form(`${base}/preview/open`, session, `${field("revision", revision.number)}<button class="secondary">Open the preview</button>`)}<p class="muted">The preview opens at a private link that works for one hour. Anyone with the link can see it in that hour.</p>${form(
          `${base}/publish`,
          session,
          `${field("revision", revision.number)}${field("expectedVersion", current?.version ?? project.currentVersion)}${field("previewHash", preview.siteHash)}<button>Publish what the preview shows</button>`,
        )}`
      : `<p class="muted">Build a preview first: publishing makes public exactly what the preview shows.</p>`;
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
    head:
      (isActive(v.job) && v.revision === null) ||
      (v.previewBuild?.kind === "building" && v.previewBuild.revision === v.revision?.number)
        ? '<meta http-equiv="refresh" content="3">'
        : "",
    body: `<h1>${e(v.project.slug)}</h1>${repo}<p class="muted">${STATE_WORDS[v.project.state]}</p>${jobSection(v)}${content(v)}${reviewSection(v)}${publishSection(v)}`,
    session: v.session,
  });
}
