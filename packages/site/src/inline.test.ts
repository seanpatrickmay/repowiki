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

describe("XSS regression tests", () => {
  it("escapes script tags in claim text", () => {
    const result = renderInline("<script>alert(1)</script>", known);
    expect(result).not.toContain("<script");
    expect(result).toContain("&lt;script&gt;");
  });

  it("escapes img tags with onerror in claim text", () => {
    const result = renderInline("<img src=x onerror=alert(1)>", known);
    expect(result).not.toContain("<img");
    expect(result).toContain("&lt;img");
    expect(result).toContain("&gt;");
  });

  it("escapes svg injection attempts in claim text", () => {
    const result = renderInline('"><svg onload=1>', known);
    expect(result).not.toContain("<svg");
    expect(result).toContain("&lt;svg");
    expect(result).toContain("&gt;");
  });

  it("escapes ampersand in claim text", () => {
    const result = renderInline("&amp;", known);
    expect(result).toContain("&amp;amp;");
  });

  it("escapes less-than in claim text", () => {
    const result = renderInline("&lt;", known);
    expect(result).toContain("&amp;lt;");
  });

  it("keeps markup escaped inside code blocks", () => {
    const result = renderInline("`<script>`", known);
    expect(result).toContain("<code>&lt;script&gt;</code>");
    expect(result).not.toContain("<script");
  });

  it("keeps markup escaped inside bold", () => {
    const result = renderInline("**<b>**", known);
    expect(result).toContain("<b>&lt;b&gt;</b>");
    expect(result).not.toMatch(/<b><b/);
  });

  it("keeps markup escaped inside italic", () => {
    const result = renderInline("*<i>*", known);
    expect(result).toContain("<i>&lt;i&gt;</i>");
    expect(result).not.toMatch(/<i><i/);
  });

  it("renders markup inside link labels", () => {
    const result = renderInline("[[deliverables|**b** `c` <i>]]", known);
    expect(result).toContain(
      '<a class="wikilink" href="/wiki/deliverables/" title="The &quot;Deliverables&quot;" data-preview="deliverables">**b** `c` &lt;i&gt;</a>',
    );
  });

  it("encodes malicious URLs in Wikipedia links", () => {
    const result = renderInline("[[wp:javascript:alert(1)]]", known);
    expect(result).toContain("https://en.wikipedia.org/wiki/javascript%3Aalert(1)");
    expect(result).toContain('href="https://en.wikipedia.org/wiki/javascript');
  });

  it("escapes javascript: protocol in unknown feature links", () => {
    const result = renderInline("[[javascript:alert(1)]]", known);
    expect(result).not.toContain("<a");
    expect(result).toBe("javascript:alert(1)");
  });

  it("percent-encodes quotes in Wikipedia links", () => {
    const result = renderInline('[[wp:x" onmouseover="alert(1)]]', known);
    expect(result).toContain('href="https://en.wikipedia.org/wiki/x%22_onmouseover%3D%22alert(1)"');
    expect(result).toContain('title="Wikipedia: x&quot; onmouseover=&quot;alert(1)"');
    expect(result).toContain(">x&quot; onmouseover=&quot;alert(1)</a>");
    expect(result).not.toContain('" onmouseover=');
  });

  it("percent-encodes special characters in Wikipedia links", () => {
    const result = renderInline("[[wp:../../w/index.php?x=1#y]]", known);
    const href = result.match(/href="([^"]+)"/)?.[1] ?? "";
    expect(href).toContain("%2F");
    expect(href).toContain("%3F");
    expect(href).toContain("%23");
  });

  it("escapes unknown feature links with malicious labels", () => {
    const result = renderInline("[[ghost|<img onerror=1>]]", known);
    expect(result).not.toContain("<img");
    expect(result).toContain("&lt;img");
  });

  it("renders lone surrogates in wp titles without throwing", () => {
    expect(() => renderInline("[[wp:\ud800]]", known)).not.toThrow();
    const result = renderInline("[[wp:\ud800]]", known);
    expect(result).toContain("https://en.wikipedia.org/wiki/");
    expect(result).not.toMatch(/javascript:|onerror|onload/);
  });

  it("keeps placeholder characters inert in claim text", () => {
    const result = renderInline(
      `text${String.fromCharCode(0xe000)}${String.fromCharCode(0xe001)}end`,
      known,
    );
    expect(result).toBe("textend");
  });

  it("keeps placeholder characters inert in feature titles", () => {
    const titleWithPlaceholder: InlineOptions = {
      link: (id) =>
        id === "test"
          ? {
              href: "/wiki/test/",
              title: `Title${String.fromCharCode(0xe000)}${String.fromCharCode(0xe001)}Text`,
            }
          : null,
    };
    const result = renderInline("[[test]]", titleWithPlaceholder);
    expect(result).toContain("TitleText");
    expect(result).not.toContain(String.fromCharCode(0xe000));
    expect(result).not.toContain(String.fromCharCode(0xe001));
  });
});

describe("empty labels and targets", () => {
  it("renders empty target as escaped token", () => {
    const result = renderInline("[[ ]]", known);
    expect(result).toContain("[[ ]]");
  });

  it("renders empty wp target as escaped token", () => {
    const result = renderInline("[[wp:]]", known);
    expect(result).toContain("[[wp:]]");
  });

  it("uses title when label is empty", () => {
    const result = renderInline("[[deliverables| ]]", known);
    expect(result).toContain("The &quot;Deliverables&quot;");
  });

  it("escapes HTML tags inside code blocks", () => {
    const result = renderInline("`<img src=x onerror=1>`", known);
    expect(result).toBe("<code>&lt;img src=x onerror=1&gt;</code>");
  });
});
