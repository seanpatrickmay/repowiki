import { describe, expect, it } from "vitest";
import { showRedirectNote } from "./redirect-note.ts";

/** Just enough of a document to record how the name reaches the page. */
function fakeDocument(hasNote = true) {
  const bold = {
    textContent: null as string | null,
    set innerHTML(_html: string) {
      throw new Error("the redirect note must never use innerHTML");
    },
  };
  const note = {
    hidden: true,
    parts: [] as unknown[],
    append(...parts: unknown[]) {
      this.parts.push(...parts);
    },
    set innerHTML(_html: string) {
      throw new Error("the redirect note must never use innerHTML");
    },
  };
  const doc = {
    getElementById: (id: string) => (hasNote && id === "redirected-from" ? note : null),
    createElement: () => bold,
  };
  return { doc, note, bold };
}

describe("showRedirectNote", () => {
  it("names where the reader came from and reveals the note", () => {
    const { doc, note, bold } = fakeDocument();
    showRedirectNote("?redirectedfrom=Legacy%20signals", doc);
    expect(bold.textContent).toBe("Legacy signals");
    expect(note.parts).toEqual(["(Redirected from ", bold, ")"]);
    expect(note.hidden).toBe(false);
  });

  it("treats a hostile value as text, never as markup", () => {
    const { doc, note, bold } = fakeDocument();
    showRedirectNote("?redirectedfrom=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E", doc);
    expect(bold.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(note.parts).toEqual(["(Redirected from ", bold, ")"]);
  });

  it.each(["", "?", "?redirectedfrom=", "?other=1"])("leaves the note hidden for %j", (search) => {
    const { doc, note } = fakeDocument();
    showRedirectNote(search, doc);
    expect(note.hidden).toBe(true);
    expect(note.parts).toEqual([]);
  });

  it("does nothing on a page without the note", () => {
    const { doc, bold } = fakeDocument(false);
    showRedirectNote("?redirectedfrom=x", doc);
    expect(bold.textContent).toBeNull();
  });
});
