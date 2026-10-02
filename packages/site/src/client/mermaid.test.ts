import { describe, expect, it } from "vitest";
import { installDiagrams, type MermaidApi } from "./mermaid.ts";

function fakeBlock(source: string) {
  const block = {
    textContent: source as string | null,
    attributes: new Set(["data-processed"]),
    removeAttribute: (name: string) => void block.attributes.delete(name),
  };
  return block;
}

/** A Mermaid that logs its calls; `run` waits for the test to release it. */
function fakeMermaid(options: { failRun?: (call: number) => boolean } = {}) {
  const log: string[] = [];
  const pending: (() => void)[] = [];
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const api: MermaidApi = {
    initialize: (config) => void log.push(`init ${config.securityLevel} ${config.theme}`),
    run: ({ nodes, suppressErrors }) => {
      const call = ++calls;
      log.push(
        `run ${call} suppress=${suppressErrors} ${nodes.map((n) => n.textContent).join("|")}`,
      );
      active++;
      maxActive = Math.max(maxActive, active);
      return new Promise<void>((resolve, reject) => {
        pending.push(() => {
          active--;
          if (options.failRun?.(call)) reject(new Error("bad diagram"));
          else resolve();
        });
      });
    },
  };
  return { api, log, pending, maxActive: () => maxActive };
}

function fakeScheme(matches: boolean) {
  const listeners: (() => void)[] = [];
  return {
    scheme: {
      matches,
      addEventListener: (_type: "change", listener: () => void) => void listeners.push(listener),
    } as unknown as Pick<MediaQueryList, "matches" | "addEventListener">,
    flip(next: boolean) {
      (this.scheme as { matches: boolean }).matches = next;
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("installDiagrams", () => {
  it("does not load Mermaid on a page without diagrams", async () => {
    let loaded = 0;
    const { scheme } = fakeScheme(false);
    await installDiagrams({
      blocks: [],
      colorScheme: scheme,
      loadMermaid: async () => {
        loaded++;
        return fakeMermaid().api;
      },
    });
    expect(loaded).toBe(0);
  });

  it("renders in strict mode with the reader's theme, and registers the listener first", async () => {
    const mermaid = fakeMermaid();
    const env = fakeScheme(true);
    const block = fakeBlock("flowchart LR\n  a --> b");
    const done = installDiagrams({
      blocks: [block as unknown as HTMLElement],
      colorScheme: env.scheme,
      loadMermaid: async () => mermaid.api,
    });
    expect(env.listeners).toHaveLength(1); // registered before the first render has run
    await tick();
    mermaid.pending.shift()?.();
    await done;
    expect(mermaid.log).toEqual([
      "init strict dark",
      "run 1 suppress=true flowchart LR\n  a --> b",
    ]);
    expect(block.attributes.has("data-processed")).toBe(false);
  });

  it("redraws from the saved source when the scheme changes, one render at a time", async () => {
    const mermaid = fakeMermaid();
    const env = fakeScheme(false);
    const block = fakeBlock("flowchart LR\n  a --> b");
    const done = installDiagrams({
      blocks: [block as unknown as HTMLElement],
      colorScheme: env.scheme,
      loadMermaid: async () => mermaid.api,
    });
    await tick();
    block.textContent = "<svg>drawn</svg>"; // what Mermaid leaves behind
    env.flip(true);
    env.flip(true); // a second change event while the first render is still running
    await tick();
    expect(mermaid.log.filter((line) => line.startsWith("run"))).toHaveLength(1);
    mermaid.pending.shift()?.();
    await done;
    await tick();
    expect(mermaid.log.filter((line) => line.startsWith("run"))).toHaveLength(2);
    mermaid.pending.shift()?.();
    await tick();
    mermaid.pending.shift()?.();
    await tick();
    expect(mermaid.maxActive()).toBe(1);
    expect(mermaid.log.filter((line) => line.startsWith("init"))).toEqual([
      "init strict neutral",
      "init strict dark",
      "init strict dark",
    ]);
    expect(mermaid.log.at(-1)).toBe("run 3 suppress=true flowchart LR\n  a --> b");
  });

  it("keeps redrawing after a render fails, and never rejects", async () => {
    const mermaid = fakeMermaid({ failRun: (call) => call === 1 });
    const env = fakeScheme(false);
    const done = installDiagrams({
      blocks: [fakeBlock("bad") as unknown as HTMLElement],
      colorScheme: env.scheme,
      loadMermaid: async () => mermaid.api,
    });
    await tick();
    mermaid.pending.shift()?.();
    await expect(done).resolves.toBeUndefined();
    env.flip(true);
    await tick();
    expect(mermaid.log.filter((line) => line.startsWith("run"))).toHaveLength(2);
  });

  it("survives a failed Mermaid download", async () => {
    const env = fakeScheme(false);
    await expect(
      installDiagrams({
        blocks: [fakeBlock("x") as unknown as HTMLElement],
        colorScheme: env.scheme,
        loadMermaid: () => Promise.reject(new Error("offline")),
      }),
    ).resolves.toBeUndefined();
  });
});
