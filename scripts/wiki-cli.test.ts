import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeArchitecture } from "@repowiki/core/test-fixtures";
import { type ArchitectureOutcome, type ContextPack, WikiBuildError } from "@repowiki/engine";
import { describe, expect, it } from "vitest";
import { CliError } from "./manifest-cli.ts";
import {
  ASSUMED_ARCHITECTURE_OUTPUT_TOKENS,
  ASSUMED_PAGE_OUTPUT_TOKENS,
  acquireBuildLock,
  BUILD_LOCK,
  describeError,
  estimateArchitecture,
  estimateBuild,
  parseWikiArgs,
  problemLine,
  renderBuildSummary,
} from "./wiki-cli.ts";

describe("parseWikiArgs", () => {
  it("reads the repo, rev and flags in any order, with defaults", () => {
    expect(parseWikiArgs(["--dry-run", "../repo", "7247d28", "--budget", "20000"])).toEqual({
      repo: "../repo",
      rev: "7247d28",
      out: null,
      config: null,
      batch: true,
      dryRun: true,
      budgetTokens: 20_000,
      deadlineMinutes: null,
      verbose: false,
    });
    expect(
      parseWikiArgs(["../repo", "--no-batch", "--deadline", "90", "--out", "/tmp/w"]),
    ).toMatchObject({
      rev: "HEAD",
      batch: false,
      deadlineMinutes: 90,
      out: "/tmp/w",
    });
  });

  it.each([
    [[]],
    [["a", "b", "c"]],
    [["a", "--budget", "0"]],
    [["a", "--deadline", "soon"]],
    [["a", "--unknown"]],
  ])("refuses %j with a CliError", (argv) => {
    expect(() => parseWikiArgs(argv)).toThrow(CliError);
  });

  it("takes a deadline of a positive number of minutes up to 24 hours", () => {
    expect(parseWikiArgs(["a", "--deadline", "1440"]).deadlineMinutes).toBe(1440);
    expect(parseWikiArgs(["a", "--deadline", "0.5"]).deadlineMinutes).toBe(0.5);
    for (const bad of [
      "0",
      "-5",
      "1441",
      "Infinity",
      "NaN",
      "",
      "1e9",
      "1e2",
      "0x10",
      " 5 ",
      "5.",
      ".5",
    ])
      expect(() => parseWikiArgs(["a", "--deadline", bad])).toThrow(CliError);
  });

  it("takes a budget of a positive integer only", () => {
    expect(parseWikiArgs(["a"]).budgetTokens).toBe(30_000);
    for (const bad of [
      "1.5",
      "-1",
      "NaN",
      "",
      "0",
      "00",
      "9".repeat(20),
      "0x10",
      "1e2",
      " 5 ",
      "+5",
    ])
      expect(() => parseWikiArgs(["a", "--budget", bad])).toThrow(CliError);
  });

  it("refuses an empty repo, --out or --config", () => {
    for (const argv of [[""], ["a", "--out", ""], ["a", "--config", ""]])
      expect(() => parseWikiArgs(argv)).toThrow(CliError);
  });

  it("refuses a repeated flag", () => {
    for (const argv of [
      ["a", "--budget", "5", "--budget", "6"],
      ["a", "--out", "x", "--out", "y"],
      ["a", "--config", "x", "--config", "y"],
      ["a", "--deadline", "5", "--deadline", "6"],
      ["a", "--no-batch", "--no-batch"],
      ["a", "--dry-run", "--dry-run"],
    ])
      expect(() => parseWikiArgs(argv)).toThrow(CliError);
  });

  it("echoes an unknown flag cut to 40 characters and never past an equals sign", () => {
    const long = `--${"k".repeat(60)}`;
    let message = "";
    try {
      parseWikiArgs(["a", `${long}=hunter2`]);
    } catch (err) {
      message = (err as CliError).message;
    }
    expect(message).toContain(long.slice(0, 40));
    expect(message).not.toContain(long.slice(0, 41));
    expect(message).not.toContain("hunter2");
    expect(message).not.toMatch(/[\r\n]/);
  });

  it.each([
    [["a", "--budget", "hunter2"], "--budget"],
    [["a", "--deadline", "hunter2"], "--deadline"],
    [["a", "--unknown=hunter2"], "--unknown"],
    [["a", "--out"], "--out"],
    [["a", "--no-batch=hunter2"], "--no-batch"],
    [["a", "--ANTHROPIC_API_KEY=hunter2"], "--ANTHROPIC_API_KEY"],
  ])("answers %j with one line that names only the flag", (argv, flag) => {
    let message = "";
    try {
      parseWikiArgs(argv);
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      message = (err as CliError).message;
    }
    expect(message).toContain(flag);
    expect(message).not.toContain("hunter2");
    expect(message).not.toMatch(/[\r\n]/);
  });
});

