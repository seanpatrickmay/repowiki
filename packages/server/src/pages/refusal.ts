import { REFUSALS, type RefusalCode } from "@repowiki/hosted";
import type { Reply } from "../http/router.ts";
import { html } from "../http/server.ts";
import type { Session } from "../http/session.ts";
import { escapeHtml, type PageSession, page } from "./layout.ts";

/**
 * A Contract refusal as a page with its status and plain sentence (Contract §11). `detail` names
 * what was wrong, for refusals whose sentence says one follows.
 */
/** Refusals a Pro plan lifts, which link to the billing page (billing spec B12). */
const PLAN_LIMITS: ReadonlySet<RefusalCode> = new Set([
  "plan-project-limit",
  "plan-generation-limit",
  "plan-refresh-limit",
  "frozen",
  "repo-too-large",
]);

export function refusalPage(
  code: RefusalCode,
  session: PageSession | null,
  options: { detail?: string; back?: string } = {},
): Reply {
  const info = REFUSALS[code];
  const message = info.message.replace(/\s*\(the field and rule follow\)$/, "");
  const detail = options.detail === undefined ? "" : `<p>${escapeHtml(options.detail)}</p>`;
  const pro = PLAN_LIMITS.has(code) ? `<p><a href="/billing">See Pro</a></p>` : "";
  return html(
    info.status,
    page({
      title: "Not possible",
      body: `<h1>That didn't work</h1><p>${escapeHtml(message)}</p>${detail}${pro}<p><a href="${escapeHtml(options.back ?? "/dashboard")}">Back</a></p>`,
      session,
    }),
    // It names the signed-in account and carries its CSRF token: never stored by any cache.
    { "cache-control": "private, no-store" },
  );
}

/** What the layout needs of a session. */
export const pageSession = (s: Session): PageSession => ({ csrf: s.csrf, login: s.account.login });
