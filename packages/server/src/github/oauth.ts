import { createHmac } from "node:crypto";
import { z } from "zod";
import { randomToken, safeEqual } from "../crypto.ts";
import type { GitHubEndpoints } from "./endpoints.ts";

/** GitHub's authorize page, asking for no scope at all (spec 2 S7). */
export function authorizeUrl(
  endpoints: GitHubEndpoints,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: "",
    allow_signup: "true",
  });
  return `${endpoints.web}/login/oauth/authorize?${query}`;
}

const TokenReply = z.object({ access_token: z.string().min(1) });

/** The access token for an OAuth code, or null when GitHub refuses it. */
export async function exchangeCode(
  fetchFn: typeof fetch,
  endpoints: GitHubEndpoints,
  input: { clientId: string; clientSecret: string; code: string; redirectUri: string },
): Promise<string | null> {
  const response = await fetchFn(`${endpoints.web}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const parsed = TokenReply.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.access_token : null;
}

/** How long a sign-in may take between leaving for GitHub and coming back (spec 2 S7). */
export const STATE_SECONDS = 600;

const mac = (key: Buffer, text: string) =>
  createHmac("sha256", key).update(text).digest("base64url");

/** The key that signs OAuth states, derived from TOKEN_KEY so it never doubles as the token key. */
export function stateKey(tokenKey: Buffer): Buffer {
  return createHmac("sha256", tokenKey).update("repowiki oauth state").digest();
}

/** `nonce.expires.mac`: a random value whose ten-minute life is signed. */
export function signedState(key: Buffer, nowMs: number): string {
  const body = `${randomToken()}.${Math.floor(nowMs / 1000) + STATE_SECONDS}`;
  return `${body}.${mac(key, body)}`;
}

export function stateValid(key: Buffer, state: string, nowMs: number): boolean {
  const [nonce, expires, sig, ...rest] = state.split(".");
  if (nonce === undefined || expires === undefined || sig === undefined || rest.length > 0) {
    return false;
  }
  return safeEqual(sig, mac(key, `${nonce}.${expires}`)) && Number(expires) * 1000 > nowMs;
}

const DISPLAY_NAME_MAX = 120;

/** GitHub's name, trimmed and cut to the Account schema's limit; the login when there is none. */
export function displayNameFor(name: string | null, login: string): string {
  let kept = "";
  for (const char of name?.trim() ?? "") {
    if (kept.length + char.length > DISPLAY_NAME_MAX) break;
    kept += char;
  }
  return kept.trim() || login;
}
