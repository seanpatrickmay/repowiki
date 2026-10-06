import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseRepoUrl, parseSiteArgs, UsageError } from "./args.ts";

const dir = mkdtempSync(join(tmpdir(), "repowiki-args-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("parseSiteArgs", () => {
  it("defaults --out to a site directory next to the export file", () => {
    expect(parseSiteArgs(["build", "--export", "/data/demo/export.json"])).toEqual({
      command: "build",
      exportFile: "/data/demo/export.json",
      outDir: "/data/demo/site",
      repoUrl: null,
      inflight: true,
    });
  });

  it("treats an --export directory as <dir>/export.json", () => {
    const args = parseSiteArgs(["build", "--export", dir]);
    expect(args.exportFile).toBe(join(dir, "export.json"));
    expect(args.outDir).toBe(join(dir, "site"));
  });

  it("resolves relative paths and keeps an explicit --out", () => {
    const args = parseSiteArgs(["build", "--export", "x.json", "--out", "out"]);
    expect(args.exportFile).toBe(resolve("x.json"));
    expect(args.outDir).toBe(resolve("out"));
  });

  it("normalizes --repo-url and drops trailing slashes", () => {
    const args = parseSiteArgs([
      "build",
      "--export",
      "x.json",
      "--repo-url",
      "https://github.com/a/b/",
    ]);
    expect(args.repoUrl).toBe("https://github.com/a/b");
  });

  it.each(["javascript:alert(1)", "github.com/a/b", "file:///etc"])(
    "rejects --repo-url %j",
    (url) => {
      expect(() => parseSiteArgs(["build", "--export", "x.json", "--repo-url", url])).toThrow(
        UsageError,
      );
    },
  );

  it("accepts a plain http --repo-url", () => {
    const args = parseSiteArgs([
      "build",
      "--export",
      "x.json",
      "--repo-url",
      "http://git.local/a/b",
    ]);
    expect(args.repoUrl).toBe("http://git.local/a/b");
  });

  it.each([
    "https://x-access-token:ghp_SECRET@github.com/a/b",
    "https://ghp_SECRET@github.com/a/b",
    "https://user:ghp_SECRET@github.com/a/b?x=1#frag",
  ])("rejects --repo-url credentials without echoing them: %j", (url) => {
    expect(() => parseSiteArgs(["build", "--export", "x.json", "--repo-url", url])).toThrow(
      UsageError,
    );
    try {
      parseSiteArgs(["build", "--export", "x.json", "--repo-url", url]);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("ghp_SECRET");
      expect(message).toContain("credentials");
      expect(message.split("\n")).toHaveLength(1);
    }
  });

  it.each(["https://github.com/a/b?x=1", "https://github.com/a/b#frag", "https://github.com/a/b?"])(
    "rejects a --repo-url with a query or fragment: %j",
    (url) => {
      expect(() => parseSiteArgs(["build", "--export", "x.json", "--repo-url", url])).toThrow(
        /query or fragment/,
      );
    },
  );

  it("names the source it validates", () => {
    expect(() => parseRepoUrl("https://github.com/a/b#x", "REPOWIKI_REPO_URL")).toThrow(
      /^REPOWIKI_REPO_URL /,
    );
    expect(parseRepoUrl(undefined)).toBeNull();
  });

  it("lets preview take --out alone", () => {
    expect(parseSiteArgs(["preview", "--out", "/srv/site"])).toEqual({
      command: "preview",
      exportFile: null,
      outDir: "/srv/site",
      repoUrl: null,
      inflight: true,
    });
  });

  it("takes --no-inflight for a build to another --out than the export's site/", () => {
    expect(
      parseSiteArgs(["build", "--no-inflight", "--export", "/d/export.json", "--out", "/share"]),
    ).toMatchObject({ outDir: "/share", inflight: false });
    expect(() => parseSiteArgs(["build", "--export", "/d/export.json", "--no-inflight"])).toThrow(
      /^--no-inflight refuses \/d\/site, the site wiki:serve rebuilds/,
    );
    expect(() =>
      parseSiteArgs(["build", "--export", "/d/x.json", "--out", "/d/site", "--no-inflight"]),
    ).toThrow(/^--no-inflight refuses/);
    expect(() =>
      parseSiteArgs([
        "build",
        "--export",
        "x.json",
        "--out",
        "o",
        "--no-inflight",
        "--no-inflight",
      ]),
    ).toThrow(/^--no-inflight was given more than once/);
    expect(() => parseSiteArgs(["preview", "--out", "o", "--no-inflight"])).toThrow(
      /^only build takes --no-inflight/,
    );
  });

  it.each([
    [[]],
    [["serve"]],
    [["build"]],
    [["preview"]],
    [["build", "--export"]],
    [["build", "--export", "--out", "x"]],
    [["build", "--export", "x.json", "--bogus", "1"]],
  ])("rejects %j", (argv) => {
    expect(() => parseSiteArgs(argv)).toThrow(UsageError);
  });
});
