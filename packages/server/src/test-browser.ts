/** Test-only: drive the hosted app over HTTP like a browser (the e2e journeys). */

/** A browser with one cookie jar that follows no redirect on its own. */
export function browser(base: string) {
  const jar = new Map<string, string>();
  async function go(path: string, init: { form?: Record<string, string | string[]> } = {}) {
    const headers: Record<string, string> = {
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    };
    let body: string | undefined;
    if (init.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      headers.origin = base;
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(init.form)) {
        for (const one of [v].flat()) params.append(k, one);
      }
      body = params.toString();
    }
    const response = await fetch(new URL(path, base), {
      method: body === undefined ? "GET" : "POST",
      headers,
      body,
      redirect: "manual",
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const [name, ...value] = (pair ?? "").split("=");
      if (name) jar.set(name.trim(), value.join("="));
    }
    return {
      status: response.status,
      location: response.headers.get("location"),
      csp: response.headers.get("content-security-policy") ?? "",
      text: await response.text(),
    };
  }
  /** Follow same-origin redirects, up to 10. */
  async function follow(path: string) {
    let reply = await go(path);
    for (let hops = 0; hops < 10 && reply.location !== null; hops++) {
      const next = new URL(reply.location, base);
      if (next.origin !== new URL(base).origin) break;
      reply = await go(next.pathname + next.search);
    }
    return reply;
  }
  /** Reload `path` the way the page's own refresh does, until `done` holds for its text. */
  async function reloadUntil(path: string, done: (text: string) => boolean, ms = 240_000) {
    for (const start = Date.now(); ; await sleep(250)) {
      const reply = await go(path);
      if (done(reply.text)) return reply;
      if (Date.now() - start > ms) throw new Error(`${path} never became ready`);
    }
  }
  return { go, follow, reloadUntil };
}

export const field = (html: string, name: string) =>
  new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
