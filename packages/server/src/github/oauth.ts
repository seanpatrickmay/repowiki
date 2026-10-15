import { z } from "zod";
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