const pack = (tokens: number) => ({ tokens }) as ContextPack;

describe("estimateBuild", () => {
  it("prices every page's prefix, pack and assumed answer at Haiku 4.5 rates", () => {
    const system = "x".repeat(10_000); // 4,000 estimated tokens
    const estimate = estimateBuild([pack(20_000), pack(26_000)], system, "claude-haiku-4-5", false);
    expect(estimate).toEqual({
      pages: 2,
      inputTokens: 54_000,
      outputTokens: 2 * ASSUMED_PAGE_OUTPUT_TOKENS,
      usd: (54_000 * 1 + 8_000 * 5) / 1_000_000,
    });
    expect(
      estimateBuild([pack(20_000), pack(26_000)], system, "claude-haiku-4-5", true).usd,
    ).toBeCloseTo(estimate.usd / 2, 12);
  });
});

const totals = {
  calls: 3,
  batchCalls: 3,
  tokens: { in: 1000, out: 200, cacheRead: 4000, cacheWrite: 0 },
  usd: 0.0123,
  unpricedCalls: 0,
};
const estimate = { pages: 1, inputTokens: 1, outputTokens: 1, usd: 0.02 };
const failed = (featureId: string, failure: string) => ({
  featureId,
  revision: null,
  failure,
  dropped: [],
  calls: 2,
  tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
});

describe("estimateBuild with an unpriced model", () => {
  it("is a CliError naming the model cut to 80 characters, before any call", () => {
    const id = `gpt-${"9".repeat(100)}\nsecond line`;
    let message = "";
    try {
      estimateBuild([pack(1)], "x", id, true);
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      message = (err as CliError).message;
    }
    expect(message).toMatch(
      /^no price for model gpt-9+; add it to packages\/llm\/src\/pricing\.ts$/,
    );
    expect(message.length).toBeLessThan(150);
    expect(message).not.toMatch(/[\r\n]/);
  });
});

