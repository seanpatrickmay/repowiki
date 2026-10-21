import { type BillingState, type Plan, PRO_PRICES } from "@repowiki/hosted";
import { escapeHtml as e, type PageSession, page } from "./layout.ts";

export interface BillingView {
  plan: Plan;
  billing: BillingState | null;
  /** Whether Stripe is configured (billing spec B11). */
  enabled: boolean;
  testMode: boolean;
  session: PageSession;
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

const PRO_LINE =
  "Pro puts up to ten projects on your page, refreshes a project after you push (30 times a month), and documents repositories up to 3,000 files. Cancel any time: your published pages stay up.";

/** The billing page (billing spec B12): the plan, and a way to pay or to manage it. */
export function billingPage(v: BillingView): string {
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${e(name)}" value="${e(value)}">`;
  const csrf = hidden("csrf", v.session.csrf);
  const test = v.testMode
    ? `<p class="notice">Test mode: no real charges. Pay with Stripe's test card 4242 4242 4242 4242.</p>`
    : "";
  const b = v.billing;
  let body: string;
  if (v.plan === "pro") {
    const price = b?.price === null || b === null ? null : PRO_PRICES[b.price].label;
    const dates =
      b?.periodEnd == null
        ? ""
        : `<p>${b.cancelAtPeriodEnd ? "Ends on" : "Renews on"} ${e(day(b.periodEnd))}.</p>`;
    const late =
      b?.status === "past_due"
        ? `<p class="notice">Your last payment didn't go through. Update your card under Manage billing; Pro stays on while Stripe retries it.</p>`
        : "";
    const manage =
      v.enabled && b !== null
        ? `<form method="post" action="/billing/portal">${csrf}<button>Manage billing</button></form><p class="muted">Change your card, see receipts or cancel on Stripe's page.</p>`
        : "";
    body = `<p>You're on <strong>Pro</strong>${price === null ? "" : `, ${e(price)}`}.</p>${dates}${late}${manage}`;
  } else {
    const choices = v.enabled
      ? Object.entries(PRO_PRICES)
          .map(
            ([key, p]) =>
              `<form class="inline" method="post" action="/billing/checkout">${csrf}${hidden("price", key)}<button${key === "season" ? "" : ' class="secondary"'}>Pro · ${e(p.label)}</button></form>`,
          )
          .join(" ")
      : `<p class="muted">Pro isn't open yet.</p>`;
    body = `<p>You're on <strong>Free</strong>: one project, with one rebuild before you publish.</p><div class="card"><h2>RepoWiki Pro</h2><p>${e(PRO_LINE)}</p>${choices}</div>`;
  }
  return page({ title: "Billing", body: `<h1>Billing</h1>${test}${body}`, session: v.session });
}
