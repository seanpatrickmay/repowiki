import { REFUSALS, type RefusalCode } from "@repowiki/hosted";
import type { Reply } from "../http/router.ts";
import { html } from "../http/server.ts";
import type { Session } from "../http/session.ts";
import { escapeHtml, type PageSession, page } from "./layout.ts";

/**
 * A Contract refusal as a page with its status and plain sentence (Contract §11). `detail` names
 * what was wrong, for refusals whose sentence says one follows.
 */
export function refusalPage(
  code: RefusalCode,
  session: PageSession | null,
  options: { detail?: string; back?: string } = {},
): Reply {
  const info = REFUSALS[code];
  const message = info.message.replace(/\s*\(the field and rule follow\)$/, "");
  const detail = options.detail === undefined ? "" : `<p>${escapeHtml(options.detail)}</p>`;
  return html(
    info.status,
    page({
      title: "Not possible",
      body: `<h1>That didn't work</h1><p>${escapeHtml(message)}</p>${detail}<p><a href="${escapeHtml(options.back ?? "/dashboard")}">Back</a></p>`,
      session,
    }),
  );
}

/** What the layout needs of a session. */
export const pageSession = (s: Session): PageSession => ({ csrf: s.csrf, login: s.account.login });
