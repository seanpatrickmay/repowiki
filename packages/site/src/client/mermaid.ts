/// <reference lib="dom" />
// Renders <pre class="mermaid"> diagrams in the browser, redrawing them when the reader's color
// scheme changes. Mermaid is bundled with the site (no CDN) and only downloaded on pages that
// have a diagram.
const blocks = [...document.querySelectorAll<HTMLElement>("pre.mermaid")];
if (blocks.length > 0) {
  const { default: mermaid } = await import("mermaid");
  const sources = blocks.map((block) => block.textContent ?? "");
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const render = async (): Promise<void> => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark.matches ? "dark" : "neutral",
    });
    blocks.forEach((block, index) => {
      block.removeAttribute("data-processed");
      block.textContent = sources[index] ?? "";
    });
    await mermaid.run({ nodes: blocks });
  };
  await render();
  dark.addEventListener("change", () => void render());
}
