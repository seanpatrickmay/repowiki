import { afterEach, describe, expect, it } from "vitest";
import { authorEnv, siteAuthor } from "./author.ts";

afterEach(() => {
  delete process.env.REPOWIKI_AUTHOR;
});

describe("the site's author (ADR-0013)", () => {
  it("is none outside a hosted build", () => {
    expect(siteAuthor()).toBeNull();
    process.env.REPOWIKI_AUTHOR = authorEnv(undefined);
    expect(siteAuthor()).toBeNull();
  });

  it("is the name and biography path the build was given", () => {
    process.env.REPOWIKI_AUTHOR = authorEnv({ name: "Ada <Lovelace>", url: "/ada" });
    expect(siteAuthor()).toEqual({ name: "Ada <Lovelace>", url: "/ada" });
  });

  it("refuses anything but a root-absolute path of plain segments, and an empty name", () => {
    for (const url of ["//evil.test", "https://evil.test/", "/a b", '/a"b', "ada", "/a/../b"]) {
      expect(() => authorEnv({ name: "Ada", url }), url).toThrow();
    }
    expect(() => authorEnv({ name: "", url: "/ada" })).toThrow();
  });
});
