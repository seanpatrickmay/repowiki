// The path a built site is served under (`--base`, issue #610). No imports: the client scripts
// read the page's base with pageBase, and the build validates --base with isBasePath.

/** "/" or "/seg/.../": segments of [A-Za-z0-9._~-], none of them "." or "..". */
const BASE_PATH = /^\/(?:(?!\.\.?\/)[A-Za-z0-9._~-]+\/)*$/;

/**
 * Whether `value` is a base path the site can splice into HTML attributes, CSS and scripts: it
 * has no quote, space, backslash, `%`, `?`, `#`, `:`, empty segment or dot segment.
 */
export function isBasePath(value: string): boolean {
  return BASE_PATH.test(value);
}

/** The base the build put on the page's `<html data-base>`, or "/" when it has none. */
export function pageBase(root: { dataset: { base?: string | undefined } }): string {
  const base = root.dataset.base;
  return base !== undefined && isBasePath(base) ? base : "/";
}
