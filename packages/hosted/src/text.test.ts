import { describe, expect, it } from "vitest";
import { firstClause, plainWords } from "./text.ts";

describe("plainWords", () => {
  it("turns link tokens and Markdown into plain text within a limit", () => {
    expect(
      plainWords("The **[[ingest]]** step reads <script> files and [[wp:Unix|Unix]] pipes.", 200),
    ).toBe("The ingest step reads < script> files and Unix pipes.");
    expect(plainWords("one two three four", 9)).toBe("one two");
    expect(plainWords("# Title\n> quoted SIGNALS_TABLE", 200)).toBe("Title\nquoted SIGNALS_TABLE");
  });

  it("drops hidden characters and keeps at most three paragraphs", () => {
    expect(plainWords("a\u200Bb\u0007c\td", 200)).toBe("abc d");
    expect(plainWords("one\n\ntwo\n\nthree\n\nfour\n\nfive", 200)).toBe(
      "one\n\ntwo\n\nthree four five",
    );
  });
});

describe("firstClause (ADR-0012)", () => {
  it("cuts a lead at its last clause within the limit, as taglines are cut", () => {
    const lead =
      "The command-line interface parses every subcommand the tool offers, loads the configuration from disk, and starts a match between the two named bots.";
    const blurb = firstClause(lead, 140);
    expect(blurb).toBe(
      "The command-line interface parses every subcommand the tool offers, loads the configuration from disk",
    );
    expect(firstClause("Short and whole.", 140)).toBe("Short and whole");
  });
});
