import { describe, expect, it } from "vitest";
import {
  claimHandle,
  HandleName,
  type HandleRecord,
  handleFor,
  isReservedHandle,
  lookupHandle,
  Origin,
  profileUrl,
  projectUrl,
  RESERVED_HANDLES,
  Slug,
  siteKey,
  slugFor,
  tombstoneHandles,
} from "./urls.ts";

const T0 = "2026-10-14T12:00:00Z";
const T1 = "2026-11-01T09:00:00Z";
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

const record = (handle: string, patch: Partial<HandleRecord> = {}): HandleRecord => ({
  handle,
  accountId: A,
  state: "active",
  redirectTo: null,
  createdAt: T0,
  ...patch,
});
const byName = (...records: HandleRecord[]) => new Map(records.map((r) => [r.handle, r]));
const none = () => false;

describe("handles (Contract spec §9)", () => {
  it("accept GitHub logins and refuse anything else", () => {
    for (const ok of ["a", "seanpatrickmay", "a-b-c", "x".repeat(39), "0day"]) {
      expect(HandleName.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ["", "-a", "a-", "a--b", "A", "a_b", "a.b", "x".repeat(40), "_x", ".x"]) {
      expect(HandleName.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("are never one of the reserved route names", () => {
    expect(RESERVED_HANDLES.has("api")).toBe(true);
    expect(RESERVED_HANDLES.size).toBe(37);
    // The pages origin's preview links (ADR-0012); no GitHub login has a "_" anyway.
    expect(isReservedHandle("_preview")).toBe(true);
    // Fly's health check, answered on every host before routing (review M5).
    expect(isReservedHandle("healthz")).toBe(true);
    for (const name of RESERVED_HANDLES) expect(HandleName.safeParse(name).success).toBe(false);
  });

  it("come from the login lowercased, suffixed when taken or reserved", () => {
    expect(handleFor("SeanPatrickMay", none)).toEqual({ ok: true, value: "seanpatrickmay" });
    const taken = (h: string) => ["sean", "sean-2"].includes(h);
    expect(handleFor("Sean", taken)).toEqual({ ok: true, value: "sean-3" });
    expect(handleFor("Pricing", none)).toEqual({ ok: true, value: "pricing-2" });
  });

  it("stay valid when a suffix cuts a long login at a hyphen", () => {
    const login = `${"a".repeat(36)}-bc`;
    const result = handleFor(login, (h) => h === login);
    expect(result).toEqual({ ok: true, value: `${"a".repeat(36)}-2` });
    if (result.ok) expect(HandleName.safeParse(result.value).success).toBe(true);
  });

  it("refuse a login GitHub could not have issued", () => {
    expect(handleFor("not a login", none)).toMatchObject({ ok: false, code: "invalid-input" });
  });
});

describe("slugs (Contract spec §9)", () => {
  it("are the repository name in lowercase kebab case", () => {
    expect(slugFor("RepoWiki", none)).toBe("repowiki");
    expect(slugFor("my_cool.project--v2", none)).toBe("my-cool-project-v2");
    expect(slugFor("--x--", none)).toBe("x");
    expect(slugFor("___", none)).toBe("project");
    expect(slugFor("Ünïcode", none)).toBe("n-code");
  });

  it("are cut to 64 characters and suffixed on collision within the handle", () => {
    const long = `${"a".repeat(63)}-b`;
    expect(slugFor(long, none)).toBe(`${"a".repeat(63)}`);
    expect(slugFor("repowiki", (s) => s === "repowiki")).toBe("repowiki-2");
    const slug = slugFor(long, (s) => s === "a".repeat(63));
    expect(slug).toBe(`${"a".repeat(62)}-2`);
    expect(Slug.safeParse(slug).success).toBe(true);
  });
});

describe("handle lookup (Contract spec §9)", () => {
  it("finds an active handle, follows redirects to it, and answers gone or missing", () => {
    const handles = byName(
      record("new"),
      record("mid", { state: "redirect", redirectTo: "new" }),
      record("old", { state: "redirect", redirectTo: "mid" }),
      record("dead", { accountId: B, state: "tombstoned" }),
    );
    expect(lookupHandle(handles, "new")).toEqual({ kind: "active", accountId: A, handle: "new" });
    expect(lookupHandle(handles, "old")).toEqual({ kind: "redirect", to: "new" });
    expect(lookupHandle(handles, "dead")).toEqual({ kind: "gone" });
    expect(lookupHandle(handles, "nobody")).toEqual({ kind: "missing" });
  });

  it("ends a redirect loop or a dangling redirect as missing", () => {
    const loop = byName(
      record("a", { state: "redirect", redirectTo: "b" }),
      record("b", { state: "redirect", redirectTo: "a" }),
    );
    expect(lookupHandle(loop, "a")).toEqual({ kind: "missing" });
    const dangling = byName(record("a", { state: "redirect", redirectTo: "zzz" }));
    expect(lookupHandle(dangling, "a")).toEqual({ kind: "missing" });
  });
});

describe("handle changes (Contract spec §9)", () => {
  it("retire the old handle as a redirect when the author claims their new login", () => {
    const result = claimHandle(byName(record("old")), A, "Fresh", T1);
    expect(result).toEqual({
      ok: true,
      value: [
        record("old", { state: "redirect", redirectTo: "fresh" }),
        record("fresh", { createdAt: T1 }),
      ],
    });
  });

  it("let an author reclaim a handle that redirects to them", () => {
    const handles = byName(record("new"), record("old", { state: "redirect", redirectTo: "new" }));
    expect(claimHandle(handles, A, "old", T1)).toEqual({
      ok: true,
      value: [record("new", { state: "redirect", redirectTo: "old" }), record("old")],
    });
  });

  it("refuse a handle someone else holds or held, a reserved one, or no change", () => {
    const handles = byName(record("mine"), record("theirs", { accountId: B, state: "tombstoned" }));
    expect(claimHandle(handles, A, "theirs", T1)).toMatchObject({ code: "invalid-input" });
    expect(claimHandle(handles, A, "api", T1)).toMatchObject({ code: "invalid-input" });
    expect(claimHandle(handles, A, "mine", T1)).toMatchObject({ code: "invalid-transition" });
    expect(claimHandle(handles, B, "fresh", T1)).toMatchObject({ code: "invalid-transition" });
  });

  it("tombstone every handle of a deleted account and nobody else's", () => {
    const handles = [
      record("new"),
      record("old", { state: "redirect", redirectTo: "new" }),
      record("other", { accountId: B }),
    ];
    expect(tombstoneHandles(handles, A)).toEqual([
      record("new", { state: "tombstoned" }),
      record("old", { state: "tombstoned" }),
    ]);
  });
});

describe("URLs (Contract spec §9)", () => {
  it("are our own https origin plus handle and slug; a project's is its wiki (ADR-0013)", () => {
    expect(projectUrl("https://repowiki.dev", "sean", "repowiki")).toBe(
      "https://repowiki.dev/sean/repowiki/",
    );
    expect(profileUrl("https://repowiki.dev", "sean")).toBe("https://repowiki.dev/sean");
    expect(siteKey(A, 3)).toBe(`sites/${A}/v3/`);
  });

  it("never use a provider's hostname or a non-https origin", () => {
    expect(Origin.safeParse("https://repowiki.dev").success).toBe(true);
    expect(Origin.safeParse("https://localhost:4387").success).toBe(true);
    for (const bad of [
      "http://repowiki.dev",
      "https://repowiki.dev/",
      "https://repowiki.dev/x",
      "https://repowiki.fly.dev",
      "https://pub-1.r2.dev",
      "https://x.workers.dev",
      // One spelling per origin (review fix): no trailing dot, no default port, no bare provider.
      "https://repowiki.fly.dev.",
      "https://repowiki.dev.",
      "https://fly.dev",
      "https://app.repowiki.app:443",
    ]) {
      expect(Origin.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("app paths are reserved handles (spec 2 §7)", () => {
  it("reserves every top-level path the server routes", () => {
    for (const name of ["internal", "llm", "preview", "projects"]) {
      expect(isReservedHandle(name)).toBe(true);
    }
  });
});
