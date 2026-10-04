import { describe, expect, it } from "vitest";
import { diagramProblems, MAX_DIAGRAM_CHARS, MAX_DIAGRAM_EDGES } from "./diagram.ts";
import { mermaidLabel } from "./mermaid-label.ts";

const SAFE = [
  "flowchart LR",
  '  n1["src/signals/ingest.py"]',
  '  n2[["Signal scoring #40;core#41;"]]',
  '  n1 -->|"calls click#40;#41; via href"| n2',
].join("\n");

describe("diagramProblems (the Mermaid safety control)", () => {
  it("accepts what the diagram builder writes, including words like click inside labels", () => {
    expect(diagramProblems(SAFE)).toEqual([]);
  });

  it.each([
    ["a click directive", '  click n1 "https://evil.example"'],
    ["a javascript: click directive", '  click n1 "javascript:alert(1)"'],
    ["an unindented javascript: click directive", 'click n1 "javascript:alert(1)"'],
    ["a call directive", "  click n1 call alert()"],
    ["an href directive", '  click n1 href "javascript:alert(1)"'],
    ["an init directive", "%%{init: {'securityLevel': 'loose'}}%%"],
    ["a loose-securityLevel init directive", '%%{init: {"securityLevel":"loose"}}%%'],
    ["an indented loose-securityLevel init directive", '  %%{init: {"securityLevel":"loose"}}%%'],
    ["a comment", "  %% hidden"],
    ["shape data with an image", '  n3@{ img: "https://evil.example/x.png", label: "x" }'],
    ["a style line", "  style n1 fill:#f00"],
    ["a class definition", "  classDef evil fill:url(https://evil.example)"],
    ["an unlabelled arrow", "  n1 --> n2"],
    ["a node and an arrow on one line", '  n1["a"] --> n2'],
    ["a node with trailing text", '  n3["a"] click n1'],
    ["a node indented by one space", ' n3["a"]'],
    ["a node indented by four spaces", '    n3["a"]'],
    ["a blank line", ""],
    ["an empty-id node", '  n["a"]'],
  ])("rejects %s", (_name, line) => {
    expect(diagramProblems(`${SAFE}\n${line}`)).toEqual([
      `diagram line 5 is not a node or a labelled arrow`,
    ]);
  });

  it.each([
    ["an img tag", '  n3["<img src=https://evil.example/x.png>"]'],
    ["a URL scheme", '  n3["javascript:alert(1)"]'],
    ["an img: shape", '  n3["img:https://evil.example"]'],
    ["a raw entity-free semicolon", '  n3["a; click n1"]'],
    ["a percent comment", '  n3["%%{init}%%"]'],
    ["shape-data braces", '  n3["@{ img }"]'],
    ["a raw double quote", '  n3["say "hi""]'],
    ["a quote that closes the label early", '  n3["a"] --> n2["b"]'],
    ["two nodes on one line", '  n3["a"]  n4["b"]'],
    ["a bare hash", '  n3["issue #12"]'],
    ["an unknown entity", '  n3["a #nbsp; b"]'],
    ["KaTeX math", '  n3["$$x^2$$"]'],
    ["malformed KaTeX math", '  n3["$$x^$$"]'],
    ["a raw dollar", '  n3["costs $5"]'],
    ["raw entity placeholder characters", '  n3["ﬂ°°x3C¶ßimg src=xﬂ°°x3E¶ß"]'],
    ["a raw degree sign", '  n3["ﬂ°quot¶ß"]'],
    ["a raw pilcrow and sharp s", '  n3["a¶ßb"]'],
    ["an entity for a right-to-left override", '  n3["a#8238;b"]'],
    ["an entity for NUL", '  n3["a#0;b"]'],
    ["an entity beyond Unicode", '  n3["a#1114112;b"]'],
    ["a hex entity", '  n3["a#x3C;b"]'],
    ["a padded numeric entity", '  n3["#065;"]'],
    ["a numeric entity for a quote", '  n3["a#34;b"]'],
    ["an empty label", '  n3[""]'],
    ["an all-space label", '  n3["   "]'],
    ["a double space", '  n3["a  b"]'],
    ["a leading space", '  n3[" a"]'],
    ["a trailing space", '  n3["a "]'],
    ["a raw ampersand", '  n3["a & b"]'],
    ["a raw apostrophe", `  n3["it's"]`],
    ["a raw parenthesis", '  n3["f(x)"]'],
  ])("rejects a node label holding %s", (_name, line) => {
    expect(diagramProblems(`${SAFE}\n${line}`)).toEqual([
      "diagram line 5: the label holds characters it may not",
    ]);
  });

  it("accepts #quot; and the other entities where a raw quote is refused", () => {
    expect(diagramProblems(`${SAFE}\n  n3["say #quot;hi#quot; #amp; #lt;b#gt; #58;"]`)).toEqual([]);
    expect(diagramProblems(`${SAFE}\n  n1 -->|"say #quot;hi#quot;"| n2`)).toEqual([]);
    expect(diagramProblems(`${SAFE}\n  n3["say "hi""]`)).toEqual([
      "diagram line 5: the label holds characters it may not",
    ]);
    expect(diagramProblems(`${SAFE}\n  n1 -->|"say "hi""| n2`)).toEqual([
      "diagram line 5: the label holds characters it may not",
    ]);
  });

  it("rejects an arrow label with a quote breakout or a URL", () => {
    const problems = diagramProblems(`${SAFE}\n  n1 -->|"x"| n2\n  n2 -->|"https://x"| n1`);
    expect(problems).toEqual(["diagram line 6: the label holds characters it may not"]);
    expect(diagramProblems(`${SAFE}\n  n1 -->|"a"| n2 -->|"b"| n1`)).toHaveLength(1);
  });

  it("rejects a missing header, a twice-declared node and an arrow to an undeclared node", () => {
    expect(diagramProblems('graph TD\n  n1["a"]')).toEqual([
      'the diagram must start with "flowchart LR"',
    ]);
    expect(diagramProblems(`${SAFE}\n  n1["again"]`)).toEqual([
      "diagram line 5: node n1 is declared twice",
    ]);
    expect(diagramProblems(`${SAFE}\n  n1 -->|"x"| n9`)).toEqual([
      "diagram line 5: an arrow must join two nodes declared above it",
    ]);
  });

  it("rejects an arrow whose source or target is undeclared or declared only later", () => {
    const arrowFirst = ["flowchart LR", '  n1 -->|"x"| n2', '  n1["a"]', '  n2["b"]'].join("\n");
    expect(diagramProblems(arrowFirst)).toEqual([
      "diagram line 2: an arrow must join two nodes declared above it",
    ]);
    expect(diagramProblems(`${SAFE}\n  n9 -->|"x"| n1`)).toEqual([
      "diagram line 5: an arrow must join two nodes declared above it",
    ]);
    expect(diagramProblems(`${SAFE}\n  n9 -->|"x"| n8`)).toEqual([
      "diagram line 5: an arrow must join two nodes declared above it",
    ]);
  });

  it.each([
    ["KaTeX math", "$$y$$"],
    ["malformed KaTeX math", "$$y^$$"],
    ["raw entity placeholder characters", "ﬂ°°x3C¶ßb"],
    ["an entity for a right-to-left override", "a#8238;b"],
    ["an entity for NUL", "a#0;b"],
    ["an empty label", ""],
    ["an all-space label", "  "],
  ])("rejects an arrow label holding %s", (_name, label) => {
    expect(diagramProblems(`${SAFE}\n  n1 -->|"${label}"| n2`)).toEqual([
      "diagram line 5: the label holds characters it may not",
    ]);
  });

  it("accepts every label the site's mermaidLabel writes, and nothing it would write differently", () => {
    for (const text of [
      "Signal ingestion",
      '"quoted" & <tagged>',
      "$$x^2$$",
      "ﬂ°°x3C¶ßimg",
      "a; b # c",
      "emoji 🙂 日本語 naïve",
      "back`tick \\ [x] {y} | z",
    ]) {
      const label = mermaidLabel(text);
      expect(diagramProblems(`${SAFE}\n  n3["${label}"]\n  n1 -->|"${label}"| n3`), text).toEqual(
        [],
      );
    }
  });

  it("rejects a node line whose brackets do not match", () => {
    expect(diagramProblems(`${SAFE}\n  n3[["a"]`)).toEqual(["diagram line 5: mismatched brackets"]);
    expect(diagramProblems(`${SAFE}\n  n3["a"]]`)).toEqual(["diagram line 5: mismatched brackets"]);
  });

  describe("size caps (Mermaid refuses a bigger diagram)", () => {
    it("allows exactly the limits", () => {
      const nodes = ['  n1["a"]', '  n2["b"]'];
      const edges = Array.from({ length: MAX_DIAGRAM_EDGES }, () => '  n1 -->|"x"| n2');
      expect(diagramProblems(["flowchart LR", ...nodes, ...edges].join("\n"))).toEqual([]);
    });

    it("rejects more than 500 arrows with one problem", () => {
      const nodes = ['  n1["a"]', '  n2["b"]'];
      const edges = Array.from({ length: MAX_DIAGRAM_EDGES + 1 }, () => '  n1 -->|"x"| n2');
      expect(diagramProblems(["flowchart LR", ...nodes, ...edges].join("\n"))).toEqual([
        `the diagram has more than ${MAX_DIAGRAM_EDGES} arrows`,
      ]);
    });

    it("rejects more than 50,000 characters with one problem, without parsing it", () => {
      const source = `${SAFE}\n  n3["${"a".repeat(MAX_DIAGRAM_CHARS)}"]`;
      expect(diagramProblems(source)).toEqual([
        `the diagram is longer than ${MAX_DIAGRAM_CHARS} characters`,
      ]);
      const atLimit = `${SAFE}\n  n3["${"a".repeat(MAX_DIAGRAM_CHARS - SAFE.length - 9)}"]`;
      expect(atLimit.length).toBe(MAX_DIAGRAM_CHARS);
      expect(diagramProblems(atLimit)).toEqual([]);
    });
  });

  describe("control and bidirectional characters", () => {
    const BAD = "diagram line 5 holds a control or bidirectional character";

    it("rejects a line with a trailing carriage return", () => {
      expect(diagramProblems(`${SAFE}\n  n1 -->|"x"| n2\r`)).toEqual([BAD]);
      expect(diagramProblems(`${SAFE}\n  n3["a"]\r`)).toEqual([BAD]);
    });

    it("rejects a CRLF source (the header line fails too)", () => {
      const problems = diagramProblems(SAFE.replaceAll("\n", "\r\n"));
      expect(problems).toContain('the diagram must start with "flowchart LR"');
      expect(problems.length).toBeGreaterThan(1);
    });

    it.each([
      ["a tab indent", '\tn3["a"]'],
      ["a tab inside a label", '  n3["a\tb"]'],
      ["a NUL", '  n3["a\u0000b"]'],
      ["a NUL after the node", '  n3["a"]\u0000'],
      ["a vertical tab", '  n3["a\u000Bb"]'],
      ["a form feed", '  n3["a\u000Cb"]'],
      ["an escape", '  n3["a\u001Bb"]'],
      ["DEL", '  n3["a\u007Fb"]'],
      ["a C1 control (NEL)", '  n3["a\u0085b"]'],
      ["a right-to-left override", '  n3["a‮b"]'],
      ["a right-to-left isolate", '  n3["a⁧b"]'],
      ["a left-to-right mark", '  n3["a‎b"]'],
      ["an Arabic letter mark", '  n3["a؜b"]'],
      ["a zero-width space", '  n3["a​b"]'],
      ["a byte-order mark", '﻿  n3["a"]'],
      ["a line separator", '  n3["a b"]'],
      ["a paragraph separator", '  n3["a b"]'],
      ["a lone surrogate", '  n3["a\uD800b"]'],
      ["a bidi control in an arrow label", '  n1 -->|"a‮b"| n2'],
      ["a bidi control between the arrow tokens", '  n1 -->‮|"a"| n2'],
    ])("rejects %s", (_name, line) => {
      expect(diagramProblems(`${SAFE}\n${line}`)).toEqual([BAD]);
    });

    it("rejects a control character in the header and still names the header", () => {
      expect(diagramProblems('flowchart LR\u0000\n  n1["a"]')).toEqual([
        'the diagram must start with "flowchart LR"',
      ]);
      expect(diagramProblems('flowchart LR‮\n  n1["a"]')).toEqual([
        'the diagram must start with "flowchart LR"',
      ]);
    });

    it("accepts ordinary non-ASCII letters in a label", () => {
      expect(diagramProblems(`${SAFE}\n  n3["src/naïve/日本.py"]`)).toEqual([]);
    });
  });
});
