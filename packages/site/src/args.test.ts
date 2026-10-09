import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseBase, parseRepoUrl, parseSiteArgs, UsageError } from "./args.ts";

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
      base: "/",
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
      base: "/",
    });
  });

  it("takes --no-inflight for a build to another --out than the export's site/", () => {
    expect(
      parseSiteArgs(["build", "--no-inflight", "--export", "/d/export.json", "--out", "/share"]),
    ).toMatchObject({ outDir: "/share", inflight: false });
    expect(() => parseSiteArgs(["build", "--export", "/d/export.json", "--no-inflight"])).toThrow(
      /^--no-inflight refuses \/d\/site, the default site, built with the work in flight/,
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

  it("refuses the export's own site/ for --no-inflight however a symlink spells it", () => {
    const real = join(dir, "real");
    const link = join(dir, "link");
    mkdirSync(real);
    writeFileSync(join(real, "export.json"), "{}\n");
    symlinkSync(real, link);
    for (const [exportFile, out] of [
      [join(real, "export.json"), join(link, "site")],
      [join(link, "export.json"), join(real, "site")],
      [join(link, "export.json"), join(link, "sub", "..", "site")],
    ]) {
      expect(() =>
        parseSiteArgs(["build", "--export", exportFile ?? "", "--out", out ?? "", "--no-inflight"]),
      ).toThrow(/^--no-inflight refuses /);
    }
    expect(
      parseSiteArgs([
        "build",
        "--export",
        join(link, "export.json"),
        "--out",
        join(real, "share"),
        "--no-inflight",
      ]),
    ).toMatchObject({ inflight: false });
  });

  it.each([
    ["/", "/"],
    ["wiki/ncos", "/wiki/ncos/"],
    ["/wiki/ncos", "/wiki/ncos/"],
    ["wiki/ncos/", "/wiki/ncos/"],
    ["/wiki/ncos/", "/wiki/ncos/"],
    ["demo", "/demo/"],
    ["A-z_0.9~x/v1.2", "/A-z_0.9~x/v1.2/"],
    ["...", "/.../"],
  ])("normalizes --base %j to %j", (given, base) => {
    expect(parseSiteArgs(["build", "--export", "x.json", "--base", given]).base).toBe(base);
    expect(parseSiteArgs(["preview", "--out", "o", "--base", given]).base).toBe(base);
  });

  it.each([
    "",
    "//",
    "//evil.example/x",
    "wiki//ncos",
    "..",
    "../x",
    "wiki/../x",
    "wiki/..",
    ".",
    "wiki/./ncos",
    "./wiki",
    "wiki?x=1",
    "wiki#top",
    "wiki%2F..",
    'wiki"onload="alert(1)',
    "wiki'x",
    "wiki`x",
    "wiki ncos",
    "wiki\\ncos",
    "https://evil.example/",
    "javascript:alert(1)",
    "wiki/<script>",
    "wiki)/x",
    "wiki;x",
    "wiki\nncos",
    "wiki/\u00e9",
  ])("refuses --base %j with a usage error", (base) => {
    expect(() => parseSiteArgs(["build", "--export", "x.json", "--base", base])).toThrow(
      UsageError,
    );
    expect(() => parseBase(base)).toThrow(/^--base must be/);
  });

  it("names the source it validates the base from", () => {
    expect(() => parseBase("../x", "REPOWIKI_BASE")).toThrow(/^REPOWIKI_BASE must be/);
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
