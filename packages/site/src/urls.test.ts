import { afterEach, describe, expect, it } from "vitest";
import {
  activityUrl,
  architectureUrl,
  articleUrl,
  personUrl,
  previewUrl,
  pullUrl,
  siteBase,
  withBase,
} from "./urls.ts";

afterEach(() => {
  delete process.env.REPOWIKI_BASE;
});

describe("withBase", () => {
  it("is the identity under the default base /", () => {
    for (const path of ["/", "/wiki/x/", "/special/about/", "/api/preview/x.json", "/p/#a"]) {
      expect(withBase(path, "/")).toBe(path);
      expect(withBase(path)).toBe(path);
    }
  });

  it("prefixes a base once", () => {
    expect(withBase("/", "/wiki/demo/")).toBe("/wiki/demo/");
    expect(withBase("/wiki/x/", "/wiki/demo/")).toBe("/wiki/demo/wiki/x/");
  });

  it.each(["", "wiki/x/", "//evil.example/", "https://evil.example/"])(
    "refuses %j, which is not a root-absolute site path",
    (path) => {
      expect(() => withBase(path, "/wiki/demo/")).toThrow(/root-absolute site path/);
    },
  );
});

describe("the URL helpers", () => {
  it("put every URL under the build's REPOWIKI_BASE, once", () => {
    process.env.REPOWIKI_BASE = "/wiki/demo/";
    expect(siteBase()).toBe("/wiki/demo/");
    expect(articleUrl("signals")).toBe("/wiki/demo/wiki/signals/");
    expect(previewUrl("signals")).toBe("/wiki/demo/api/preview/signals.json");
    expect(architectureUrl()).toBe("/wiki/demo/special/about/");
    expect(pullUrl(12)).toBe("/wiki/demo/special/in-progress/pr/12/");
    expect(personUrl("ada-lovelace")).toBe("/wiki/demo/people/ada-lovelace/");
    expect(activityUrl("2026")).toBe("/wiki/demo/special/activity/2026/");
  });

  it("keep today's root URLs without a base", () => {
    expect(siteBase()).toBe("/");
    expect(articleUrl("signals")).toBe("/wiki/signals/");
    expect(pullUrl(12)).toBe("/special/in-progress/pr/12/");
  });

  it("refuse a REPOWIKI_BASE that is not a base path", () => {
    process.env.REPOWIKI_BASE = '/x"><script>/';
    expect(() => articleUrl("signals")).toThrow(/^REPOWIKI_BASE must be/);
  });
});
