import { describe, expect, it } from "vitest";
import { mountSearch, type PagefindUIOptions } from "./search.ts";

/** A stand-in Pagefind UI that records how it was made and what it searched. */
function fakeUI() {
  const made: PagefindUIOptions[] = [];
  const searched: string[] = [];
  class UI {
    constructor(options: PagefindUIOptions) {
      made.push(options);
    }
    triggerSearch(term: string): void {
      searched.push(term);
    }
  }
  return { UI, made, searched };
}

describe("mountSearch", () => {
  it("loads the index from under the page's base and puts the base on result URLs", () => {
    const { UI, made, searched } = fakeUI();
    mountSearch(UI, { dataset: { base: "/wiki/demo/" } }, "?q=signals");
    expect(made).toEqual([
      {
        element: "#search",
        showSubResults: true,
        showImages: false,
        resetStyles: false,
        bundlePath: "/wiki/demo/pagefind/",
        baseUrl: "/wiki/demo/",
      },
    ]);
    expect(searched).toEqual(["signals"]);
  });

  it.each([undefined, "", "wiki/demo/", '/x"/', "/../"])(
    "uses the site's root for a page base of %j",
    (base) => {
      const { UI, made, searched } = fakeUI();
      mountSearch(UI, { dataset: { base } }, "?q=%20");
      expect(made[0]).toMatchObject({ bundlePath: "/pagefind/", baseUrl: "/" });
      expect(searched).toEqual([]);
    },
  );
});
