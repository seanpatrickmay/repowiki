/**
 * The site's Content-Security-Policy, one constant for both places it is sent (C10): the meta
 * every page's Layout renders, and the header pnpm wiki:serve sends with `frame-ancestors 'none'`
 * added. v1's policy, byte for byte; `connect-src 'self'` already admits /api/ask.
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";
