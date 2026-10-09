import { describe, expect, it } from "vitest";
import { goToRandomArticle } from "./random.ts";

/** Just enough of a document and location to see where the reader is sent. */
function fakeEnv(targets: string | null, base?: string) {
  const replaced: string[] = [];
  const doc = {
    getElementById: (id: string) =>
      id === "random-targets" && targets !== null ? { textContent: targets } : null,
    documentElement: { dataset: { base } },
  };
  const location = { replace: (url: string) => replaced.push(url) };
  return { doc, location, replaced };
}

describe("goToRandomArticle", () => {
  it("sends the reader to one of the embedded article URLs", () => {
    const urls = ["/wiki/a/", "/wiki/b/", "/wiki/c/"];
    for (const [random, expected] of [
      [0, "/wiki/a/"],
      [0.5, "/wiki/b/"],
      [0.999, "/wiki/c/"],
    ] as const) {
      const { doc, location, replaced } = fakeEnv(JSON.stringify(urls));
      goToRandomArticle(doc, location, () => random);
      expect(replaced).toEqual([expected]);
    }
  });

  it("does nothing when there are no articles", () => {
    const { doc, location, replaced } = fakeEnv("[]");
    goToRandomArticle(doc, location, () => 0.3);
    expect(replaced).toEqual([]);
  });

  it.each([null, "not json", '{"a":1}', "null"])("does nothing for targets %j", (targets) => {
    const { doc, location, replaced } = fakeEnv(targets);
    goToRandomArticle(doc, location, () => 0);
    expect(replaced).toEqual([]);
  });

  it("never navigates anywhere but a same-site article URL", () => {
    const hostile = [
      "https://evil.example/",
      "//evil.example/",
      "javascript:alert(1)",
      "/wiki/../x/",
      "/other/",
      42,
    ];
    const { doc, location, replaced } = fakeEnv(JSON.stringify(hostile));
    goToRandomArticle(doc, location, () => 0);
    expect(replaced).toEqual([]);
    const mixed = fakeEnv(JSON.stringify([...hostile, "/wiki/ok-1/"]));
    goToRandomArticle(mixed.doc, mixed.location, () => 0.99);
    expect(mixed.replaced).toEqual(["/wiki/ok-1/"]);
  });

  it("takes only article URLs under the page's base", () => {
    const urls = ["/wiki/a/", "/wiki/demo/wiki/b/", "/wiki/demo/wiki/../x/", "/wiki/demo/other/"];
    for (const [random, expected] of [
      [0, "/wiki/demo/wiki/b/"],
      [0.99, "/wiki/demo/wiki/b/"],
    ] as const) {
      const { doc, location, replaced } = fakeEnv(JSON.stringify(urls), "/wiki/demo/");
      goToRandomArticle(doc, location, () => random);
      expect(replaced).toEqual([expected]);
    }
  });
});
