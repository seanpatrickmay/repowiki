/// <reference lib="dom" />
// Renders <pre class="mermaid"> diagrams in the browser, redrawing them when the reader's color
// scheme changes. Mermaid is bundled with the site (no CDN) and only downloaded on pages that
// have a diagram.

/** The slice of Mermaid this script uses, so a test can stand in for it. */
export interface MermaidApi {
  initialize(config: {
    startOnLoad: boolean;
    securityLevel: "strict";
    theme: "dark" | "neutral";
  }): void;
  run(options: { nodes: HTMLElement[]; suppressErrors: boolean }): Promise<void>;
}

export interface DiagramEnv {
  blocks: HTMLElement[];
  colorScheme: Pick<MediaQueryList, "matches" | "addEventListener">;
  /** Downloads Mermaid. Called once, and only when the page has a diagram. */
  loadMermaid: () => Promise<MermaidApi>;
}

/** Resolves once the first render has finished or failed; it never rejects. */
export function installDiagrams({ blocks, colorScheme, loadMermaid }: DiagramEnv): Promise<void> {
  if (blocks.length === 0) return Promise.resolve();
  const sources = blocks.map((block) => block.textContent ?? "");
  const mermaid = loadMermaid();

  async function draw(): Promise<void> {
    const api = await mermaid;
    api.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: colorScheme.matches ? "dark" : "neutral",
    });
    blocks.forEach((block, index) => {
      block.removeAttribute("data-processed");
      block.textContent = sources[index] ?? "";
    });
    await api.run({ nodes: blocks, suppressErrors: true });
  }

  // Every render waits for the one before it, so two quick scheme flips never overlap, and a
  // failed render (a bad diagram, a failed download) never stops the next one.
  let queue: Promise<void> = Promise.resolve();
  const render = (): Promise<void> => {
    queue = queue.then(draw).catch(() => undefined);
    return queue;
  };

  colorScheme.addEventListener("change", () => void render());
  return render();
}

if (typeof document !== "undefined") {
  await installDiagrams({
    blocks: [...document.querySelectorAll<HTMLElement>("pre.mermaid")],
    colorScheme: window.matchMedia("(prefers-color-scheme: dark)"),
    loadMermaid: () => import("mermaid").then((module) => module.default),
  });
}
