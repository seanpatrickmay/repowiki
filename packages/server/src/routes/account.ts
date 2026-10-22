import { authorize } from "@repowiki/hosted";
import { type Deps, logOf } from "../app.ts";
import { HttpError } from "../http/body.ts";
import type { Route } from "../http/router.ts";
import { html, redirect } from "../http/server.ts";
import { currentSession, type Session, sessionSetCookie } from "../http/session.ts";
import { accountPage, deletedPage } from "../pages/account.ts";
import { pageSession } from "../pages/refusal.ts";
import { buildInFlight, deleteAccount } from "../store/account-deletion.ts";
import { activeHandle } from "../store/accounts.ts";
import { billingOf } from "../store/billing.ts";
import { mutation } from "./drafts.ts";

const PRIVATE = { "cache-control": "private, no-store" };
/** Subscription statuses Stripe may still charge. */
const CHARGEABLE = new Set(["active", "trialing", "past_due", "unpaid", "incomplete"]);

/** The account page and deleting the account (Contract §6.2, ADR-0018). */
export function accountRoutes(deps: Deps): Route[] {
  const shown = async (session: Session, status: number, error?: string) =>
    html(
      status,
      accountPage({
        login: session.account.login,
        handle: await activeHandle(deps.db, session.account.id),
        plan: session.account.plan,
        publicOrigin: deps.config.publicOrigin,
        session: pageSession(session),
        ...(error === undefined ? {} : { error }),
      }),
      PRIVATE,
    );

  return [
    {
      method: "GET",
      pattern: "/account",
      handler: async (request) => {
        const session = await currentSession(deps.db, deps.config, request, deps.now());
        if (session === null) return redirect("/auth/github");
        return shown(session, 200);
      },
    },
    {
      method: "POST",
      pattern: "/account/delete",
      handler: async (request) => {
        const { session, form } = await mutation(deps, request);
        const caller = { kind: "account" as const, account: session.account };
        const verdict = authorize("account.delete", { now: deps.now(), caller });
        if (!verdict.ok) throw new HttpError(410, "This account is being deleted.");
        const typed = (form.get("confirm") ?? "").trim().toLowerCase();
        if (typed !== session.account.login.toLowerCase()) {
          return shown(session, 400, "Type your GitHub login exactly to delete your account.");
        }
        const building = "A build is running. Delete your account once it finishes.";
        if (await buildInFlight(deps.db, session.account.id)) {
          return shown(session, 409, building);
        }
        // Cancel first: an account that is gone must never be charged again.
        const billing = await billingOf(deps.db, session.account.id);
        const subscription = billing?.subscriptionId ?? null;
        if (
          deps.stripe !== null &&
          subscription !== null &&
          CHARGEABLE.has(billing?.status ?? "")
        ) {
          try {
            await deps.stripe.cancelSubscription(subscription);
          } catch {
            logOf(deps)({ account: "delete-cancel-failed" });
            const message =
              "Stripe couldn't cancel your Pro subscription, so nothing was deleted. Try again in a minute.";
            return shown(session, 502, message);
          }
        }
        const done = await deps.db.transaction((tx) =>
          deleteAccount(tx, { accountId: session.account.id, now: deps.now() }),
        );
        if (done === "build") return shown(session, 409, building);
        return html(200, deletedPage(deps.config.publicOrigin), {
          ...PRIVATE,
          "set-cookie": sessionSetCookie(deps.config, "", 0),
        });
      },
    },
  ];
}
