# RepoWiki hosted — Billing (spec 4 of 4) design spec

- **Date:** 2026-10-21
- **Status:** Accepted on the owner's standing instruction to build the hosted product without stopping for questions (memory: hosted autonomy). The prices are the owner's: $5 a month, and $15 every four months, which he set up in Stripe on 2026-10-21 as a renewing price with tax included. §13 lists the calls he is most likely to revisit.
- **Author:** Sean May
- **Features:** F26 hosted project pages.
- **Builds on:** the Contract spec `2026-10-14-repowiki-hosted-contract-design.md` (cited "Contract §n"), the vertical slice `2026-10-14-repowiki-hosted-slice-design.md` (cited "S-n"), ADR-0012 and ADR-0015, and `main` at `75a06b3`.

## 1. Brief and goals

The Contract fixed what Pro allows (D3) and what a downgrade does (D4, C9). Everything already reads `account.plan`; nothing can change it. This spec lets a signed-in student pay for Pro through Stripe, manage or cancel it through Stripe, and lose Pro when Stripe says the subscription ended, with the pages frozen rather than taken down.

Goals, in order:

1. **Stripe is the source of truth for money; RepoWiki only mirrors one fact.** RepoWiki stores which Stripe customer and subscription belong to an account and the subscription's status. Whether the account is Pro is a pure function of that status (`@repowiki/hosted`), written to `account.plan` in the same transaction.
2. **No card data, no payment UI.** Checkout and the Customer Portal are Stripe-hosted pages. RepoWiki never sees a card number, an address or a receipt.
3. **Wrong or replayed webhooks change nothing.** Every webhook is signature-checked, de-duplicated by event id, and answered by re-reading the subscription from Stripe rather than trusting the event body, so events that arrive out of order still leave the right state.
4. **Off until the keys exist.** Without Stripe keys the server runs as today, with no billing routes and no upgrade buttons, so production keeps working while the owner finishes live setup.

## 2. What the owner gets

- A billing page at `APP_ORIGIN/billing`: the plan, and either two upgrade buttons or "Manage billing".
- Pro through Stripe Checkout at either price; cancel, card changes and invoices through the Stripe Customer Portal.
- The webhook at `APP_ORIGIN/billing/webhook`, the URL the Stripe guide already names, for the six events listed there.
- Upgrade links wherever a plan limit refuses something.
- Tests that never call Stripe, a fake Stripe for them, and a manual run against the sandbox with `stripe listen`.

## 3. Decisions

Every ruling has the form "Ruling: X — why — cost if wrong".

