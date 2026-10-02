import { describe, expect, it } from "vitest";
import { codeAliases, IDENTIFIER_PATTERNS, MAX_CODE_ALIASES } from "./aliases.ts";
import { linkManifest } from "./test-manifest.ts";

const sources = new Map([
  [
    "src/signals/ingest.py",
    [
      '@router.get("/api/signals")',
      '@router.post("/api/signals")',
      "class SignalRow(Base):",
      '    __tablename__ = "signals_table"',
      'URL = os.environ["SIGNALS_URL"]',
      'TOKEN = os.getenv("SHARED_TOKEN")',
      '@cli.command("ingest-signals")',
    ].join("\n"),
  ],
  [
    "src/signals/score.py",
    'op.create_table("Signal Ingestion")\nCREATE TABLE IF NOT EXISTS scores (id int)',
  ],
  ["src/deliverables/crud.py", 'TOKEN = os.getenv("SHARED_TOKEN")\napp.get(`/deliverables/:id`)'],
  [
    "src/billing/invoice.py",
    "const key = process.env.STRIPE_KEY;\nconst v = import.meta.env.VITE_API_URL;",
  ],
]);

/** The aliases found when `text` is the only source, in billing's one file. */
function billingFrom(text: string): string[] | undefined {
  return codeAliases(linkManifest(), new Map([["src/billing/invoice.py", text]])).billing;
}

describe("codeAliases (F01)", () => {
  it("finds routes, tables, env vars and commands in each feature's files, most frequent first", () => {
    expect(codeAliases(linkManifest(), sources)).toEqual({
      billing: ["STRIPE_KEY", "VITE_API_URL"],
      deliverables: ["/deliverables/:id"],
      signals: ["/api/signals", "SIGNALS_URL", "ingest-signals", "scores", "signals_table"],
    });
  });

  it("leaves out identifiers two features share and ones that collide with a feature's names", () => {
    const found = Object.values(codeAliases(linkManifest(), sources)).flat();
    expect(found).not.toContain("SHARED_TOKEN");
    expect(found).not.toContain("Signal Ingestion");
  });

  it(`keeps at most ${MAX_CODE_ALIASES} per feature`, () => {
    const many = Array.from(
      { length: 15 },
      (_, i) => `x = os.getenv("VAR_${String(i).padStart(2, "0")}")`,
    );
    const found = codeAliases(
      linkManifest(),
      new Map([["src/billing/invoice.py", many.join("\n")]]),
    );
    expect(found.billing).toHaveLength(MAX_CODE_ALIASES);
  });

  it("skips, never truncates, an identifier that is not a valid manifest alias", () => {
    const route60 = `/${"a".repeat(59)}`;
    const route61 = `/${"a".repeat(60)}`;
    // An astral character is two UTF-16 units but one code point, as proposalProblems counts.
    const astral60 = `/${"\u{1F600}".repeat(59)}`;
    const astral61 = `/${"\u{1F600}".repeat(60)}`;
    const found = billingFrom(
      [route60, route61, astral60, astral61].map((route) => `@router.get("${route}")`).join("\n"),
    );
    expect(found).toEqual([astral60, route60].sort());
  });

  it("treats a name two features spell in different letter cases as shared", () => {
    const found = codeAliases(
      linkManifest(),
      new Map([
        ["src/billing/invoice.py", 'x = os.getenv("TOKEN_X")'],
        ["src/deliverables/crud.py", 'x = os.getenv("TOKEN_X")\ny = os.getenv("ONLY_HERE")'],
        ["src/signals/ingest.py", '@router.get("/Same")'],
        ["src/deliverables/api.py", '@router.get("/same")'],
      ]),
    );
    expect(found).toEqual({ deliverables: ["ONLY_HERE"] });
  });

  it("skips routes holding control, line-separator or bidi characters", () => {
    const bad = ["‮", "⁦", "﻿", " ", "\u0007", "\u0085"];
    const text = [
      ...bad.map((c) => `@router.get("/a${c}b")`),
      '@router.get("/fine")',
      'x = os.getenv("STRIPE‮_KEY")',
      'y = os.getenv("OTHER_KEY")',
    ].join("\n");
    expect(billingFrom(text)).toEqual(["/fine", "OTHER_KEY"]);
  });

  it("finishes fast on a 200 KB line of repeated decorator prefixes", () => {
    const unit = "@a.b.c.d.e.f.g.h";
    const lines = [
      unit.repeat(Math.ceil(200_000 / unit.length)),
      "@a".repeat(100_000),
      `@${"a.".repeat(100_000)}`,
      `@${"a".repeat(200_000)}`,
      "CREATE ".repeat(30_000),
      `CREATE${" ".repeat(200_000)}TABLE${" ".repeat(10)}`,
      `CREATE TABLE${" ".repeat(200_000)}`,
      `os.getenv(${" ".repeat(200_000)}`,
      `app.get(${" ".repeat(200_000)}`,
    ];
    for (const line of lines) {
      const started = performance.now();
      expect(billingFrom(line)).toBeUndefined();
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it("has no pattern that can match the empty string", () => {
    for (const { pattern } of IDENTIFIER_PATTERNS) expect("".match(pattern)).toBeNull();
  });
});
