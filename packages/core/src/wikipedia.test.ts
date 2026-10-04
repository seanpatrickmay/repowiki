import { describe, expect, it } from "vitest";
import { WIKIPEDIA_EXTRACT_MAX_LENGTH, WikipediaSummary } from "./wikipedia.ts";

const good = {
  title: "Message queue",
  extract: "A message queue is a form of asynchronous communication.",
  url: "https://en.wikipedia.org/wiki/Message_queue",
};

const accepts = (overrides: Partial<WikipediaSummary>): boolean =>
  WikipediaSummary.safeParse({ ...good, ...overrides }).success;

describe("WikipediaSummary url", () => {
  it.each(["https://en.wikipedia.org/wiki/Message_queue", "https://en.wikipedia.org/wiki/C%2B%2B"])(
    "accepts %s",
    (url) => {
      expect(accepts({ url })).toBe(true);
    },
  );

  it.each([
    "https://en.wikipedia.org.evil.com/wiki/X",
    "https://user@en.wikipedia.org/wiki/X",
    "https://user:pass@en.wikipedia.org/wiki/X",
    "https://en.wikipedia.org:444/wiki/X",
    "https://en.wikipedia.org:443/wiki/X",
    "http://en.wikipedia.org/wiki/X",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "https://evil.example/wiki/X",
    "https://fr.wikipedia.org/wiki/X",
    "https://EN.wikipedia.org/wiki/X",
    "https://en.wikipedia.org/w/index.php?title=X",
    "https://en.wikipedia.org/wiki/Cron#History",
    "https://en.wikipedia.org/wiki/Cron#",
    "https://en.wikipedia.org/wiki/Cron?action=raw",
    "https://en.wikipedia.org/wiki/Cron?",
    "https://en.wikipedia.org/wiki/",
    "https://en.wikipedia.org/wiki",
    "https://en.wikipedia.org\\wiki\\X",
    "https://en.wikipedia.org/wiki/X Y",
    'https://en.wikipedia.org/wiki/X"onmouseover="alert(1)',
    "https://en.wikipedia.org/wiki/<script>",
    "https://en.wikipedia.org/wiki/X\n",
    " https://en.wikipedia.org/wiki/X",
    "//en.wikipedia.org/wiki/X",
    "/wiki/X",
    "not a url",
    "",
  ])("rejects %j", (url) => {
    expect(accepts({ url })).toBe(false);
  });
});

describe("WikipediaSummary extract", () => {
  it("allows an empty extract and one of exactly the limit, counted in code points", () => {
    expect(accepts({ extract: "" })).toBe(true);
    expect(accepts({ extract: "x".repeat(WIKIPEDIA_EXTRACT_MAX_LENGTH) })).toBe(true);
    expect(accepts({ extract: "x".repeat(WIKIPEDIA_EXTRACT_MAX_LENGTH + 1) })).toBe(false);
    // Each of these is one code point but two UTF-16 units.
    expect(accepts({ extract: "\u{1F600}".repeat(WIKIPEDIA_EXTRACT_MAX_LENGTH) })).toBe(true);
    expect(accepts({ extract: "\u{1F600}".repeat(WIKIPEDIA_EXTRACT_MAX_LENGTH + 1) })).toBe(false);
  });

  it.each([
    ["a newline", "line one\nline two"],
    ["a tab", "a\tb"],
    ["NUL", "a\u0000b"],
    ["ESC", "a\u001bb"],
    ["DEL", "a\u007fb"],
    ["a C1 control", "a\u0085b"],
    ["a line separator", "a\u2028b"],
    ["a paragraph separator", "a\u2029b"],
    ["a right-to-left override", "a\u202eb"],
    ["a left-to-right embedding", "a\u202ab"],
    ["a pop directional formatting", "a\u202cb"],
    ["a right-to-left isolate", "a\u2067b"],
    ["a pop directional isolate", "a\u2069b"],
    ["a left-to-right mark", "a\u200eb"],
    ["a right-to-left mark", "a\u200fb"],
    ["an Arabic letter mark", "a\u061cb"],
    ["a tag character", "a" + String.fromCodePoint(0xe0041) + "b"],
    ["a word joiner", "a\u2060b"],
    ["an invisible operator", "a\u2062b"],
    ["a deprecated format character", "a\u206ab"],
    ["a byte order mark", "a\ufeffb"],
    ["a zero-width space", "a\u200bb"],
    ["a soft hyphen", "a\u00adb"],
  ])("refuses %s", (_name, extract) => {
    expect(accepts({ extract })).toBe(false);
  });

  it("keeps the zero-width joiner and non-joiner that spell real scripts", () => {
    expect(accepts({ extract: "\u0915\u094d" + "\u200d" + "\u0937" })).toBe(true);
    expect(accepts({ extract: "\u0645\u06cc" + "\u200c" + "\u062e\u0648\u0627\u0647\u0645" })).toBe(
      true,
    );
  });

  it("keeps ordinary non-ASCII text", () => {
    expect(accepts({ extract: "Café — naïve 日本語 مرحبا" })).toBe(true);
  });
});

describe("WikipediaSummary title", () => {
  it("is non-empty and free of control and bidi characters", () => {
    expect(accepts({ title: "" })).toBe(false);
    expect(accepts({ title: "A\u202eB" })).toBe(false);
    expect(accepts({ title: "A" + String.fromCodePoint(0xe0041) + "B" })).toBe(false);
    expect(accepts({ title: "A\u2060B" })).toBe(false);
    expect(accepts({ title: "A\u200dB" })).toBe(true);
    expect(accepts({ title: "A\nB" })).toBe(false);
  });
});