| # | Topic | Ruling |
|---|---|---|
| B1 | Prices | Ruling: two Stripe prices on one product, found by lookup key: `repowiki_pro_monthly` ($5 every month) and `repowiki_pro_season` ($15 every 4 months). Both grant the same Pro (D3's limits, counted per UTC month as today). The page shows the amounts from constants in `@repowiki/hosted` (`PRO_PRICES`); a startup check is not added, since a price edit in Stripe is the owner's, and the pricing copy changes with it. — The owner's setup. — Cost if wrong: a third price is one constant. |
| B2 | What is stored | Ruling: one `billing` row per account that ever opened Checkout: `account_id` (key), `stripe_customer_id` (unique), and a `body` with the subscription id, its Stripe status, which price, the current period's end, whether it cancels at period end, and the `created` time of the newest event applied. Plus `stripe_events(id, received_at)` for de-duplication, kept 30 days. No email, name, address or amount is stored. — Contract S-4: columns only for keys; the minimum needed to answer "is this account Pro, and until when". — Cost if wrong: a column added by a migration. |
| B3 | Entitlement | Ruling: `planForStatus(status)` in `@repowiki/hosted` is `pro` for `active`, `trialing` and `past_due`, `free` for every other status or no subscription. `past_due` keeps Pro while Stripe retries the card (Smart Retries, then `canceled` or `unpaid`). The new plan is written to `account.plan` in the transaction that stores the subscription, with an audit event `billing.plan-change` when it changes. — A student whose card fails mid-application keeps their page working while they fix it; Stripe decides when retrying stops. — Cost if wrong: one status moved between two sets. |
| B4 | Downgrade | Ruling: nothing new. Losing Pro sets `plan` to `free`, and C9's computed freeze does the rest: pages stay live, frozen, unpublish and export still work (D4). — Already the Contract's rule. |
| B5 | Checkout | Ruling: `POST /billing/checkout` (session, CSRF) with `price=monthly` or `price=season` creates a Checkout Session: `mode=subscription`, one line item of the price resolved from its lookup key, `client_reference_id` and `metadata[account_id]` and `subscription_data[metadata][account_id]` set to the account id, the account's Stripe customer when one exists, `success_url` `APP_ORIGIN/billing/return?session_id={CHECKOUT_SESSION_ID}`, `cancel_url` `APP_ORIGIN/billing`. It answers 303 to the session's `url`. An account already on Pro gets a refusal pointing to "Manage billing". Automatic tax is off until the owner registers somewhere; the prices include tax either way, so students pay the shown amount. — Stripe-hosted, so no card handling; the account id travels in three places so the first webhook can find the account. — Cost if wrong: one request's parameters. |
| B6 | Return | Ruling: `GET /billing/return?session_id=…` retrieves the session; if it belongs to the signed-in account and is `complete`, it applies the subscription at once (the same code the webhook runs), then redirects to `/billing`. The webhook may arrive before or after; both are idempotent. — The student sees Pro on return, not after a webhook delay. — Cost if wrong: the page shows Free for a few seconds. |
| B7 | Portal | Ruling: `POST /billing/portal` (session, CSRF) creates a portal session for the account's customer with `return_url` `APP_ORIGIN/billing` and answers 303 to it. Its features are the owner's portal settings in Stripe (cancel at period end, payment methods, invoices; no plan switching). — Stripe-hosted. — Cost if wrong: none; settings live in Stripe. |
| B8 | Webhook | Ruling: `POST /billing/webhook` on the app host takes no session and no CSRF; it reads at most 256 KiB raw and checks `Stripe-Signature`: HMAC-SHA256 of `"<t>.<raw body>"` under `STRIPE_WEBHOOK_SECRET`, compared in constant time with each `v1` value, and `t` within 5 minutes of now. A bad signature answers 400 and is logged without the body. A good one inserts the event id into `stripe_events`; a duplicate answers 200 at once. For `checkout.session.completed`, `customer.subscription.created`, `.updated`, `.deleted`, `invoice.paid` and `invoice.payment_failed` it finds the subscription id, **retrieves the subscription from Stripe**, and applies it; other types answer 200. An event older than the newest applied one for that account is still recorded but changes nothing. Any failure answers 500 so Stripe retries. — Re-reading the subscription makes order and payload shape irrelevant; the signature check is Stripe's documented scheme. — Cost if wrong: one more API read per event. |
| B9 | Finding the account | Ruling: by `stripe_customer_id` in `billing`; failing that, by `metadata.account_id` on the subscription (set at checkout), which creates the `billing` row. An event for a customer RepoWiki doesn't know is recorded and ignored. — The customer is created by Checkout, so the first event may come before RepoWiki knows its id. |
| B10 | Stripe client | Ruling: a hand-written client over `deps.fetch` (no SDK), form-encoded bodies, `Authorization: Bearer`, `Stripe-Version: 2026-09-30.endive` (the account's version on 2026-10-21), a 10-second timeout, and an `Idempotency-Key` on every POST. It reads a subscription's period end from its first item (`items.data[0].current_period_end`), where this API version keeps it. Price ids are looked up by lookup key once per process. Tests use `fakeStripeFetch`, like `fakeGitHubFetch`. — Five calls do not justify an SDK (S-2's reasoning); pinning the version keeps response shapes fixed. — Cost if wrong: the SDK is a drop-in behind the same interface. |
| B11 | Config | Ruling: `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are optional and come as a pair; one without the other is a `ConfigError`. The key must start `sk_` or `rk_`. A test key (`_test_`) is allowed in any mode and makes every billing page show "Test mode: no real charges". With no keys, the billing routes answer 404 and no page offers an upgrade. — The owner's live keys come after the public pages Stripe reviews; production must run before that. A restricted key with the permissions in the guide is what the owner created. — Cost if wrong: a required variable. |
| B12 | Pages | Ruling: `/billing` shows the plan and, on Free, both prices as buttons ("$5 a month", "$15 every 4 months"); on Pro, which price, the next renewal or the end date if it cancels, a past-due notice when the card failed, and "Manage billing". The nav gains "Billing"; the dashboard shows the plan beside the login with a link to `/billing`; refusal pages for `plan-project-limit`, `plan-generation-limit`, `plan-refresh-limit`, `frozen` and `repo-too-large` add "See Pro" linking to `/billing` when billing is on. Copy says "internship and co-op", never the reverse. — The upgrade appears where the limit is hit. — Cost if wrong: copy. |
| B13 | Audit | Ruling: `billing.checkout`, `billing.portal` (author) and `billing.plan-change` (system) are audited. Webhook bodies, customer emails and amounts are never logged. — Contract audit rules; no PII in logs. |
| B14 | Account deletion | Ruling: out of scope here (spec 3 builds deletion). Spec 3's deletion must cancel the subscription in Stripe immediately; this spec adds the client call it needs (`cancelSubscription`) and a test. — Deletion is not built yet. |

## 4. Architecture

```
student ──POST /billing/checkout──▶ server ──create session──▶ Stripe
        ◀──303 checkout.stripe.com───┘
student ──pays on Stripe──▶ Stripe ──303──▶ /billing/return ──retrieve session + subscription──▶ apply
Stripe ──POST /billing/webhook (signed)──▶ server: verify ▸ dedupe ▸ retrieve subscription ▸ apply
apply = in one transaction: lock billing row ▸ newer than last applied? ▸ store ▸ planForStatus ▸ account.plan ▸ audit
```

Modules: `packages/hosted/src/billing.ts` (statuses, `planForStatus`, `PRO_PRICES`, `BillingState` schema), `packages/server/src/billing/stripe.ts` (client and fake), `packages/server/src/billing/signature.ts` (verification), `packages/server/src/store/billing.ts` (rows and `applySubscription`), `packages/server/src/routes/billing.ts` (page, checkout, return, portal, webhook), `packages/server/src/pages/billing.ts`.

## 5. Data model

Migration `0011-billing.sql`:

```sql
CREATE TABLE billing (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  stripe_customer_id text NOT NULL UNIQUE,
  body jsonb NOT NULL
);
CREATE TABLE stripe_events (
  id text PRIMARY KEY,
  received_at timestamptz NOT NULL
);
```

`BillingState` (the body): `customerId`, `subscriptionId` (nullable), `status` (a Stripe subscription status or null), `price` (`monthly` \| `season` \| null), `periodEnd` (ISO, nullable), `cancelAtPeriodEnd`, `lastEventAt` (ISO), `updatedAt`.

## 6. Security

- The webhook route is the only unauthenticated POST on the app host; its signature check uses `timingSafeEqual` on equal-length buffers and rejects stale timestamps.
- Checkout and portal are CSRF-protected form posts like every other mutation (S-6).
- A return URL's `session_id` is accepted only when the session's `client_reference_id` is the signed-in account.
- The secret key is read from config only, sent only to `api.stripe.com`, never logged; the webhook secret never leaves the process.

## 7. Testing

- `planForStatus` for every Stripe status; `BillingState` parsing.
- Signature: valid, wrong secret, tampered body, stale and future timestamps, several `v1` values, malformed headers.
- Store: apply creates the row and sets Pro; a later `canceled` sets Free and freezes a second project (C9); an older event changes nothing; a duplicate event id is a no-op.
- Routes, against `fakeStripeFetch`: checkout redirects with the right parameters and refuses a Pro account; return applies and refuses another account's session; portal redirects; webhook accepts a signed event, rejects an unsigned one, and answers 500 when Stripe can't be reached; with no keys every billing route is 404 and no page links to `/billing`.
- Manual: Checkout in the sandbox with card `4242 4242 4242 4242` through `stripe listen --forward-to http://127.0.0.1:8787/billing/webhook`, then cancel in the portal and advance a test clock past the period end.

## 8. Milestones (M15)

1. **M15a** `@repowiki/hosted` billing rules: statuses, `planForStatus`, `PRO_PRICES`, `BillingState`.
2. **M15b** server: migration, config pair, Stripe client and fake, signature check.
3. **M15c** store: `applySubscription`, events, plan change and audit.
4. **M15d** routes and page: `/billing`, checkout, return, portal, nav and refusal links.
5. **M15e** webhook route.

## 9. Exit criteria

A sandbox Checkout turns an account Pro; cancelling in the portal and passing the period end turns it Free with its pages frozen; replaying any webhook changes nothing; `pnpm check` passes; production without Stripe keys behaves exactly as before.

## 10. Out of scope

Live mode (the owner's Part 2 of the Stripe guide), the public pricing, terms, privacy and refunds pages, Stripe Tax registration, coupons, plan switching mid-period, account deletion (spec 3), emails (Postmark, separate).

## 11. Dependencies added

None.

## 12. Operations

After merge: the owner adds `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (live) to `deploy/.env` in Part 2 of the guide and imports them; until then production has billing off.

## 13. For the owner

1. **`past_due` keeps Pro** (B3) until Stripe stops retrying.
2. **Automatic tax off** for now (B5); prices include tax, so turning it on later changes what you keep, not what students pay.
3. **No plan switching** in the portal (B7): switching between monthly and the season is cancel, then subscribe to the other.
4. **Test keys allowed in production** with a visible "Test mode" banner (B11), so you can try the whole flow on `app.repowiki.app` before going live.
