import type { Plan } from "@repowiki/hosted";
import { escapeHtml as e, type PageSession, page } from "./layout.ts";

export interface AccountView {
  login: string;
  handle: string | null;
  plan: Plan;
  publicOrigin: string;
  session: PageSession;
  /** Why the last delete was refused, shown above the form. */
  error?: string;
}

/** The account page: who is signed in, the plan, and deleting the account (ADR-0018). */
export function accountPage(v: AccountView): string {
  const where =
    v.handle === null
      ? ""
      : `<p>Your page: <a href="${e(v.publicOrigin)}/${e(v.handle)}">${e(new URL(v.publicOrigin).host)}/${e(v.handle)}</a></p>`;
  const error = v.error === undefined ? "" : `<p class="notice">${e(v.error)}</p>`;
  const body = `<h1>Account</h1><p>Signed in with GitHub as <strong>${e(v.login)}</strong>.</p>${where}<p>Plan: ${v.plan === "pro" ? "Pro" : "Free"} · <a href="/billing">Billing</a></p>
<div class="card"><h2>Delete your account</h2><p>Your page and every project's wiki come down within a minute, and everything else RepoWiki keeps about you is deleted within 30 days. We keep only your GitHub user ID and login, so no one else can take your page's address. If you sign in again later, your account comes back at the same address, with nothing published: within 30 days your projects are there to publish again; after that, you build them again. Free's one project doesn't start over. A Pro subscription is cancelled straight away. The rest of a Pro period you paid for isn't refunded: to use it, cancel on the Billing page now and delete your account when it ends. This can't be undone.</p>${error}
<form method="post" action="/account/delete"><input type="hidden" name="csrf" value="${e(v.session.csrf)}"><label for="confirm">Type your GitHub login, ${e(v.login)}, to confirm</label><input id="confirm" name="confirm" autocomplete="off" required><p><button>Delete my account</button></p></form></div>`;
  return page({ title: "Account", body, session: v.session });
}

/** What a deleted account sees last, signed out. */
export function deletedPage(publicOrigin: string): string {
  const body = `<h1>Your account is deleted</h1><p>Your pages are down now. Everything else RepoWiki kept about you is removed within 30 days. Sign in again before then and your projects are still there, unpublished.</p><p><a href="${e(publicOrigin)}/">RepoWiki</a></p>`;
  return page({ title: "Account deleted", body, session: null });
}
