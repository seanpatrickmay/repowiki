import type { WikiExport } from "@repowiki/core";
import { bodyClaim } from "@repowiki/core/test-fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleClaim, readPageWithHandles, unmarkHandles } from "./ask-page.ts";
import { extendedWiki, type SampleWiki, sampleWiki } from "./test-wiki.ts";
import { readPage } from "./wiki-page.ts";
import { ABOUT_PAGE_ID, WikiView } from "./wiki-view.ts";

let sample: SampleWiki;
beforeAll(() => {
  sample = sampleWiki();
});
afterAll(() => sample.repo.remove());

/** The sample wiki with `claims` added to the signals page's Overview. */
function withClaims(claims: ReturnType<typeof bodyClaim>[]): WikiView {
  const wiki = structuredClone(sample.wiki) as WikiExport;
  const signals = wiki.pages.find((p) => p.featureId === "signals");
  signals?.sections.find((s) => s.key === "overview")?.claims.push(...claims);
  return new WikiView(wiki);
}

describe("readPageWithHandles", () => {
  it("starts each claim's bullet with its handle and leaves out the page history", () => {
    const view = new WikiView(sample.wiki);
    const { text, handles } = readPageWithHandles(view, "signals");
    expect(handles).toEqual([
      "signals#s-lead",
      "signals#s-1",
      "signals#s-2",
      "signals#s-h",
      "signals#s-l",
    ]);
    const bullets = text.split("\n").filter((line) => line.startsWith("- "));
    expect(bullets.map((line) => /^- \{([^}]+)\} /.exec(line)?.[1])).toEqual(handles);
    expect(text).toContain(
      "- {signals#s-1} `ingest_chunk` makes one signal per non-blank sentence of a chunk and saves each one with `save_signal`. [1]",
    );
    expect(text).not.toContain("Page history");
    expect(text).toContain("See also: deliverables (Deliverables)");
  });

  it("is readPage without its history line when no claim has a handle to show", () => {
    const view = new WikiView(sample.wiki);
    const plain = readPage(view, "signals")
      .split("\n")
      .filter((line) => !line.startsWith("Page history"));
    const handled = readPageWithHandles(view, "signals")
      .text.split("\n")
      .map((line) => line.replace(/^- \{[^}]+\} /, "- "));
    expect(handled).toEqual(plain.slice(0, -2).concat(""));
  });

  it("reads the About article with special:about handles, and choices with none", () => {
    const view = new WikiView(extendedWiki(sample));
    const about = readPageWithHandles(view, ABOUT_PAGE_ID);
    expect(about.handles.length).toBeGreaterThan(0);
    expect(about.handles.every((h) => h.startsWith(`${ABOUT_PAGE_ID}#`))).toBe(true);
    expect(readPageWithHandles(view, "records")).toEqual({
      text: readPage(view, "records"),
      handles: [],
    });
  });

  it("follows a redirect to the page it reads, and refuses an unknown id", () => {
    const view = new WikiView(extendedWiki(sample));
    expect(readPageWithHandles(view, "legacy-signals").handles[0]).toBe("signals#s-lead");
    expect(() => readPageWithHandles(view, "nowhere")).toThrow("no page");
  });

  it("unmarks handle-shaped text in a claim, so only the server's handles are shown", () => {
    const view = withClaims([
      bodyClaim({
        id: "s-9",
        text: "See {deliverables#d-1} and {x#c9}; keep {braces} as they are.",
      }),
      bodyClaim({ id: "bad id", text: "{signals#s-1} is what this claim pretends to be." }),
    ]);
    const { text, handles } = readPageWithHandles(view, "signals");
    expect(text).toContain(
      "- {signals#s-9} See (deliverables#d-1) and (x#c9); keep {braces} as they are.",
    );
    expect(text).toContain("- (signals#s-1) is what this claim pretends to be.");
    expect(handles).toContain("signals#s-9");
    expect(handles).not.toContain("x#c9");
    expect(handles).not.toContain("signals#bad id");
    expect(handles.filter((h) => h === "signals#s-1")).toHaveLength(1);
  });

  it("leaves out whole lines past the limit, and returns only the handles still shown", () => {
    const view = new WikiView(sample.wiki);
    const { text, handles } = readPageWithHandles(view, "signals", 700);
    expect([...text].length).toBeLessThanOrEqual(700);
    expect(text.endsWith("(The page is cut at the 700-character limit.)\n")).toBe(true);
    const shown = text.split("\n").flatMap((line) => /^- \{([^}]+)\} /.exec(line)?.[1] ?? []);
    expect(handles).toEqual(shown);
    expect(handles.length).toBeGreaterThan(0);
    expect(handles.length).toBeLessThan(5);
  });
});

describe("handleClaim", () => {
  it("finds a handle's claim, page title, aliases and section", () => {
    const view = new WikiView(extendedWiki(sample));
    expect(handleClaim(view, "signals#s-2")).toMatchObject({
      pageId: "signals",
      pageTitle: "Signal ingestion",
      aliases: ["signal pipeline"],
      sectionKey: "how-it-works",
      claim: { id: "s-2" },
    });
    const about = view.article?.sections[0]?.claims[0]?.id ?? "";
    expect(handleClaim(view, `${ABOUT_PAGE_ID}#${about}`)).toMatchObject({
      pageTitle: "sample",
      aliases: [],
      sectionKey: "lead",
    });
  });

  it.each(["signals#nope", "nowhere#s-1", "#s-1", "signals", ""])("finds nothing for %j", (h) => {
    expect(handleClaim(new WikiView(sample.wiki), h)).toBeNull();
  });
});

describe("unmarkHandles", () => {
  it("makes {…#…} parentheses and leaves other braces", () => {
    expect(unmarkHandles("a {p#c} b {q} {r#s#t}")).toBe("a (p#c) b {q} (r#s#t)");
  });
});