describe("renderBuildSummary", () => {
  it("lists every page with its claims, drops and calls, and the cost against the estimate", () => {
    const summary = renderBuildSummary(
      "repo",
      "a".repeat(40),
      [failed("a", "the write call failed: x|y")],
      estimate,
      totals,
    );
    expect(summary).toContain("0 of 1 pages written, 0 claims dropped.");
    expect(summary).toContain("| `a` | 0 | 0 | 2 | `the write call failed: x\\|y` |");
    expect(summary).toContain(
      "3 calls (3 batched): 1,000 input, 200 output, 4,000 cache-read, 0 cache-write tokens.",
    );
    expect(summary).toContain("Cost: $0.0123 (estimated up front: $0.0200 for the first round).");
  });

  it("says on its own line that the estimate runs high, and ends on the Cost line", () => {
    const summary = renderBuildSummary("repo", "a".repeat(40), [], estimate, totals);
    expect(summary.split("\n")).toContain(
      "The estimate is an upper-side estimate with no cache hits.",
    );
    expect(summary.trimEnd().split("\n").at(-1)).toBe(
      "Cost: $0.0123 (estimated up front: $0.0200 for the first round).",
    );
    const bare = renderBuildSummary("repo", "a".repeat(40), [], null, totals);
    expect(bare).not.toContain("estimate");
    expect(bare.trimEnd().split("\n").at(-1)).toBe("Cost: $0.0123.");
  });

  it("says when no LLM call was made, and counts unpriced calls", () => {
    const none = { ...totals, calls: 0, batchCalls: 0, usd: 0 };
    expect(renderBuildSummary("repo", "a".repeat(40), [], estimate, none)).toContain(
      "no LLM call made",
    );
    expect(renderBuildSummary("repo", "a".repeat(40), [], estimate, totals)).not.toContain(
      "no LLM call made",
    );
    expect(renderBuildSummary("repo", "a".repeat(40), [], null, totals)).not.toContain("no price");
    const unpriced = renderBuildSummary("repo", "a".repeat(40), [], null, {
      ...totals,
      unpricedCalls: 2,
    });
    expect(unpriced).toContain("2 calls have no known price");
  });

  it("renders the repo name and failure as code spans that no Markdown can leave", () => {
    const hostile =
      "x\n# Injected <script>alert(1)</script> [x](javascript:alert(1)) ![i](http://x) <http://x> https://evil.example a@b.co |";
    const summary = renderBuildSummary(
      hostile,
      "a".repeat(40),
      [failed("a", hostile)],
      estimate,
      totals,
    );
    expect(summary.split("\n").filter((l) => l.startsWith("#"))).toEqual([
      expect.stringMatching(/^# Build: `x # Injected /),
      "## LLM cost",
    ]);
    const h1 = summary.split("\n")[0] ?? "";
    expect(h1).toMatch(/^# Build: `[^`]*` at aaaaaaa$/);
    const row = summary.split("\n").find((l) => l.startsWith("| `")) ?? "";
    expect(row.split(/(?<!\\)\|/)).toHaveLength(7);
    for (const line of [h1, row]) {
      const outside = line.replace(/(`+).*?\1/g, "");
      for (const live of ["](", "<script", "![", "<http", "https://", "@"])
        expect(outside).not.toContain(live);
    }
  });

  it("keeps a feature id's pipe from splitting its row", () => {
    const summary = renderBuildSummary(
      "repo",
      "a".repeat(40),
      [failed("t `x` | [x](y)", "boom")],
      estimate,
      totals,
    );
    const row = summary.split("\n").find((l) => l.startsWith("| ``")) ?? "";
    const cells = row.slice(1, -1).split(/(?<!\\)\|/);
    expect(cells).toHaveLength(5);
    expect(cells[0]).toBe(" ``t `x` \\| [x](y)`` ");
  });
});

describe("problemLine", () => {
  it("is one printable line, redacted of API keys, cut to 300 characters", () => {
    expect(problemLine("signals c-\u202e1\u0007\n: no such commit")).toBe(
      "signals c-?1? : no such commit",
    );
    expect(problemLine("x".repeat(400))).toHaveLength(300);
  });
});

describe("describeError", () => {
  const failed = new Error("stored data failed to migrate (ZodError)", {
    cause: new Error("revision signals-1:\n\u202ebad\tclaim", { cause: "disk" }),
  });

  it("prints only the message unless verbose", () => {
    expect(describeError(failed, false)).toBe("stored data failed to migrate (ZodError)");
  });

  it("prints each cause on a printable line of its own when verbose", () => {
    expect(describeError(failed, true).split("\n")).toEqual([
      "stored data failed to migrate (ZodError)",
      "caused by: Error: revision signals-1: ?bad claim",
      "caused by: disk",
    ]);
    const long = new Error("top", { cause: new Error("x".repeat(1000)) });
    expect(describeError(long, true).split("\n")[1]).toHaveLength(300 + "caused by: ".length);
  });

  describe("redaction", () => {
    const withKey = (key: string | undefined, body: () => void) => {
      const saved = process.env.ANTHROPIC_API_KEY;
      if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = key;
      try {
        body();
      } finally {
        if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = saved;
      }
    };

    it("replaces every occurrence of the configured key, in the first line and in causes", () => {
      withKey("fake-key-not-a-real-secret-0123", () => {
        const err = new Error("auth failed for fake-key-not-a-real-secret-0123", {
          cause: new Error(
            "sent fake-key-not-a-real-secret-0123 and fake-key-not-a-real-secret-0123 again",
          ),
        });
        const text = describeError(err, true);
        expect(text).not.toContain("fake-key");
        expect(text.split("\n")).toEqual([
          "auth failed for [redacted]",
          "caused by: Error: sent [redacted] and [redacted] again",
        ]);
      });
    });

    it("replaces a key-shaped string even when it is not the configured key", () => {
      withKey(undefined, () => {
        const err = new Error("top sk-ant-api03-FAKEFIRSTLINE_x-y rest", {
          cause: new TypeError(
            'Headers.append: "sk-ant-api03-FAKEHEADER_a-b\r\n" is an invalid header value.',
          ),
        });
        expect(describeError(err, true).split("\n")).toEqual([
          "top [redacted] rest",
          'caused by: TypeError: Headers.append: "[redacted] " is an invalid header value.',
        ]);
      });
    });

    it("replaces a key inside JSON-escaped text, its dashes escaped or not", () => {
      withKey("fake-key-not-a-real-secret-0123", () => {
        const body = '{"error":{"message":"invalid x-api-key: \\"sk-ant-api03-FAKEJSON_x-y\\""}}';
        const escaped = '{"key":"sk\\u002dant\\u002dapi03\\u002dFAKEUNI_x\\u002Dy"}';
        const doubled =
          '"{\\\\"key\\\\":\\\\"sk\\\\u002dant\\\\u002dapi03\\\\u002dFAKEDOUBLE\\\\"}"';
        const tail = "sk-ant-api03\\u002dFAKETAIL-z";
        const configured = '"fake\\u002dkey\\u002dnot\\u002da\\u002dreal\\u002dsecret\\u002d0123"';
        const err = new Error(body, {
          cause: new Error(`${escaped} ${doubled} ${tail} ${configured}`),
        });
        const text = describeError(err, true);
        for (const leak of ["FAKEJSON", "FAKEUNI", "FAKEDOUBLE", "FAKETAIL", "secret", "0123"])
          expect(text).not.toContain(leak);
        expect(text.split("\n")[0]).toBe(
          '{"error":{"message":"invalid x-api-key: \\"[redacted]\\""}}',
        );
      });
    });

    it("redacts before cutting, so a cut never leaves a prefix of the key", () => {
      withKey("fake-key-not-a-real-secret-0123", () => {
        const err = new Error("top", {
          cause: new Error(`${"x".repeat(285)}fake-key-not-a-real-secret-0123`),
        });
        expect(describeError(err, true)).not.toContain("fake-key");
      });
    });

    it("replaces GitHub token shapes, which a gh or git fetch error can echo (R25)", () => {
      withKey(undefined, () => {
        // Built at run time, so no token-shaped literal sits in the source.
        const classic = `gh${"p"}_${"A1b2".repeat(9)}`;
        const app = `gh${"s"}_${"Z9y8".repeat(9)}`;
        const fine = `github${"_"}pat_11ABCDEFG_${"x".repeat(40)}`;
        const err = new Error(`fetch failed: https://${classic}@github.com/acme/demo`, {
          cause: new Error(`gh: Bad credentials ${app} and ${fine}`),
        });
        const text = describeError(err, true);
        for (const leak of [classic, app, fine, "A1b2", "Z9y8", "11ABCDEFG"])
          expect(text).not.toContain(leak);
        expect(text.split("\n")).toEqual([
          "fetch failed: https://[redacted]@github.com/acme/demo",
          "caused by: Error: gh: Bad credentials [redacted] and [redacted]",
        ]);
        expect(problemLine(`git: ${classic}`)).toBe("git: [redacted]");
        // A word that only starts like a token prefix stays.
        expect(problemLine("the ghost_town and ghp test")).toBe("the ghost_town and ghp test");
      });
    });

    it("ignores an empty configured key", () => {
      withKey("", () => {
        expect(describeError(new Error("plain message"), true)).toBe("plain message");
      });
    });
  });

  it("filters the first line to printable ASCII on one line", () => {
    expect(describeError(new Error("bad\n\u202eclaim\tx"), false)).toBe("bad ?claim x");
  });

  it("describes a cause that cannot be stringified instead of throwing", () => {
    const bare = Object.assign(Object.create(null), { detail: "x" });
    const err = new Error("top", { cause: bare });
    expect(describeError(err, true).split("\n")).toEqual(["top", "caused by: [object Object]"]);
  });
});

