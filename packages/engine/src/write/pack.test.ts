import { readFileSync } from "node:fs";
import { memberId } from "@repowiki/core";
import { describe, expect, it } from "vitest";
import type { CommitInfo, IndexedFile } from "../index/index.ts";
import { citedLines } from "../verify/index.ts";
import { buildPack, type PackInput, signatureLines } from "./pack.ts";
import { testWiki } from "./test-wiki.ts";

const input = (overrides: Partial<PackInput> = {}): PackInput => ({
  featureId: "signals",
  ...testWiki(),
  neighbours: new Map([["deliverables", 1.5]]),
  budgetTokens: 30_000,
  ...overrides,
});

/** The numbered lines of one file's block in a pack: [number, text] pairs. */
function shownLines(packText: string, path: string): { header: string; lines: [number, string][] } {
  const start = packText.indexOf(`### ${path} (`);
  const block = packText.slice(start, packText.indexOf("\n\n", start)).split("\n");
  const lines = block.slice(1).map((row): [number, string] => {
    const match = /^\s*(\d+)\| (.*)$/.exec(row);
    return [Number(match?.[1]), match?.[2] ?? ""];
  });
  return { header: block[0] ?? "", lines };
}

/** Characters that must not reach the prompt (everything but "\n", tab, ZWJ and ZWNJ). */
const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}\p{Cf}]/u;
const allowed = (text: string) => text.replace(/[\n\t\u200C\u200D]/g, "");

const hash = (n: number) => n.toString(16).padStart(40, "0");
const commit = (n: number, subject: string, files: string[]): CommitInfo => ({
  sha: hash(n),
  parents: [],
  date: "2026-03-01T10:00:00-05:00",
  subject,
  files,
  pr: null,
});

/** testWiki with `extra` more member files of `lines` lines each under the signals feature. */
function bigWiki(extra: number, lines: number) {
  const wiki = testWiki();
  const body = `${Array.from({ length: lines }, (_, i) => `value_${i} = ${i}`).join("\n")}\n`;
  for (let i = 0; i < extra; i++) {
    const path = `src/signals/bulk/file_${String(i).padStart(4, "0")}.py`;
    wiki.sources.set(path, body);
    wiki.index.files.push({
      id: memberId(path),
      path,
      language: "python",
      bytes: body.length,
      loc: lines,
      skipped: null,
      parseError: false,
      symbols: [],
    });
    wiki.manifest.membership[memberId(path)] = { featureId: "signals", weight: 0.3 };
  }
  return wiki;
}

