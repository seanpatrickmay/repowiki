import { describe, expect, it } from "vitest";
import {
  BillingState,
  PRO_PRICES,
  planForStatus,
  priceForLookupKey,
  SUBSCRIPTION_STATUSES,
} from "./billing.ts";

const state = (patch: Partial<BillingState> = {}): BillingState => ({
  customerId: "cus_123",
  subscriptionId: "sub_123",
  status: "active",
  price: "monthly",
  periodEnd: "2026-11-21T00:00:00Z",
  cancelAtPeriodEnd: false,
  lastEventAt: "2026-10-21T00:00:00Z",
  updatedAt: "2026-10-21T00:00:00Z",
  ...patch,
});

describe("planForStatus (billing spec B3)", () => {
  it("is Pro while the subscription is active, trialing or past due", () => {
    for (const status of ["active", "trialing", "past_due"] as const) {
      expect(planForStatus(status)).toBe("pro");
    }
  });

  it("is Free for every other status and for no subscription", () => {
    const others = SUBSCRIPTION_STATUSES.filter(
      (s) => s !== "active" && s !== "trialing" && s !== "past_due",
    );
    expect(others).toEqual(["incomplete", "incomplete_expired", "unpaid", "canceled", "paused"]);
    for (const status of others) expect(planForStatus(status)).toBe("free");
    expect(planForStatus(null)).toBe("free");
  });
});

describe("PRO_PRICES (billing spec B1)", () => {
  it("are the owner's two prices, found by their Stripe lookup keys", () => {
    expect(PRO_PRICES).toEqual({
      monthly: { lookupKey: "repowiki_pro_monthly", label: "$5 a month", months: 1 },
      season: { lookupKey: "repowiki_pro_season", label: "$15 every 4 months", months: 4 },
    });
    expect(priceForLookupKey("repowiki_pro_season")).toBe("season");
    expect(priceForLookupKey("repowiki_pro_yearly")).toBeNull();
    expect(priceForLookupKey(null)).toBeNull();
  });
});

describe("BillingState (billing spec §5)", () => {
  it("parses a subscribed and a never-subscribed account", () => {
    expect(BillingState.parse(state())).toEqual(state());
    const none = state({ subscriptionId: null, status: null, price: null, periodEnd: null });
    expect(BillingState.parse(none)).toEqual(none);
  });

  it("refuses ids that aren't Stripe's and unknown fields", () => {
    expect(BillingState.safeParse(state({ customerId: "123" })).success).toBe(false);
    expect(BillingState.safeParse(state({ subscriptionId: "si_123" })).success).toBe(false);
    expect(BillingState.safeParse({ ...state(), email: "a@b.c" }).success).toBe(false);
  });

  it("needs a subscription for a status", () => {
    expect(BillingState.safeParse(state({ subscriptionId: null })).success).toBe(false);
  });
});
