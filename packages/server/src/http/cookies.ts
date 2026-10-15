/** The cookies of a Cookie header; the first value of a repeated name wins. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    if (cookies.has(name)) continue;
    let value = part.slice(at + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      continue;
    }
    cookies.set(name, value);
  }
  return cookies;
}

export interface CookieOptions {
  maxAgeSeconds: number;
  secure: boolean;
  httpOnly: boolean;
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${options.maxAgeSeconds}`,
    "SameSite=Lax",
    ...(options.httpOnly ? ["HttpOnly"] : []),
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

/** `__Host-` binds the cookie to our origin; loopback development cannot set Secure (S6). */
export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-session" : "session";
}
