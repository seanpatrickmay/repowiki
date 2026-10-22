/** Escape text for HTML element content and double- or single-quoted attributes. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Served at STYLE_PATH, so pages keep spec 2 S2's CSP with no inline style. */
export const STYLE = `:root{color-scheme:light dark;--bg:#fff;--fg:#1b1f23;--muted:#57606a;--line:#d0d7de;--accent:#0b5cad}@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9da7b3;--line:#30363d;--accent:#58a6ff}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,sans-serif}header{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:.75rem 1rem;border-bottom:1px solid var(--line)}header a{color:var(--fg);font-weight:600;text-decoration:none}main{max-width:56rem;margin:0 auto;padding:1.5rem 1rem 4rem}a{color:var(--accent)}h1{font-size:1.75rem;line-height:1.2}.muted{color:var(--muted)}.card{border:1px solid var(--line);border-radius:8px;padding:1rem;margin:1rem 0}label{display:block;font-weight:600;margin:1rem 0 .25rem}input:not([type=checkbox]),textarea,select{width:100%;font:inherit;padding:.5rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}textarea{min-height:6rem}button{font:inherit;font-weight:600;padding:.5rem 1rem;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}button.secondary{background:transparent;color:var(--accent)}form.inline{display:inline}.notice{border-left:4px solid var(--accent);padding:.5rem 1rem;margin:1rem 0}ul.plain{list-style:none;padding:0}`;

export const STYLE_PATH = "/_app/style.css";

export interface PageSession {
  csrf: string;
  login: string;
}

/** A full page in the app's layout; `body` and `head` must already be escaped HTML. */
export function page(input: {
  title: string;
  body: string;
  session: PageSession | null;
  head?: string;
}): string {
  const nav =
    input.session === null
      ? `<a href="/auth/github">Sign in with GitHub</a>`
      : `<span><a href="/dashboard">${escapeHtml(input.session.login)}</a> <a href="/account">Account</a> <form class="inline" method="post" action="/auth/signout"><input type="hidden" name="csrf" value="${escapeHtml(input.session.csrf)}"><button class="secondary">Sign out</button></form></span>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(input.title)} · RepoWiki</title><link rel="stylesheet" href="${STYLE_PATH}">${input.head ?? ""}</head><body><header><a href="/">RepoWiki</a>${nav}</header><main>${input.body}</main></body></html>`;
}
