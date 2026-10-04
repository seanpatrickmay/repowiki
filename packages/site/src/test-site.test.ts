import { describe, expect, it } from "vitest";
import { offsiteCssUrls, offsiteResources } from "./test-site.ts";

describe("offsiteResources", () => {
  it.each([
    ["script src", '<script src="https://cdn.example/x.js"></script>'],
    ["uppercase SCRIPT SRC", '<SCRIPT SRC="https://cdn.example/x.js"></SCRIPT>'],
    ["single-quoted link href", "<link rel='stylesheet' href='//cdn.example/x.css'>"],
    ["unquoted src", "<img src=https://cdn.example/x.png>"],
    ["srcset", '<img src="/a.png" srcset="/a.png 1x, https://cdn.example/b.png 2x">'],
    ["video poster", '<video poster="http://cdn.example/p.jpg"></video>'],
    ["object data", '<object data="https://cdn.example/x.swf"></object>'],
    ["form action", '<form action="https://cdn.example/post"></form>'],
    ["svg xlink:href", '<svg><use xlink:href="https://cdn.example/i.svg#a"></use></svg>'],
    ["a '>' inside an earlier attribute", '<img alt="a > b" src="https://cdn.example/x.png">'],
    ["<abbr> is not an anchor", '<abbr href="https://cdn.example/">x</abbr>'],
    ["style element url()", "<style>.a { background: url(https://cdn.example/x.png) }</style>"],
    ["style element @import", '<style>@import "//cdn.example/x.css";</style>'],
    ["style attribute url()", "<p style=\"background:url('https://cdn.example/x.png')\">x</p>"],
    [
      "style attribute on an anchor",
      '<a href="/x" style="background:url(//cdn.example/x.png)">x</a>',
    ],
  ])("flags %s", (_name, html) => {
    expect(offsiteResources(html)).not.toEqual([]);
  });

  it.each([
    ["an outbound anchor", '<a href="https://x">x</a>'],
    ["an anchor with attributes first", '<a class="external" href="https://x">x</a>'],
    ["an uppercase anchor", '<A HREF="//x">x</A>'],
    ["an anchor with '>' in an attribute", '<a title="a > b" href="https://x">x</a>'],
    ["same-site resources", '<link rel="stylesheet" href="/_astro/a.css"><img src="/a.png">'],
    ["a data: favicon", '<link rel="icon" href="data:,">'],
    ["a relative style url()", "<style>.a { background: url(/a.png) }</style>"],
    ["text that only looks like a tag", '<p>write &lt;script src="https://x"&gt;</p>'],
  ])("does not flag %s", (_name, html) => {
    expect(offsiteResources(html)).toEqual([]);
  });
});

describe("offsiteCssUrls", () => {
  it("flags off-site url() and @import, and ignores same-site ones", () => {
    expect(offsiteCssUrls("a{background:url( 'https://x/y.png' )}")).not.toEqual([]);
    expect(offsiteCssUrls("@import 'https://x/y.css';")).not.toEqual([]);
    expect(offsiteCssUrls("@import url(//x/y.css);")).not.toEqual([]);
    expect(offsiteCssUrls("a{background:url(/a.png)} b{content:'https://x'}")).toEqual([]);
  });
});
