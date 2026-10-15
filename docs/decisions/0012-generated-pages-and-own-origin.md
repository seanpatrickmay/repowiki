# 0012. Generated-only project pages, and public pages on their own origin (F26)

- Status: accepted
- Date: 2026-10-15
- Features: F26
- Amends: Contract spec D2, D6, §5, §6.3, §6.4, §7.1, §8, §11 and spec 2 S6, S13, S14, §7, §14

## Context

The Contract let an author edit a portfolio layer over the generated text: tagline, summary,
contribution statement, highlights and hidden pages (D2, D6, §8). Revisions carried those
overrides and were flagged when a refresh changed the text under one (§6.3). Spec 2 served public
pages and previews on the app's own origin and deferred a separate content origin to spec 3 (§14).

On 2026-10-15 the owner ruled on both, before launch, because page URLs are permanent:

1. No manual overrides of anything. The page is always the generated content, and the project
   editor becomes a review step.
2. No hidden features. Every wiki page is public.
3. "My contribution" is a generated paragraph, written from the author's own commits and labelled
   as generated, beside the unchanged git facts.
4. Highlights are generated: up to 4 of the generation's candidates, with blurbs from the
   feature pages' leads.
5. The review attestation is reworded for an author who approves generated content.
6. Public pages move to `https://repowiki.app/<handle>/<slug>` (`PUBLIC_ORIGIN`) and the signed-in
   app to `https://app.repowiki.app` (`APP_ORIGIN`), routed by `Host`.
7. Previews are served on the pages origin at a short-lived capability URL, never on the app
   origin.
8. Development, local and demo modes use two loopback hosts on one port.

## Decision

Each ruling is "Ruling: X — why — cost if wrong".

### Content (M14h)

- **Content lives on the revision.** Ruling: `DraftRevision.overrides` and `flags` are replaced by
  `content` (`tagline`, `summary`, `contribution`, `highlights`), computed by one pure function in
  `@repowiki/hosted` (`generatedContent`) when the server records a generation, from the
  generation's suggestions and facts, its export and the author's display name. A generation still
  creates a revision and a refresh the next one. — Revisions stay immutable (C4), so what an author
  reviewed is fixed, and the preview hashes exactly that content. — Cost if wrong: a change to the
  generation rules reaches only new revisions; an existing draft needs a refresh.
- **Nothing an author writes, so nothing to flag or require.** Ruling: `saveRevision`, the
  `draft.save` action, revision flags and the refusals `needs-review-flags` and
  `contribution-missing` are removed (28 refusal codes). A revision is publishable when it is the
  latest, reviewed and previewed. — Each existed only to protect author-written text. — Cost if
  wrong: restoring author editing restores them from history.
- **The contribution paragraph.** Ruling: the model's `contributionDraft` is published as written
  when it is non-empty after cleaning; otherwise a deterministic paragraph from the facts: "Ada
  Lovelace wrote 181 of the repository's 181 commits and about 100% of its current lines, most of
  all in CLI interface, Bot arena and Performance testing." ("most of all" names up to three
  features by the author's commits, never documentation-like ones; a repository with no lines
  drops the lines clause; an author with no matched commits gets "The git history at this commit
  attributes none of the repository's N commits to <Name>."). The page labels it "Generated from
  the git history at `<sha>`; not written by the author." and the model is now asked for the third
  person, so the label and the voice agree. — A page is always publishable, local import mode
  included. — Cost if wrong: a wording change in one function.
- **Documentation-like features.** Ruling: a feature is documentation-like when its page lists
  languages and every one is a prose format (Markdown, reStructuredText, AsciiDoc, Text), or its
  title or id names documentation (`docs`, `documentation`, `readme`, `changelog`, `guide`,
  `manual`, `tutorial`, `spec`, `specification`, `adr`). Such features are never highlighted or
  named in "most of all"; they stay in the wiki and in the facts. — The repositories the owner
  tested put specs and plans in features of their own, which then led his highlights. — Cost if
  wrong: a code feature with such a name is skipped as a highlight.
- **Highlights.** Ruling: up to 4 of `highlightCandidates` that have a page, ordered by the
  author's commits on that feature (ties keep the candidates' order), documentation-like ones
  excluded; each blurb is the page's lead cut at a clause within 140 characters by the same rule
  that cuts taglines, now in `@repowiki/hosted` (`firstClause`) and shared with the worker. A page
  with no lead gets an empty blurb. — One cutting rule for every generated line. — Cost if wrong:
  a blurb rule change in one function.
- **Attestation 2.** Ruling: "I reviewed this version. It describes my project and my part in it
  accurately." The page still says "author-reviewed" and never calls it RepoWiki's verification.
  Reviews must carry version 2. — Version 1 attested to text the author wrote. — Cost if wrong:
  version 3 is a one-line addition.
