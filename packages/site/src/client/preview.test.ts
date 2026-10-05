import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPreviews, type PreviewEnv } from "./preview.ts";

interface FakeLink {
  dataset: { preview: string };
  attributes: Map<string, string>;
  getBoundingClientRect(): { left: number; bottom: number };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  closest(selector: string): FakeLink | null;
}

function fakeLink(id: string): FakeLink {
  const link: FakeLink = {
    dataset: { preview: id },
    attributes: new Map(),
    getBoundingClientRect: () => ({ left: 40, bottom: 100 }),
    setAttribute: (name, value) => void link.attributes.set(name, value),
    removeAttribute: (name) => void link.attributes.delete(name),
    closest: (selector) => (selector === "a[data-preview]" ? link : null),
  };
  return link;
}

/** An element whose `innerHTML` can be allowed or must never be touched. */
function fakeElement(tag: string, allowInnerHtml = false) {
  const element = {
    tag,
    className: "",
    id: "",
    hidden: false,
    href: "",
    textContent: null as string | null,
    innerHtml: null as string | null,
    children: [] as unknown[],
    style: {} as Record<string, string>,
    attributes: new Map<string, string>(),
    setAttribute: (name: string, value: string) => void element.attributes.set(name, value),
    replaceChildren: (...nodes: unknown[]) => {
      element.children = nodes;
    },
    append: (...nodes: unknown[]) => void element.children.push(...nodes),
    contains: (node: unknown) => node === element,
    set innerHTML(html: string) {
      if (!allowInnerHtml) throw new Error(`${tag}: innerHTML is for site-built html only`);
      element.innerHtml = html;
    },
  };
  return element;
}

type Handler = (event: { target: unknown; key?: string }) => void;
type FakeElement = ReturnType<typeof fakeElement>;

