import { z } from "zod";
import { ok, type Result, refused } from "./result.ts";

/** GitHub's login rule: 1–39 of [a-z0-9-], no leading, trailing or doubled hyphen. */
export const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
export const HANDLE_MAX_LENGTH = 39;
export const SLUG_MAX_LENGTH = 64;

/** Route names a handle may never take (Contract spec §9). */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  "_preview",
  "about",
  "account",
  "admin",
  "api",
  "app",
  "assets",
  "auth",
  "billing",
  "blog",
  "dashboard",
  "docs",
  "help",
  "internal",
  "llm",
  "login",
  "logout",
  "new",
  "p",
  "preview",
  "pricing",
  "privacy",
  "projects",
  "settings",
  "signin",
  "signup",
  "static",
  "status",
  "support",
  "terms",
  "u",
  "www",
]);

export function isReservedHandle(name: string): boolean {
  return RESERVED_HANDLES.has(name);
}

export const HandleName = z
  .string()
  .regex(HANDLE_PATTERN, "expected a GitHub login")
  .refine((name) => !isReservedHandle(name), "that handle is reserved");

export const Slug = z
  .string()
  .max(SLUG_MAX_LENGTH)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "expected a lowercase kebab-case slug");

/** Hostnames that belong to a hosting provider; nothing published may link to them (§9). */
const PROVIDER_HOST =
  /(?:^|\.)(?:fly\.dev|r2\.dev|r2\.cloudflarestorage\.com|workers\.dev|pages\.dev|neon\.tech)$/;

/**
 * RepoWiki's own https origin, with no path, in its one spelling: "https://repowiki.dev". A
 * trailing dot or the default port :443 would name the same host differently (review fix).
 */
export const Origin = z
  .string()
  .regex(
    /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/,
    "expected an https origin with no path or trailing dot",
  )
  .refine((origin) => !origin.endsWith(":443"), "the default port is implied")
  .refine(
    (origin) => !PROVIDER_HOST.test(origin.slice("https://".length).replace(/:\d+$/, "")),
    "a provider hostname",
  );

/** `base`, else `base-2`, `base-3`, …, each cut to fit `max` without a trailing hyphen. */
function firstFree(base: string, max: number, free: (candidate: string) => boolean): string {
  if (free(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, max - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (free(candidate)) return candidate;
  }
}

/** A new account's handle: its GitHub login lowercased, suffixed when taken or reserved. */
export function handleFor(login: string, taken: (handle: string) => boolean): Result<string> {
  const base = login.toLowerCase();
  if (!HANDLE_PATTERN.test(base)) return refused("invalid-input", "not a GitHub login");
  return ok(firstFree(base, HANDLE_MAX_LENGTH, (h) => !isReservedHandle(h) && !taken(h)));
}

/** A new project's slug: the repository name in kebab case, suffixed on collision (§9). */
export function slugFor(repoName: string, taken: (slug: string) => boolean): string {
  const kebab = repoName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, "");
  return firstFree(kebab || "project", SLUG_MAX_LENGTH, (slug) => !taken(slug));
}

export const HandleState = z.enum(["active", "redirect", "tombstoned"]);
export type HandleState = z.infer<typeof HandleState>;

export interface HandleRecord {
  handle: string;
  accountId: string;
  state: HandleState;
  /** The handle this one points to, set exactly when `state` is "redirect". */
  redirectTo: string | null;
  createdAt: string;
}

/** What a request for /<name> resolves to: the account, a 301 to its handle, a 410 or a 404. */
export type HandleLookup =
  | { kind: "active"; accountId: string; handle: string }
  | { kind: "redirect"; to: string }
  | { kind: "gone" }
  | { kind: "missing" };

const MAX_REDIRECTS = 16;

export function lookupHandle(
  handles: ReadonlyMap<string, HandleRecord>,
  name: string,
): HandleLookup {
  const first = handles.get(name);
  if (first === undefined) return { kind: "missing" };
  if (first.state === "tombstoned") return { kind: "gone" };
  if (first.state === "active") {
    return { kind: "active", accountId: first.accountId, handle: first.handle };
  }
  let record: HandleRecord = first;
  for (let hops = 0; hops < MAX_REDIRECTS && record.state === "redirect"; hops++) {
    const next: HandleRecord | undefined =
      record.redirectTo === null ? undefined : handles.get(record.redirectTo);
    if (next === undefined) return { kind: "missing" };
    record = next;
  }
  if (record.state === "active") return { kind: "redirect", to: record.handle };
  return record.state === "tombstoned" ? { kind: "gone" } : { kind: "missing" };
}

/**
 * The author's GitHub login changed (§9): the new login becomes their active handle and the old
 * one redirects to it for ever. Returns the changed records, the retired one first. A handle that
 * already redirects to this author may be reclaimed; any other existing handle may not.
 */
export function claimHandle(
  handles: ReadonlyMap<string, HandleRecord>,
  accountId: string,
  login: string,
  now: string,
): Result<HandleRecord[]> {
  const current = [...handles.values()].find(
    (h) => h.accountId === accountId && h.state === "active",
  );
  const name = login.toLowerCase();
  if (current === undefined || current.handle === name) return refused("invalid-transition");
  if (!HANDLE_PATTERN.test(name) || isReservedHandle(name)) {
    return refused("invalid-input", "that handle is not available");
  }
  const existing = handles.get(name);
  if (
    existing !== undefined &&
    !(existing.accountId === accountId && existing.state === "redirect")
  ) {
    return refused("invalid-input", "that handle is not available");
  }
  const claimed: HandleRecord =
    existing === undefined
      ? { handle: name, accountId, state: "active", redirectTo: null, createdAt: now }
      : { ...existing, state: "active", redirectTo: null };
  return ok([{ ...current, state: "redirect", redirectTo: name }, claimed]);
}

/** Account deletion: every handle the account ever held answers 410 and is never reassigned. */
export function tombstoneHandles(
  handles: Iterable<HandleRecord>,
  accountId: string,
): HandleRecord[] {
  return [...handles]
    .filter((h) => h.accountId === accountId)
    .map((h) => ({ ...h, state: "tombstoned", redirectTo: null }));
}

export function projectUrl(origin: string, handle: string, slug: string): string {
  return `${origin}/${handle}/${slug}`;
}

export function profileUrl(origin: string, handle: string): string {
  return `${origin}/${handle}`;
}

/** Where a published version's static site lives; written once, never overwritten (§9). */
export function siteKey(projectId: string, version: number): string {
  return `sites/${projectId}/v${version}/`;
}
