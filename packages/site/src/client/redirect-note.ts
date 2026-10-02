/// <reference lib="dom" />
// Shows "(Redirected from X)" under the title when a redirect page sent the reader here.

interface Name {
  textContent: string | null;
}
interface Note {
  hidden: boolean | string;
  append(...parts: (string | Name)[]): void;
}
/** The slice of `Document` this script uses, so a test can stand in for it. */
interface Host {
  getElementById(id: string): Note | null;
  createElement(tag: "b"): Name;
}

/**
 * The name comes from the query string, so it is untrusted: it is set as `textContent` and never
 * parsed as HTML.
 */
export function showRedirectNote(search: string, doc: Host): void {
  const from = new URLSearchParams(search).get("redirectedfrom");
  const note = doc.getElementById("redirected-from");
  if (from === null || from === "" || note === null) return;
  const name = doc.createElement("b");
  name.textContent = from;
  note.append("(Redirected from ", name, ")");
  note.hidden = false;
}

if (typeof document !== "undefined") showRedirectNote(window.location.search, document);
