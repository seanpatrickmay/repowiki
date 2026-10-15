/** GitHub's avatar host: the only one the server fetches an avatar from (ADR-0013). */
export const AVATAR_HOST = "avatars.githubusercontent.com";
export const AVATAR_MAX_BYTES = 1_048_576;
const AVATAR_TIMEOUT_MS = 5_000;

export type AvatarType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const starts = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  bytes.length >= at + prefix.length && prefix.every((b, i) => bytes[at + i] === b);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** The image type the bytes are, by their magic numbers; null for anything else (an SVG too). */
export function avatarType(bytes: Uint8Array): AvatarType | null {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(bytes, ascii("GIF87a")) || starts(bytes, ascii("GIF89a"))) return "image/gif";
  if (starts(bytes, ascii("RIFF")) && starts(bytes, ascii("WEBP"), 8)) return "image/webp";
  return null;
}

/** `url` when it is an https URL on GitHub's avatar host with no credentials or port, else null. */
export function avatarSource(url: string | undefined): string | null {
  const parsed = url === undefined ? null : URL.parse(url);
  if (parsed === null || parsed.protocol !== "https:" || parsed.hostname !== AVATAR_HOST) {
    return null;
  }
  return parsed.username === "" && parsed.password === "" && parsed.port === ""
    ? (url ?? null)
    : null;
}

/** The body, or null once it passes `max` bytes. */
async function capped(response: Response, max: number): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > max) {
      await response.body.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/**
 * The avatar at `url` (already checked by `avatarSource`): no redirects, a 5-second timeout, at
 * most 1 MB, and only PNG, JPEG, GIF or WebP. Null on any failure; it never throws.
 */
export async function fetchAvatar(
  fetchFn: typeof fetch,
  url: string,
): Promise<{ bytes: Uint8Array; contentType: AvatarType } | null> {
  try {
    const response = await fetchFn(url, {
      redirect: "error",
      signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS),
      headers: { "user-agent": "RepoWiki" },
    });
    if (response.status !== 200) return null;
    const bytes = await capped(response, AVATAR_MAX_BYTES);
    const contentType = bytes === null ? null : avatarType(bytes);
    return bytes === null || contentType === null ? null : { bytes, contentType };
  } catch {
    return null;
  }
}

/** Where an avatar's bytes live in object storage, and where the pages origin serves them. */
export const avatarKey = (sha256: string) => `avatars/${sha256}`;
export const avatarPath = (sha256: string) => `/_app/avatar/${sha256}`;
