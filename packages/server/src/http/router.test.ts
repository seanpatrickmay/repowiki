import { describe, expect, it } from "vitest";
import { createRouter, matchPattern, type Route } from "./router.ts";

describe("matchPattern (spec 2 S2)", () => {
  it("matches literals, named segments and a rest", () => {
    expect(matchPattern("/projects/:id", "/projects/abc")).toEqual({ id: "abc" });
    expect(matchPattern("/projects/:id", "/projects/abc/x")).toBeNull();
    expect(matchPattern("/:handle/:slug/*", "/sean/repowiki/wiki/a/b")).toEqual({
      handle: "sean",
      slug: "repowiki",
      "*": "wiki/a/b",
    });
    expect(matchPattern("/:handle/:slug/*", "/sean/repowiki")).toEqual({
      handle: "sean",
      slug: "repowiki",
      "*": "",
    });
    expect(matchPattern("/", "/")).toEqual({});
  });

  it("decodes segments but refuses an encoded slash, NUL or an empty segment", () => {
    expect(matchPattern("/u/:name", "/u/a%20b")).toEqual({ name: "a b" });
    expect(matchPattern("/u/:name", "/u/a%2Fb")).toBeNull();
    expect(matchPattern("/u/:name", "/u/a%00")).toBeNull();
    expect(matchPattern("/u/:name", "/u/")).toBeNull();
    expect(matchPattern("/u/:name", "/u/%E0%A4%A")).toBeNull();
    expect(matchPattern("/:a/*", "/x/a%2Fb")).toBeNull();
    expect(matchPattern("/hello/:name", "/hello/%2E%2E")).toBeNull();
    expect(matchPattern("/hello/:name", "/hello/.")).toBeNull();
    expect(matchPattern("/hello/:name", "/hello/%2e")).toBeNull();
    expect(matchPattern("/s/*", "/s/a/%2E%2E/b")).toBeNull();
    expect(matchPattern("/hello/:name", "/hello/..x")).toEqual({ name: "..x" });
  });
});

describe("createRouter (spec 2 S2)", () => {
  const ok = async () => ({ status: 200 });
  const routes: Route[] = [
    { method: "GET", pattern: "/projects/:id", handler: ok },
    { method: "POST", pattern: "/projects", handler: ok },
    { method: "GET", pattern: "/:handle", handler: ok },
  ];
  const route = createRouter(routes);

  it("finds the first route whose method and pattern match", () => {
    expect(route("GET", "/projects/7")).toMatchObject({ params: { id: "7" } });
    expect(route("GET", "/sean")).toMatchObject({ params: { handle: "sean" } });
  });

  it("answers 405 for a known path with another method and 404 otherwise", () => {
    expect(route("DELETE", "/projects/7")).toEqual({ status: 405 });
    expect(route("GET", "/projects/7/x/y")).toEqual({ status: 404 });
  });
});
