import { describe, expect, it } from "vitest";
import { hasVisibleText, normalizedText, withoutEmails } from "./plain-text.ts";

describe("normalizedText (spec v2 #6 §12)", () => {
  it("is NFKC, with every whitespace character one space and every invisible one dropped", () => {
    expect(normalizedText(" \uFF21\uFF24\uFF21\tLove\u0085lace\u2028x\u2029y ")).toBe(
      "ADA Love lace x y",
    );
    expect(normalizedText("Ada\u200B\u202E\u00AD\u3164\u2800\uFE0F Lovelace")).toBe("Ada Lovelace");
    expect(normalizedText("Ada\uD800")).toBe("Ada\uFFFD");
    expect(normalizedText("Zo\u200D\u00EB")).toBe("Zo\u200D\u00EB");
  });
});

describe("hasVisibleText", () => {
  it("is false for text that renders as nothing", () => {
    for (const blank of [
      "",
      " ",
      "\u200D",
      "\u200C \u200D",
      "\u3164",
      "\u2800",
      "\u034F",
      "\uFE0F",
      "\uFFFC",
      "\u0301",
      "\u115F\u1160\uFFA0",
      "\u202E\u200B\u0085",
    ])
      expect(hasVisibleText(blank), JSON.stringify(blank)).toBe(false);
  });

  it("is true for anything a reader sees", () => {
    for (const text of ["a", "\u00EB", "Zo\u200D\u00EB", "\u{1F600}", "\u0915\u094D", "\uFFFD"])
      expect(hasVisibleText(text), text).toBe(true);
  });
});

describe("withoutEmails (planner ruling R5, the fix-forward ruling)", () => {
  it("replaces addresses in every RFC local-part form, apostrophes and quotes included", () => {
    expect(withoutEmails("o'brien@example.com")).toBe("[email]");
    expect(withoutEmails('"ada.l"@example.com and "a b"@example.org')).toBe("[email] and [email]");
    expect(withoutEmails("ada(work)@example.com")).toBe("[email]");
    expect(withoutEmails("4242+bob-q7login@users.noreply.github.com")).toBe("[email]");
    expect(withoutEmails("49699333+dependabot[bot]@users.noreply.github.com")).toBe("[email]");
    expect(withoutEmails("'ada@example.com', <g.h@x.io> [k@x.io]")).toBe(
      "'[email]', <[email]> [[email]]",
    );
    expect(withoutEmails("\u00E5d\u00E5@example.com")).toBe("[email]");
  });

  it("replaces fullwidth and small at signs and dots, and addresses split by invisible characters", () => {
    for (const disguised of [
      "ada\uFF20example.com",
      "ada\uFE6Bexample.com",
      "ada@example\uFF0Ecom",
      "ada@example\u3002com",
      "ada\u200B@example.com",
      "ada@exa\u00ADmple.com",
      "ada@example\u0085.com",
      "ada@\u202Eexample.com",
      "ada@example.c\u2028om",
    ])
      expect(withoutEmails(`Fix for ${disguised}`), JSON.stringify(disguised)).toBe(
        "Fix for [email]",
      );
  });

  it("leaves paths and versions holding @ alone: no / in the local part, a TLD of letters", () => {
    for (const text of [
      "citation node_modules/@types/node/index.d.ts:1-4 does not match its hash",
      "pathspec 'vite@5.0.0'",
      "app/@modal/page.tsx",
      "Use @decorator and a@b",
      "root@buildbox",
      "https://[redacted]@github.com/acme/demo",
      "a@b.c",
      "[email]",
    ])
      expect(withoutEmails(text)).toBe(text);
    // An asset name shaped like an address is redacted: privacy first.
    expect(withoutEmails("packages/ui/src/icons@2x.png")).toBe("packages/ui/src/[email]");
  });

  it("changes nothing else in text that holds no address", () => {
    const text = "fix: signals \u202E\u2028 edge \uFF21 \u3164 ";
    expect(withoutEmails(text)).toBe(text);
  });

  it("is linear: an 80,000-character token takes under 100 ms", () => {
    for (const token of [
      "a".repeat(80_000),
      `${"a".repeat(80_000)}@`,
      `a@${"b".repeat(80_000)}`,
      `a@${"b.".repeat(40_000)}`,
      "'".repeat(80_000),
      "a@".repeat(40_000),
      `"${"a".repeat(80_000)}`,
      `${"\uFF21".repeat(80_000)}\uFF20`,
    ]) {
      const start = performance.now();
      withoutEmails(token);
      expect(performance.now() - start, token.slice(0, 4)).toBeLessThan(100);
    }
  });
});
