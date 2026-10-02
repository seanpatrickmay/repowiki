import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeMermaidEntities, mermaidLabel } from "./mermaid-label.ts";

const SITE_FILE = new URL("../../../site/src/feature-map.ts", import.meta.url);

const HOSTILE = [
  "",
  "   ",
  "plain title",
  '"quoted" & <tagged> text',
  'line one\nclick n1 "javascript:alert(1)"\r\n\tline two',
  '%%{init: {"securityLevel":"loose"}}%%',
  "$$x^2$$",
  "$$x^$$",
  "ﬂ°°x3C¶ßimg src=x ﬂ°°x3E¶ß ﬂ°quot¶ß",
  'n1@{ img: "https://evil.example/x.png" }',
  "a; b # c #58; d",
  "‮rtl‬ ​zero width  ﻿",
  "nul\u0000 del\u007F nel\u0085",
  "lone \uD800 surrogate, private , unassigned ͸",
  "emoji 🙂 and 日本語 and naïve",
  "back`tick \\ slash | pipe [ ] { }",
  "a    lot   of   space   ",
  "end of #",
];

describe("the engine's copy of the site's mermaidLabel", () => {
  it("is character-for-character the same source as packages/site/src/feature-map.ts", () => {
    const block = (file: string) => {
      const start = file.indexOf("/** Characters that stay");
      const fn = file.indexOf("export function mermaidLabel");
      const end = file.indexOf("\n}\n", fn) + 3;
      return file.slice(start, end);
    };
    const site = block(readFileSync(SITE_FILE, "utf8"));
    const engine = block(readFileSync(new URL("./mermaid-label.ts", import.meta.url), "utf8"));
    expect(site).toContain("const NAMED_ENTITIES");
    expect(site.length).toBeGreaterThan(500);
    expect(engine).toBe(site);
  });

  it("writes the same label as the site's function for every hostile string", async () => {
    const site = (await import(SITE_FILE.href)) as { mermaidLabel: (text: string) => string };
    for (const text of HOSTILE)
      expect(mermaidLabel(text), JSON.stringify(text)).toBe(site.mermaidLabel(text));
  });
});

describe("decodeMermaidEntities", () => {
  it("decodes the named entities and decimal references", () => {
    expect(decodeMermaidEntities("a #quot;b#quot; #amp; #lt;#gt; #58;#40;")).toBe('a "b" & <> :(');
    expect(decodeMermaidEntities("plain")).toBe("plain");
  });

  it.each([
    ["a bare hash", "issue #12"],
    ["an unknown name", "a #nbsp; b"],
    ["a hex reference", "#x3C;"],
    ["an unterminated reference", "#58"],
    ["an empty reference", "#;"],
    ["a reference beyond Unicode", "#1114112;"],
    ["a huge reference", `#${"9".repeat(500)};`],
  ])("returns null for %s", (_name, label) => {
    expect(decodeMermaidEntities(label)).toBeNull();
  });

  it("round-trips everything mermaidLabel writes", () => {
    for (const text of HOSTILE) {
      const label = mermaidLabel(text);
      const decoded = decodeMermaidEntities(label);
      expect(decoded, JSON.stringify(text)).not.toBeNull();
      expect(mermaidLabel(decoded ?? ""), JSON.stringify(text)).toBe(label);
    }
  });
});