function setup(options: { hover?: boolean; response?: (url: string) => Promise<unknown> } = {}) {
  const handlers = new Map<string, Handler>();
  const created: FakeElement[] = [];
  const body = fakeElement("body");
  const fetched: string[] = [];
  const doc = {
    body,
    documentElement: { clientWidth: 1000 },
    createElement: (tag: string) => {
      // The card and the preview body take site-built html; the title link must not.
      const element = fakeElement(tag, tag === "div");
      created.push(element);
      return element;
    },
    addEventListener: (type: string, handler: Handler) => void handlers.set(type, handler),
  };
  const win = {
    scrollX: 0,
    scrollY: 500,
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
    matchMedia: () => ({ matches: options.hover !== false }),
  };
  const fetchFake = vi.fn(async (url: string) => {
    fetched.push(url);
    return (
      (await options.response?.(url)) ?? {
        ok: true,
        json: async () => ({
          title: "<img src=x onerror=alert(1)> Title",
          url: "/wiki/deliverables/",
          html: "<p><b>Deliverables</b> are records.</p>",
        }),
      }
    );
  });
  installPreviews({ document: doc, window: win, fetch: fetchFake } as unknown as PreviewEnv);
  const card = created[0] as FakeElement;
  const fire = (type: string, target: unknown, key?: string) =>
    handlers.get(type)?.({ target, key });
  return { card, body, fetched, fire, fetchFake };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("installPreviews", () => {
  it("adds a hidden tooltip card to the page", () => {
    const { card, body } = setup();
    expect(card.id).toBe("preview-card");
    expect(card.className).toBe("preview-card");
    expect(card.attributes.get("role")).toBe("tooltip");
    expect(card.hidden).toBe(true);
    expect(body.children).toEqual([card]);
  });

  it("shows the card after a hover delay, with the title as text and the lead as html", async () => {
    const { card, fire, fetched } = setup();
    const link = fakeLink("deliverables");
    fire("mouseover", link);
    await vi.advanceTimersByTimeAsync(299);
    expect(card.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetched).toEqual(["/api/preview/deliverables.json"]);
    expect(card.hidden).toBe(false);
    const [title, text] = card.children as FakeElement[];
    // A title that looks like markup is text; the throwing setter proves it is never parsed.
    expect(title?.tag).toBe("a");
    expect(title?.textContent).toBe("<img src=x onerror=alert(1)> Title");
    expect(title?.href).toBe("/wiki/deliverables/");
    expect(text?.innerHtml).toBe("<p><b>Deliverables</b> are records.</p>");
    expect(link.attributes.get("aria-describedby")).toBe("preview-card");
    expect(card.style).toMatchObject({ width: "352px", left: "40px", top: "606px" });
  });

  it("shows on keyboard focus at once, and Escape hides it", async () => {
    const { card, fire } = setup({ hover: false });
    const link = fakeLink("signals");
    fire("focusin", link);
    await vi.advanceTimersByTimeAsync(0);
    expect(card.hidden).toBe(false);
    fire("keydown", null, "Escape");
    expect(card.hidden).toBe(true);
    expect(link.attributes.has("aria-describedby")).toBe(false);
  });

  it("ignores other keys", async () => {
    const { card, fire } = setup();
    fire("focusin", fakeLink("signals"));
    await vi.advanceTimersByTimeAsync(0);
    fire("keydown", null, "Tab");
    expect(card.hidden).toBe(false);
  });

  it("does not listen for hover on devices without a fine pointer", async () => {
    const { card, fire, fetched } = setup({ hover: false });
    fire("mouseover", fakeLink("signals"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetched).toEqual([]);
    expect(card.hidden).toBe(true);
  });

  it("hides shortly after the pointer leaves, unless it moves onto the card", async () => {
    const { card, fire } = setup();
    const link = fakeLink("signals");
    fire("mouseover", link);
    await vi.advanceTimersByTimeAsync(300);
    fire("mouseout", link);
    fire("mouseover", card);
    await vi.advanceTimersByTimeAsync(1000);
    expect(card.hidden).toBe(false);
    fire("mouseout", card);
    await vi.advanceTimersByTimeAsync(250);
    expect(card.hidden).toBe(true);
  });

  it("does not show a card for a link the reader has already left", async () => {
    let finish: (value: unknown) => void = () => {};
    const slow = new Promise((resolve) => {
      finish = resolve;
    });
    const { card, fire } = setup({ response: () => slow });
    fire("mouseover", fakeLink("signals"));
    await vi.advanceTimersByTimeAsync(300);
    fire("keydown", null, "Escape");
    finish({
      ok: true,
      json: async () => ({ title: "T", url: "/wiki/signals/", html: "<p>x</p>" }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(card.hidden).toBe(true);
    expect(card.children).toEqual([]);
  });

  it("hides shortly after keyboard focus leaves the link", async () => {
    const { card, fire } = setup({ hover: false });
    const link = fakeLink("signals");
    fire("focusin", link);
    await vi.advanceTimersByTimeAsync(0);
    expect(card.hidden).toBe(false);
    fire("focusout", link);
    await vi.advanceTimersByTimeAsync(249);
    expect(card.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(card.hidden).toBe(true);
    expect(link.attributes.has("aria-describedby")).toBe(false);
  });

  it("shows only the link the reader is on when an earlier fetch resolves late", async () => {
    let finishA: (value: unknown) => void = () => {};
    const slowA = new Promise((resolve) => {
      finishA = resolve;
    });
    const reply = (title: string) => ({
      ok: true,
      json: async () => ({ title, url: `/wiki/${title}/`, html: `<p>${title}</p>` }),
    });
    const { card, fire } = setup({
      response: (url) => (url.includes("/a.json") ? slowA : Promise.resolve(reply("b"))),
    });
    const linkA = fakeLink("a");
    const linkB = fakeLink("b");
    fire("mouseover", linkA);
    await vi.advanceTimersByTimeAsync(300);
    fire("mouseover", linkB);
    await vi.advanceTimersByTimeAsync(300);
    expect((card.children as FakeElement[])[0]?.textContent).toBe("b");
    finishA(reply("a"));
    await vi.advanceTimersByTimeAsync(0);
    const [title, text] = card.children as FakeElement[];
    expect(title?.textContent).toBe("b");
    expect(text?.innerHtml).toBe("<p>b</p>");
    expect(linkA.attributes.has("aria-describedby")).toBe(false);
    expect(linkB.attributes.get("aria-describedby")).toBe("preview-card");
  });

  it("fetches each id once", async () => {
    const { fire, fetchFake } = setup();
    const link = fakeLink("signals");
    for (let i = 0; i < 2; i++) {
      fire("mouseover", link);
      await vi.advanceTimersByTimeAsync(300);
      fire("keydown", null, "Escape");
    }
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });

  it("percent-encodes the id and stays on the same origin", async () => {
    const { fire, fetched } = setup();
    fire("focusin", fakeLink("a/../b?c#d e"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetched).toEqual(["/api/preview/a%2F..%2Fb%3Fc%23d%20e.json"]);
    expect(fetched[0]?.startsWith("/api/preview/")).toBe(true);
  });

  it("fetches a Wikipedia preview from its own folder, by the hash after wp:", async () => {
    const { card, fire, fetched } = setup();
    fire("focusin", fakeLink("wp:0123abcd"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetched).toEqual(["/api/preview/wp/0123abcd.json"]);
    expect(card.hidden).toBe(false);
  });

  it("percent-encodes a Wikipedia id too, and never leaves the same origin", async () => {
    const { fire, fetched } = setup();
    fire("focusin", fakeLink("wp:../x?y#z"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetched).toEqual(["/api/preview/wp/..%2Fx%3Fy%23z.json"]);
  });

  it("does not fetch for an empty id", async () => {
    const { card, fire, fetched } = setup();
    fire("focusin", fakeLink(""));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetched).toEqual([]);
    expect(card.hidden).toBe(true);
  });

  it.each([
    ["an error response", async () => ({ ok: false, json: async () => ({}) })],
    ["a missing preview", async () => ({ ok: true, json: async () => null })],
    [
      "a network failure",
      async () => {
        throw new Error("offline");
      },
    ],
  ])("shows nothing for %s", async (_name, response) => {
    const { card, fire } = setup({ response });
    fire("focusin", fakeLink("signals"));
    await vi.advanceTimersByTimeAsync(0);
    expect(card.hidden).toBe(true);
    expect(card.children).toEqual([]);
  });
});
