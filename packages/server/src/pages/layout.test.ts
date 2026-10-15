import { describe, expect, it } from "vitest";
import { escapeHtml, page } from "./layout.ts";

describe("pages (spec 2 §10)", () => {
  it("escape every HTML-significant character", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });

  it("wrap a body in the layout with an escaped title and the sign-out form when signed in", () => {
    const signedOut = page({ title: "<Home>", body: "<p>hi</p>", session: null });
    expect(signedOut).toContain("<title>&lt;Home&gt; · RepoWiki</title>");
    expect(signedOut).toContain("<p>hi</p>");
    expect(signedOut).toContain('href="/auth/github"');
    expect(signedOut).not.toContain("/auth/signout");
    const signedIn = page({ title: "x", body: "", session: { csrf: "c&t", login: "<sean>" } });
    expect(signedIn).toContain('action="/auth/signout"');
    expect(signedIn).toContain('value="c&amp;t"');
    expect(signedIn).toContain("&lt;sean&gt;");
  });

  it("link the style sheet rather than inline it, so the strict CSP holds (spec 2 S2)", () => {
    const html = page({ title: "x", body: "", session: null });
    expect(html).toContain('<link rel="stylesheet" href="/_app/style.css">');
    expect(html).not.toMatch(/<style|style=|<script/);
  });
});