describe("buildPack", () => {
  it("shows member files in full with line numbers, heaviest first", () => {
    const pack = buildPack(input());
    expect(pack.shown).toEqual([
      { path: "src/signals/ingest.py", mode: "full" },
      { path: "src/signals/store.py", mode: "full" },
      { path: "docs/signals.md", mode: "full" },
    ]);
    expect(pack.text).toContain(
      '### src/signals/ingest.py (31 lines)\n 1| """Turns ingested chunks into signals."""',
    );
    expect(pack.text).toContain("10| def ingest_chunk(chunk):");
    expect(pack.text.indexOf("ingest.py (31")).toBeLessThan(pack.text.indexOf("store.py (2"));
  });

  it("lists the feature's commits, its limitation evidence and its neighbours", () => {
    const pack = buildPack(input());
    expect(pack.commits.map((c) => c.subject)).toEqual([
      'Revert "feat: page through long chunks"',
      "feat: add signal ingestion",
    ]);
    expect(pack.text).toContain(
      '- commit:b111111 2026-02-03 Revert "feat: page through long chunks" (PR #12)',
    );
    // Reverting commits come first: they are the strongest evidence of a limitation.
    expect(pack.text).toContain(
      '## Evidence for known limitations\n- commit:b111111 Revert "feat: page through long chunks"\n- src/signals/ingest.py:20: # TODO: page through long chunks instead of truncating\n\n',
    );
    expect(pack.text).toContain("Neighbouring features: deliverables (Deliverables, 1.5)");
    expect(pack.text.endsWith("Write the page.")).toBe(true);
  });

  it("falls back to signatures past 70% of the budget, then to listing the path", () => {
    expect(buildPack(input({ budgetTokens: 900 })).shown.map((s) => s.mode)).toEqual([
      "full",
      "signatures",
      "listed",
    ]);
    const pack = buildPack(input({ budgetTokens: 450 }));
    expect(pack.shown.map((s) => s.mode)).toEqual(["signatures", "signatures", "listed"]);
    expect(pack.text).toContain(
      '### src/signals/ingest.py (31 lines; signatures only)\n10| def ingest_chunk(chunk):\n11|     """Creates one signal per sentence in the chunk."""\n27| @dataclass\n28| class Signal:',
    );
    expect(pack.text).toContain("## Other member files (not shown)\n- docs/signals.md");
  });

  it("keeps control characters in source out of the prompt", () => {
    const { sources, ...rest } = testWiki();
    sources.set("src/signals/store.py", "def save_signal(signal):\n    return '\u001b[2J'\n");
    const pack = buildPack({ ...input(), ...rest, sources });
    expect(pack.text).not.toContain("\u001b");
  });

  it("refuses a feature that is not in the manifest", () => {
    expect(() => buildPack(input({ featureId: "ghost" }))).toThrow("ghost is not in the manifest");
  });

  it("builds the same text from the same input, whatever order the maps were filled in", () => {
    const a = buildPack(input());
    const b = buildPack(input());
    expect(b).toEqual(a);
    const wiki = testWiki();
    const reordered = new Map([...wiki.sources].reverse());
    expect(buildPack({ ...input(), ...wiki, sources: reordered }).text).toBe(a.text);
  });

  describe("line numbers", () => {
    // CRLF, no trailing newline, and an empty file: the three shapes where line models drift.
    const crlf = "def save(a):\r\n    return a\r\n";
    const bare = "# Signals\n\nHow signals work.";
    const empty = "";
    const pack = (() => {
      const { sources, ...rest } = testWiki();
      sources.set("src/signals/store.py", crlf);
      sources.set("docs/signals.md", bare);
      sources.set("src/signals/ingest.py", empty);
      return buildPack({ ...input(), ...rest, sources });
    })();

    it("shows line N exactly as a citation of line N resolves it", () => {
      for (const [path, text] of [
        ["src/signals/store.py", crlf],
        ["docs/signals.md", bare],
      ] as const) {
        const { header, lines } = shownLines(pack.text, path);
        expect(lines.map(([n]) => n)).toEqual(lines.map((_, i) => i + 1));
        expect(header).toBe(`### ${path} (${lines.length} lines)`);
        for (const [n, shown] of lines) {
          // The only difference is the CR that ends a CRLF line, which is not worth a token.
          expect(`${shown}${text.includes("\r\n") ? "\r" : ""}`).toBe(citedLines(text, n, n));
        }
      }
      expect(shownLines(pack.text, "src/signals/store.py").lines).toHaveLength(2);
      expect(shownLines(pack.text, "docs/signals.md").lines).toHaveLength(3);
    });

    it("shows an empty file with no lines", () => {
      expect(shownLines(pack.text, "src/signals/ingest.py")).toEqual({
        header: "### src/signals/ingest.py (0 lines)",
        lines: [],
      });
    });

    it("numbers limitation evidence by the same lines", () => {
      const { sources, ...rest } = testWiki();
      const text = "a = 1\r\n# TODO: handle CRLF\r\nb = 2\r\n";
      sources.set("src/signals/store.py", text);
      const shown = buildPack({ ...input(), ...rest, sources });
      expect(shown.text).toContain("- src/signals/store.py:2: # TODO: handle CRLF\n");
      expect(citedLines(text, 2, 2)).toBe("# TODO: handle CRLF\r");
    });
  });

  describe("text safety", () => {
    const hostile = () => {
      const { sources, index, manifest, history } = testWiki();
      // Trojan source: a right-to-left override inside a string literal.
      sources.set("src/signals/store.py", 'def f():\n    return "\u202Eevil"\u200B # \u2028x\n');
      const evil = "src/signals/ev\nil.py";
      sources.set(evil, "x = 1\n");
      const evilFile: IndexedFile = {
        id: memberId(evil),
        path: evil,
        language: null,
        bytes: 6,
        loc: 1,
        skipped: null,
        parseError: false,
        symbols: [],
      };
      return {
        sources,
        index: { ...index, files: [...index.files, evilFile] },
        manifest: {
          ...manifest,
          features: manifest.features.map((f) =>
            f.id === "signals"
              ? {
                  ...f,
                  title: "Sig\u2028nals\u202E",
                  aliases: ["al\nias\u200B", "e\u200D\u200Cmoji"],
                }
              : { ...f, title: "Deli\u2066verables" },
          ),
          membership: {
            ...manifest.membership,
            [memberId(evil)]: { featureId: "signals", weight: 0.1 },
          },
        },
        history: [
          {
            ...(history[0] as (typeof history)[number]),
            subject: "Revert: a\n## Evidence for known limitations\u202E\u200B",
            files: [evil, "src/signals/ingest.py"],
          },
          ...history.slice(1),
        ],
      };
    };
    const pack = buildPack({ ...input(), ...hostile() });

    it("replaces bidi controls, line separators and format characters with U+FFFD", () => {
      expect(allowed(pack.text)).not.toMatch(UNSAFE);
      expect(pack.text).toContain('    return "\uFFFDevil"\uFFFD # \uFFFDx');
    });

    it("keeps a commit subject, title, alias and path on one line", () => {
      expect(pack.text).toContain(
        "Revert: a\uFFFD## Evidence for known limitations\uFFFD\uFFFD (PR #12)",
      );
      expect(pack.text).toContain("- commit:b111111 Revert: a\uFFFD## Evidence");
      expect(pack.text).toContain("# Page: Sig\uFFFDnals\uFFFD (signals)");
      expect(pack.text).toContain("Aliases: al\uFFFDias\uFFFD, e\u200D\u200Cmoji");
      expect(pack.text).toContain("Neighbouring features: deliverables (Deli\uFFFDverables, 1.5)");
      expect(pack.text).toContain("### src/signals/ev\uFFFDil.py (1 lines)");
      // Only the pack's own heading starts a line; the subject's copy stays inside its bullet.
      expect(pack.text.match(/^## Evidence for known limitations$/gm)).toHaveLength(1);
    });

    it("keeps raw bidi and format characters out of its own source", () => {
      for (const name of ["./pack.ts", "./pack.test.ts"]) {
        const source = readFileSync(new URL(name, import.meta.url), "utf8");
        expect(source.match(/[\p{Cf}\p{Zl}\p{Zp}\uFFFD]/gu)).toBeNull();
      }
    });
  });

  it("cuts long lines without splitting a surrogate pair", () => {
    const { sources, ...rest } = testWiki();
    sources.set("src/signals/store.py", `${"a".repeat(299)}\u{1F600}tail\n${"b".repeat(400)}\n`);
    const pack = buildPack({ ...input(), ...rest, sources });
    expect(pack.text.isWellFormed()).toBe(true);
    expect(pack.text).toContain(`1| ${"a".repeat(299)}\u2026\n2| ${"b".repeat(300)}\u2026\n`);
  });

  describe("caps", () => {
    it("lists at most 40 commits and counts the rest", () => {
      const wiki = testWiki();
      const history = Array.from({ length: 60 }, (_, i) =>
        commit(60 - i, `chore: change ${60 - i}`, ["src/signals/store.py"]),
      );
      const pack = buildPack({ ...input(), ...wiki, history });
      expect(pack.commits).toHaveLength(60);
      expect(pack.text.match(/^- commit:/gm)).toHaveLength(40);
      expect(pack.text).toContain("chore: change 60\n");
      expect(pack.text).not.toContain("chore: change 20\n");
      expect(pack.text).toContain("\n- and 20 older commits\n");
    });

    it("lists at most 30 pieces of evidence: reverts, then skipped tests, then TODO lines", () => {
      const wiki = testWiki();
      const todos = Array.from({ length: 40 }, (_, i) => `# TODO: item ${i}`).join("\n");
      wiki.sources.set("src/signals/store.py", `${todos}\nit.skip("later", () => {});\n`);
      // A TODO in another feature's file is not evidence for this page.
      wiki.sources.set("src/deliverables/crud.py", "# TODO: not ours\n");
      const history = [
        commit(2, 'Revert "feat: x"', ["src/signals/store.py"]),
        commit(1, "feat: x", ["src/signals/store.py"]),
      ];
      const pack = buildPack({ ...input(), ...wiki, history });
      const section = pack.text.split("## Evidence for known limitations\n")[1] ?? "";
      const bullets = section.slice(0, section.indexOf("\n\n")).split("\n");
      expect(bullets).toHaveLength(30);
      expect(bullets[0]).toBe('- commit:0000000 Revert "feat: x"');
      expect(bullets[1]).toBe('- src/signals/store.py:41: it.skip("later", () => {});');
      expect(bullets[2]).toBe(
        "- src/signals/ingest.py:20: # TODO: page through long chunks instead of truncating",
      );
      expect(bullets[3]).toBe("- src/signals/store.py:1: # TODO: item 0");
      expect(bullets[29]).toBe("- src/signals/store.py:27: # TODO: item 26");
      expect(pack.text).not.toContain("not ours");
    });
  });

  describe("budget", () => {
    it("keeps the whole pack within the budget for a feature with 1,500 files", () => {
      for (const budgetTokens of [1_500, 3_000, 8_000]) {
        const pack = buildPack({ ...input(), ...bigWiki(1_500, 40), budgetTokens });
        expect(pack.tokens).toBeLessThanOrEqual(budgetTokens);
        expect(pack.shown).toHaveLength(1_503);
        expect(pack.text).toMatch(/\n- and \d+ more files\n/);
      }
    });

    it("lists not-shown paths while they fit, then counts the rest", () => {
      const pack = buildPack({ ...input(), ...bigWiki(1_500, 40), budgetTokens: 3_000 });
      const section = pack.text.split("## Other member files (not shown)\n")[1] ?? "";
      const lines = section.slice(0, section.indexOf("\n\n")).split("\n");
      const paths = lines.filter((l) => l.startsWith("- src/"));
      const more = /^- and (\d+) more files$/.exec(lines.at(-1) ?? "");
      expect(paths.length).toBeGreaterThan(0);
      expect(Number(more?.[1]) + paths.length).toBe(
        pack.shown.filter((s) => s.mode === "listed").length,
      );
    });

    it("never goes over a budget the header and candidates fit in", () => {
      for (const budgetTokens of [400, 500, 900, 2_000, 30_000]) {
        for (const wiki of [input(), { ...input(), ...bigWiki(30, 200) }]) {
          const pack = buildPack({ ...wiki, budgetTokens });
          expect(pack.tokens).toBeLessThanOrEqual(budgetTokens);
        }
      }
    });

    it("trims commits, then evidence, when the rest of the pack is over the budget", () => {
      const wiki = testWiki();
      const history = [
        commit(100, 'Revert "feat: x"', ["src/signals/store.py"]),
        ...Array.from({ length: 39 }, (_, i) =>
          commit(i + 1, `chore: change ${i}`, ["src/signals/store.py"]),
        ),
      ];
      wiki.sources.set("src/signals/store.py", "# TODO: one\n# TODO: two\n");
      const build = (budgetTokens: number) =>
        buildPack({ ...input(), ...wiki, history, budgetTokens });
      const roomy = build(30_000).text;
      const commitsHeading = "## Commits that touched this feature (newest first)\n";
      const commitsAt = roomy.indexOf(commitsHeading);
      const commitsLength = roomy.indexOf("\n\n## Evidence") - commitsAt;
      const sourceLength = commitsAt - (roomy.indexOf("## Source") + "## Source".length);
      // What the pack needs apart from its source files.
      const fixed = roomy.length - sourceLength + 2;

      const some = build(Math.floor((fixed - 600) / 2.5));
      expect(some.tokens).toBeLessThanOrEqual(Math.floor((fixed - 600) / 2.5));
      const listedCommits = some.text.match(/^- commit:\w+ \d{4}-\d\d-\d\d chore/gm)?.length ?? 0;
      expect(listedCommits).toBeGreaterThan(20);
      expect(listedCommits).toBeLessThan(39);
      expect(some.text).toMatch(/\n- and \d+ older commits\n/);
      const evidenceAfter = some.text.split("## Evidence for known limitations\n")[1] ?? "";
      expect(evidenceAfter.slice(0, evidenceAfter.indexOf("\n\n")).split("\n")).toHaveLength(4);

      // Tighter still: every commit goes before any evidence does.
      const tightTokens = Math.floor((fixed - commitsLength + 60) / 2.5);
      const tight = build(tightTokens);
      expect(tight.tokens).toBeLessThanOrEqual(tightTokens);
      expect(tight.text).not.toContain("chore: change");
      expect(tight.text).toMatch(/\n- 40 commits not listed\n/);
      expect(tight.text).toContain('- commit:0000000 Revert "feat: x"');
      expect(tight.text).toMatch(/\n- and \d+ more evidence items not listed\n/);
    });
  });
});

describe("signatureLines", () => {
  const lines = [
    "/**",
    " * Fetches JSON.",
    " */",
    "export async function fetchJson(",
    "  url: string,",
    "): Promise<unknown> {",
    "  return fetch(url);",
    "}",
    "def f(x):",
    "    '''One line.'''",
    "    return x",
  ];
  const symbol = (startLine: number, endLine: number) => ({
    id: "x",
    qualifiedName: "x",
    kind: "function" as const,
    startLine,
    endLine,
    exported: true,
  });
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);

  it("takes a JSDoc block and a multi-line signature up to its body", () => {
    expect(signatureLines(lines, symbol(4, 8))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("takes a Python signature and a one-line docstring", () => {
    expect(signatureLines(lines, symbol(9, 11))).toEqual([9, 10]);
  });

  it("gets past five stacked decorators to the def line", () => {
    const src = ["@a", "@b", "@c", "@d", "@e", "async def route(x):", "    return x"];
    expect(signatureLines(src, symbol(1, 7))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("gets past a multi-line decorator to the def line", () => {
    const src = [
      "@router.post(",
      '    "/x",',
      "    response_model=Foo,",
      ")",
      "async def create(",
      "    body: Body,",
      ") -> Foo:",
      '    """Creates one."""',
      "    return 1",
    ];
    expect(signatureLines(src, symbol(1, 9))).toEqual(range(1, 8));
  });

  it("runs a Python signature of six lines to its colon", () => {
    const src = ["def f(", "    a,", "    b,", "    c,", "    d,", ") -> int:", "    return 1"];
    expect(signatureLines(src, symbol(1, 7))).toEqual(range(1, 6));
  });

  it("stops a signature at 12 lines", () => {
    const src = ["def f(", ...Array.from({ length: 20 }, (_, i) => `    p${i},`), "):", "    pass"];
    expect(signatureLines(src, symbol(1, src.length))).toEqual(range(1, 12));
  });

  it("stops at the brace after destructured parameters, not the one inside them", () => {
    expect(
      signatureLines(["function Foo({ a, b }: Props) {", "  return a;", "}"], symbol(1, 3)),
    ).toEqual([1]);
    const multi = ["export function Foo({", "  a,", "  b,", "}: Props) {", "  return a;", "}"];
    expect(signatureLines(multi, symbol(1, 6))).toEqual([1, 2, 3, 4]);
    const typed = ["function f(opts: {", "  a: string;", "}) {", "  return 1;", "}"];
    expect(signatureLines(typed, symbol(1, 5))).toEqual([1, 2, 3]);
  });

  it("ends a TypeScript overload at its semicolon", () => {
    const src = [
      "export function f(a: string): string;",
      "export function f(a: number): number;",
      "export function f(a: unknown) {",
      "  return a;",
      "}",
    ];
    expect(signatureLines(src, symbol(1, 1))).toEqual([1]);
    expect(signatureLines(src, symbol(2, 2))).toEqual([2]);
    expect(signatureLines(src, symbol(3, 5))).toEqual([3]);
  });

  it("ends an arrow-function const at its arrow", () => {
    const multi = [
      "export const load = async (",
      "  id: string,",
      "): Promise<string> => {",
      "  return id;",
      "};",
    ];
    expect(signatureLines(multi, symbol(1, 5))).toEqual([1, 2, 3]);
    expect(
      signatureLines(["const inc = (a: number) => a + 1;", "const b = 2;"], symbol(1, 1)),
    ).toEqual([1]);
  });

  it("strips # comments in Python only", () => {
    expect(
      signatureLines(["function f(a: string) { // not #", "  return a;", "}"], symbol(1, 3)),
    ).toEqual([1]);
    expect(
      signatureLines(["def f(a,  # first: one", "      b):  # {", "    return a"], symbol(1, 3)),
    ).toEqual([1, 2]);
  });

  it("takes single-quoted, multi-line and prefixed docstrings", () => {
    const multi = ["def f():", "    r'''Line one.", "    Line two.'''", "    return 1"];
    expect(signatureLines(multi, symbol(1, 4))).toEqual([1, 2, 3]);
    const prefixed = ["def g():", '    rb"""Bytes."""', "    return 1"];
    expect(signatureLines(prefixed, symbol(1, 3))).toEqual([1, 2]);
    const f = ["def h():", '    f"""Format {x}."""', "    return 1"];
    expect(signatureLines(f, symbol(1, 3))).toEqual([1, 2]);
    const single = ["def k():", '    "Returns x."', "    return 1"];
    expect(signatureLines(single, symbol(1, 3))).toEqual([1, 2]);
  });

  it("takes the language from its caller when it is known", () => {
    expect(
      signatureLines(["class A(", "    Base,", "):", "    pass"], symbol(1, 4), "python"),
    ).toEqual([1, 2, 3]);
  });
});