- **Every page is public.** Ruling: `hiddenFeatureIds`, the hide control and the hosted export's
  removal of hidden features (links becoming plain titles, `scrubDiagram`) are removed; the hosted
  export now only drops People, work in flight, run costs and Wikipedia summaries. Versions
  already published with hidden pages keep their bytes until the author publishes again. — The
  facts already named every feature; hiding made the wiki disagree with them. — Cost if wrong:
  restoring hiding from history, and its export filter.
- **Stored rows.** Ruling: migration 0005 removes `hiddenFeatureIds` and the `hidden-missing`
  flags from stored revisions, deleting the reviews and previews of revisions that hid something;
  migration 0006 rewrites every remaining legacy revision into `content` from its generation in
  SQL (tagline, summary, the model draft or the facts paragraph without "most of all", and no
  highlights, since titles and leads live in object storage) and deletes their version 1 reviews
  and their previews. Published versions are untouched; a published `portfolio.json` without the
  new `contributionBy` field reads as author-written, so an old page is never mislabelled. — There
  is no production data, and local drafts must still load. — Cost if wrong: the owner's local
  drafts show no highlights until refreshed and must be reviewed again.

### Origins (M14i)

- **Two origins, routed by `Host`.** Ruling: the pages host (`PUBLIC_ORIGIN`) serves only the
  profile, the project page, its wiki under `/docs/`, the portfolio style sheet and previews; its
  `/` redirects (302) to `APP_ORIGIN`. The app host serves everything else, including OAuth, the
  dashboard, project and review pages and, outside production, the worker routes. Any other or
  missing `Host` answers 404, as does a public path on the app host and an app path on the pages
  host. — URLs printed on resumes must never change again, and a bug in the static site (rendered
  from untrusted repository content) must not run beside the session. — Cost if wrong: a route on
  the wrong host is a one-line move; 404 rather than 421 hides nothing and every client handles it.
- **Cookies and CSP per host.** Ruling: the session and OAuth state cookies are set and read on the
  app host only; the pages app drops any `Cookie` header before routing and strips any
  `Set-Cookie` from its replies. The app host's default CSP allows `form-action` to `'self'` and
  `PUBLIC_ORIGIN` (the open-preview form redirects there, and browsers check `form-action` on
  redirects); the pages host's default is `form-action 'none'`; built-site files keep their
  own policy. — Host-only cookies keep the session out of the pages origin. The two hosts are
  same-site (`repowiki.app`), so a pages-origin script can still send same-site requests to the
  app; the Origin header and CSRF token checks (S6) refuse them. — Cost if wrong: moving pages to
  a separate registrable domain is a DNS and config change.
- **Configuration.** Ruling: production requires `APP_ORIGIN` and `PUBLIC_ORIGIN`, each a
  RepoWiki https origin that is not a provider host (`*.fly.dev` and the rest of `Origin`'s list),
  and their hosts must differ (cookies ignore ports). Outside production both default to
  `http://127.0.0.1:<port>` (app) and `http://localhost:<port>` (pages), must be loopback, and
  must differ in host. The OAuth callback is `APP_ORIGIN/auth/github/callback`; `INTERNAL_PORT`
  and `INTERNAL_URL` are unchanged. Fly's health check names the app host. — Cookies are scoped
  by host, not port. — Cost if wrong: one more environment variable to check.
- **Cross-links.** Ruling: the app shows each project's public URL on `PUBLIC_ORIGIN`; the project
  page and profile end with "Made with RepoWiki" linking to `APP_ORIGIN`. — Readers can find the
  product; authors see the URL readers get.

### Previews (M14i)

- **Capability URLs on the pages origin.** Ruling: "Open preview" is a CSRF-checked `POST
  /projects/:id/preview/open` that mints 32 random bytes (base64url), stores only their SHA-256
  with the project, revision and an expiry of **1 hour**, and answers 303 to
  `PUBLIC_ORIGIN/_preview/<token>/`. The pages host serves the stored preview tree there with the
  same base rewriting as before (`/<handle>/<slug>/docs/` becomes `/_preview/<token>/docs/`), with
  `Cache-Control: no-store`, `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer` and no
  cookies. An unknown or expired token, or a revision with no preview, is 404. Expired tokens are
  deleted when the next one is minted. `_preview` joins the reserved handles. The old
  session-authorized `/preview/:id/:rev/` route is removed. — The preview holds the same untrusted
  generated content as a published page; serving it on the app origin would undo the split. An
  hour is long enough to review and short enough that a pasted link dies the same day. — Cost if
  wrong: a leaked link shows an unpublished draft to its holder for up to an hour; the expiry is a
  constant.

## Consequences

- The project page is a review step: read-only generated content, the attestation, preview and
  publish.
- Previews are visible to anyone holding the link until it expires, which the preview banner says.
- The runbook gains a second hostname (DNS and certificate for `repowiki.app` and
  `app.repowiki.app`), the GitHub OAuth app's homepage and callback move to `app.repowiki.app`,
  and `APP_ORIGIN` becomes a required secret or environment value.
- F18 (wiki prose editing) stays deferred; with no portfolio editing, nothing on a page is
  author-written.
