import { z } from "zod";

/** Every refusal a hosted rule can give (Contract spec §11), in the spec's order. */
export const REFUSAL_CODES = [
  "not-signed-in",
  "not-found",
  "github-token-revoked",
  "repo-private",
  "repo-fork",
  "repo-no-push",
  "repo-no-commits",
  "repo-too-large",
  "plan-project-limit",
  "plan-generation-limit",
  "plan-refresh-limit",
  "plan-correction-limit",
  "monthly-cost-ceiling",
  "account-too-new",
  "platform-paused",
  "job-active",
  "job-cost-cap",
  "job-interrupted",
  "job-failed",
  "correction-unchanged",
  "stale-revision",
  "stale-publication",
  "preview-mismatch",
  "not-reviewed",
  "frozen",
  "withdrawn",
  "restore-expired",
  "invalid-input",
  "invalid-transition",
  "account-deleting",
] as const;

export const RefusalCode = z.enum(REFUSAL_CODES);
export type RefusalCode = z.infer<typeof RefusalCode>;

export interface RefusalInfo {
  /** The HTTP status the server answers with. */
  status: number;
  /** Whether trying the same thing again later can succeed. */
  retryable: boolean;
  /** One plain sentence for the author. */
  message: string;
}

export const REFUSALS: Readonly<Record<RefusalCode, RefusalInfo>> = {
  "not-signed-in": { status: 401, retryable: false, message: "Sign in with GitHub to continue." },
  "not-found": { status: 404, retryable: false, message: "We couldn't find that." },
  "github-token-revoked": {
    status: 401,
    retryable: false,
    message: "GitHub access was revoked. Sign in again to continue.",
  },
  "repo-private": {
    status: 403,
    retryable: false,
    message: "Only public repositories can have a project page.",
  },
  "repo-fork": {
    status: 403,
    retryable: false,
    message: "Forks can't have a project page. Use the original repository.",
  },
  "repo-no-push": {
    status: 403,
    retryable: false,
    message: "You need push access to this repository on GitHub.",
  },
  "repo-no-commits": {
    status: 403,
    retryable: false,
    message: "GitHub shows no commits from your account in this repository.",
  },
  "repo-too-large": {
    status: 422,
    retryable: false,
    message: "This repository has more files than your plan allows.",
  },
  "plan-project-limit": {
    status: 402,
    retryable: false,
    message: "Your plan's project limit is reached. Withdraw a project or upgrade.",
  },
  "plan-generation-limit": {
    status: 402,
    retryable: false,
    message: "You have used this month's generations.",
  },
  "plan-refresh-limit": {
    status: 402,
    retryable: false,
    message: "You have used this month's refreshes, or your plan has none.",
  },
  "plan-correction-limit": {
    status: 402,
    retryable: false,
    message:
      "You have used your plan's corrections: 3 for each project on Free, 20 a month on Pro.",
  },
  "monthly-cost-ceiling": {
    status: 402,
    retryable: false,
    message: "This job would go over your plan's monthly limit.",
  },
  "account-too-new": {
    status: 403,
    retryable: false,
    message: "Free accounts need a GitHub account at least 30 days old.",
  },
  "platform-paused": {
    status: 503,
    retryable: true,
    message: "New free jobs are paused for today. Try again tomorrow.",
  },
  "job-active": {
    status: 409,
    retryable: false,
    message: "A job is already running for this project.",
  },
  "job-cost-cap": {
    status: 422,
    retryable: false,
    message: "This job reached its cost limit and stopped. Nothing was charged to your quota.",
  },
  "job-interrupted": {
    status: 500,
    retryable: false,
    message: "This job was interrupted too many times. Start a new one.",
  },
  "job-failed": {
    status: 500,
    retryable: true,
    message: "Something went wrong while building your draft. Nothing was charged to your quota.",
  },
  "correction-unchanged": {
    status: 422,
    retryable: false,
    message:
      "No sentence could be corrected, so nothing changed and it doesn't count. Say what's wrong in other words, or flag another sentence.",
  },
  "stale-revision": {
    status: 409,
    retryable: false,
    message: "This draft changed in another tab or by a refresh. Reload to see it.",
  },
  "stale-publication": {
    status: 409,
    retryable: false,
    message: "A newer version was published. Reload before publishing.",
  },
  "preview-mismatch": {
    status: 409,
    retryable: false,
    message: "The preview is out of date. Preview again before publishing.",
  },
  "not-reviewed": {
    status: 409,
    retryable: false,
    message: "Review this version before publishing.",
  },
  frozen: {
    status: 402,
    retryable: false,
    message: "Your plan no longer covers this project. You can unpublish or export it.",
  },
  withdrawn: {
    status: 410,
    retryable: false,
    message: "This project page is no longer available.",
  },
  "restore-expired": {
    status: 410,
    retryable: false,
    message: "This project can no longer be restored.",
  },
  "invalid-input": {
    status: 400,
    retryable: false,
    message: "Some of what you sent isn't valid. (the field and rule follow)",
  },
  "invalid-transition": {
    status: 409,
    retryable: false,
    message: "That isn't possible right now. Reload to see the current state.",
  },
  "account-deleting": { status: 410, retryable: false, message: "This account is being deleted." },
};