describe("acquireBuildLock", () => {
  const withDir = (body: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "repowiki-lock-"));
    try {
      body(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("takes the lock, refuses a second build while it is held, and frees it on release", () => {
    withDir((dir) => {
      const release = acquireBuildLock(dir, () => {});
      const lock = join(dir, BUILD_LOCK);
      expect(readFileSync(lock, "utf8")).toMatch(/^pid \d+ since \d{4}-/);
      expect(() => acquireBuildLock(dir, () => {})).toThrow(WikiBuildError);
      expect(() => acquireBuildLock(dir, () => {})).toThrow(
        `another wiki:build, wiki:update or wiki:replay is running on ${dir} (${lock}); if none is, delete the lock file`,
      );
      release();
      expect(existsSync(lock)).toBe(false);
      acquireBuildLock(dir, () => {})();
    });
  });

  it("takes over a lock whose process is gone, and says so", () => {
    withDir((dir) => {
      const lock = join(dir, BUILD_LOCK);
      writeFileSync(lock, "pid 2147483646 since 2026-10-02T00:00:00.000Z\n");
      const lines: string[] = [];
      const release = acquireBuildLock(dir, (line) => lines.push(line));
      expect(lines).toEqual([`ignoring the lock of a build that is no longer running: ${lock}`]);
      expect(readFileSync(lock, "utf8")).toContain(`pid ${process.pid} `);
      release();
    });
  });

  it("loses a takeover race with a one-line refusal, not a raw fs error", () => {
    withDir((dir) => {
      const lock = join(dir, BUILD_LOCK);
      writeFileSync(lock, "pid 2147483646 since 2026-10-02T00:00:00.000Z\n");
      // Another run takes the freed lock between this one's removing it and creating it again.
      const rival = () =>
        writeFileSync(lock, `pid ${process.pid} since 2026-10-03T00:00:00.000Z\n`);
      expect(() => acquireBuildLock(dir, rival)).toThrow(WikiBuildError);
      expect(readFileSync(lock, "utf8")).toContain("2026-10-03");
    });
  });

  it("leaves exactly one holder when two runs both judge the same lock stale", () => {
    withDir((dir) => {
      const lock = join(dir, BUILD_LOCK);
      writeFileSync(lock, "pid 2147483646 since 2026-10-02T00:00:00.000Z\n");
      let winner: (() => void) | null = null;
      // B has judged the old lock stale when A takes it over and starts running.
      const raced = () => {
        winner = acquireBuildLock(dir, () => {});
      };
      expect(() => acquireBuildLock(dir, () => {}, raced)).toThrow(
        `another wiki:build, wiki:update or wiki:replay is running on ${dir} (${lock}); if none is, delete the lock file`,
      );
      // A's live lock was put back untouched, and nothing else is left in the dir.
      expect(readFileSync(lock, "utf8")).toContain(`pid ${process.pid} since 2026-1`);
      expect(readdirSync(dir)).toEqual([BUILD_LOCK]);
      const release = winner as (() => void) | null;
      expect(release).not.toBeNull();
      release?.();
      expect(existsSync(lock)).toBe(false);
    });
  });

  it("never replaces a live lock taken in the gap, and leaves no temp files behind", () => {
    withDir((dir) => {
      const lock = join(dir, BUILD_LOCK);
      writeFileSync(lock, "pid 2147483646 since 2026-10-02T00:00:00.000Z\n");
      const rival = () => writeFileSync(lock, "pid 1 since 2026-10-03T00:00:00.000Z\n");
      expect(() => acquireBuildLock(dir, rival)).toThrow(WikiBuildError);
      expect(readFileSync(lock, "utf8")).toBe("pid 1 since 2026-10-03T00:00:00.000Z\n");
      expect(readdirSync(dir)).toEqual([BUILD_LOCK]);
    });
  });

  it("does not delete another run's lock when a displaced run releases", () => {
    withDir((dir) => {
      const lock = join(dir, BUILD_LOCK);
      const displaced = acquireBuildLock(dir, () => {});
      // The lock was deleted by hand and another run took it.
      rmSync(lock);
      const owner = acquireBuildLock(dir, () => {});
      const ownerLine = readFileSync(lock, "utf8");
      displaced();
      expect(readFileSync(lock, "utf8")).toBe(ownerLine);
      displaced();
      owner();
      expect(existsSync(lock)).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  it("frees the lock when the build is interrupted or terminated", () => {
    withDir((dir) => {
      const module = new URL("./wiki-cli.ts", import.meta.url).href;
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        const script = `const { acquireBuildLock } = await import(${JSON.stringify(module)});
acquireBuildLock(${JSON.stringify(dir)}, () => {});
process.kill(process.pid, ${JSON.stringify(signal)});
setTimeout(() => {}, 5000);`;
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
          encoding: "utf8",
        });
        expect(result.stderr).toBe("");
        expect(result.signal).toBe(signal);
        expect(existsSync(join(dir, BUILD_LOCK))).toBe(false);
      }
    });
  });

  it("never takes a lock whose process is alive, however old it is", () => {
    withDir((dir) => {
      const lock = join(dir, BUILD_LOCK);
      // A replay can outlive 24 hours (each batched step may wait that long), and its lock's
      // mtime is never refreshed: age alone says nothing while its pid runs.
      const line = `pid ${process.pid} since 2026-01-01T00:00:00.000Z\n`;
      writeFileSync(lock, line);
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
      utimesSync(lock, old, old);
      const lines: string[] = [];
      expect(() => acquireBuildLock(dir, (l) => lines.push(l))).toThrow(WikiBuildError);
      expect(lines).toEqual([]);
      expect(readFileSync(lock, "utf8")).toBe(line);
    });
  });

  it("takes over a lock older than 24 hours only when its line names no pid, and says so", () => {
    withDir((dir) => {
      const lock = join(dir, BUILD_LOCK);
      writeFileSync(lock, "since 2026-01-01T00:00:00.000Z\n");
      // Younger than a batch can run: the holder cannot be judged gone.
      expect(() => acquireBuildLock(dir, () => {})).toThrow(WikiBuildError);
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      utimesSync(lock, old, old);
      const lines: string[] = [];
      const release = acquireBuildLock(dir, (line) => lines.push(line));
      expect(lines).toEqual([`ignoring a stale lock older than 24 hours: ${lock}`]);
      expect(readFileSync(lock, "utf8")).toContain(`pid ${process.pid} `);
      release();
    });
  });
});

describe("estimateArchitecture", () => {
  it("prices the system prompt, the whole pack budget with its edge windows and the assumed answer", () => {
    const system = "x".repeat(10_000); // 4,000 estimated tokens
    // The lines around edge sites may add 15% of the 50,000-token budget on top of it.
    expect(estimateArchitecture(system, 50_000, "claude-haiku-4-5", true)).toEqual({
      inputTokens: 61_500,
      outputTokens: ASSUMED_ARCHITECTURE_OUTPUT_TOKENS,
      usd: ((61_500 * 1 + 5_000 * 5) / 1_000_000) * 0.5,
    });
  });

  it("is a CliError for an unpriced model", () => {
    expect(() => estimateArchitecture("x", 1, "gpt-9", true)).toThrow(CliError);
  });
});

describe("renderBuildSummary with the About article", () => {
  const outcome = (overrides: Partial<ArchitectureOutcome>): ArchitectureOutcome => ({
    architecture: makeArchitecture(),
    failure: null,
    dropped: [],
    calls: 1,
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    pack: { text: "", tokens: 0, features: [], shown: new Map() },
    ...overrides,
  });
  const row = (summary: string) =>
    summary.split("\n").find((l) => l.startsWith("| About article")) ?? "";

  it("adds a row for a written, a failed, a current and a skipped article", () => {
    const at = (architecture: Parameters<typeof renderBuildSummary>[5]) =>
      row(renderBuildSummary("repo", "a".repeat(40), [], estimate, totals, architecture));
    expect(at({ outcome: outcome({}), skipped: null })).toBe(
      "| About article | 3 | 0 | 1 | written |",
    );
    expect(
      at({ outcome: outcome({ architecture: null, failure: "a|b", calls: 2 }), skipped: null }),
    ).toBe("| About article | 0 | 0 | 2 | `a\\|b` |");
    expect(at({ outcome: null, skipped: "current" })).toBe(
      "| About article | 0 | 0 | 0 | already current; no call |",
    );
    expect(at({ outcome: null, skipped: "too few pages" })).toBe(
      "| About article | 0 | 0 | 0 | skipped: fewer than two pages |",
    );
    expect(row(renderBuildSummary("repo", "a".repeat(40), [], estimate, totals))).toBe("");
  });

  it("states the About article's estimate on the Cost line when there is one", () => {
    const summary = renderBuildSummary(
      "repo",
      "a".repeat(40),
      [],
      { ...estimate, architectureUsd: 0.0359 },
      totals,
      { outcome: outcome({}), skipped: null },
    );
    expect(summary.trimEnd().split("\n").at(-1)).toBe(
      "Cost: $0.0123 (estimated up front: $0.0200 for the first round, plus $0.0359 for the About article).",
    );
  });
});
