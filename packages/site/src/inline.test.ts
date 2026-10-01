import { describe, expect, it } from "vitest";
import { escapeHtml, type InlineOptions, renderInline } from "./inline.ts";

const known: InlineOptions = {
  link: (id) =>
    id === "deliverables" ? { href: "/wiki/deliverables/", title: 'The "Deliverables"' } : null,
};

describe("renderInline", () => {
  it("escapes raw HTML in claim text", () => {
    expect(renderInline("a <b>bold</b> & 'quoted' claim", known)).toBe(
      "a &lt;b&gt;bold&lt;/b&gt; &amp; &#39;quoted&#39; claim",
    );
  });

  it("renders bold, italic and code, keeping code literal", () => {
    expect(renderInline("**Signals** are *scored* by `a*b*c <x>`.", known)).toBe(
      "<b>Signals</b> are <i>scored</i> by <code>a*b*c &lt;x&gt;</code>.",
    );
  });

  it("leaves lone and spaced asterisks alone", () => {
    expect(renderInline("2 * 3 * 4 and a*", known)).toBe("2 * 3 * 4 and a*");
  });

  it("links known features with their title, an optional label and a preview id", () => {
    expect(renderInline("See [[deliverables]] and [[ deliverables | records ]].", known)).toBe(
      'See <a class="wikilink" href="/wiki/deliverables/" title="The &quot;Deliverables&quot;" data-preview="deliverables">The &quot;Deliverables&quot;</a>' +
        ' and <a class="wikilink" href="/wiki/deliverables/" title="The &quot;Deliverables&quot;" data-preview="deliverables">records</a>.',
    );
  });

  it("renders unknown features as plain text", () => {
    expect(renderInline("[[ghost]] and [[ghost|<the old one>]]", known)).toBe(
      "ghost and &lt;the old one&gt;",
    );
  });

  it("links Wikipedia titles with underscores and percent-encoding", () => {
    expect(renderInline("[[wp:Exponential backoff]] [[wp:C++ (language)|C++]]", known)).toBe(
      '<a class="external" href="https://en.wikipedia.org/wiki/Exponential_backoff" title="Wikipedia: Exponential backoff">Exponential backoff</a> ' +
        '<a class="external" href="https://en.wikipedia.org/wiki/C%2B%2B_(language)" title="Wikipedia: C++ (language)">C++</a>',
    );
  });

  it("renders labels only when links are off", () => {
    expect(
      renderInline("**[[deliverables|records]]** via [[wp:Backoff]]", { ...known, links: false }),
    ).toBe("<b>records</b> via Backoff");
  });

  it("ignores placeholder characters smuggled into the text", () => {
    expect(
      renderInline(`x${String.fromCharCode(0xe000)}0${String.fromCharCode(0xe001)}y \`z\``, known),
    ).toBe("x0y <code>z</code>");
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML-special characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });
});
