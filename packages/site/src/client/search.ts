/// <reference lib="dom" />
// Mounts the Pagefind UI (written into /pagefind/ at build time) and runs the header query.

interface PagefindUIInstance {
  triggerSearch(term: string): void;
}

declare const PagefindUI: new (options: {
  element: string;
  showSubResults: boolean;
  showImages: boolean;
  resetStyles: boolean;
}) => PagefindUIInstance;

const ui = new PagefindUI({
  element: "#search",
  showSubResults: true,
  showImages: false,
  resetStyles: false,
});
const query = new URLSearchParams(window.location.search).get("q");
if (query !== null && query.trim() !== "") ui.triggerSearch(query);
