# 0016. The public site at repowiki.app

- Status: accepted
- Date: 2026-10-21
- Amends: ADR-0012 (the pages origin's root); Contract §9 (reserved handles)

## Context

ADR-0012 put public pages on `PUBLIC_ORIGIN` and sent its root to the app's landing page, a heading
and one paragraph. Before RepoWiki is shown to students it needs a front door that says what it is,
for whom, what it costs and what it won't do, plus the pages Stripe reviews before it activates an
account. The owner approved the copy in the sign-up prototype after a review by a student persona
and a recruiter persona.

## Decision

- **Where.** Ruling: the public site is served by the server on the pages host: `/` (home), `/pro`
  and `/questions`, with the legal pages beside them. It is routed before the handle routes, cached
  publicly for five minutes, and uses its own style sheet at `/_app/site.css` under the pages
  host's CSP (no inline style or script; system fonts). — The same process and the same CDN as the
  public pages; no second deploy. — Cost if wrong: moving it to a static host is a route set.
- **The app's root.** Ruling: `app.repowiki.app/` sends a signed-out visitor to the home page and a
  signed-in one to the dashboard. — One front door. — Cost if wrong: a route.
- **Reserved handles.** Ruling: `example`, `pro`, `questions` and `refunds` join the reserved list,
  so no GitHub login can take a site path as its handle. No account in production held one. — Cost
  if wrong: a GitHub user with one of those logins gets a suffixed handle (Contract §9).
- **Copy.** Ruling: the copy is the prototype's: "internship and co-op" in that order, the product
  never names its developer, and it says plainly that an AI model writes each entry. — The owner's
  rulings of 2026-10-21. — Cost if wrong: text.

## Consequences

- `repowiki.app/` is a page, not a redirect, so it is what a shared link or a search result shows.
- The example the home page links to (`/example`) is ADR-0017's.
