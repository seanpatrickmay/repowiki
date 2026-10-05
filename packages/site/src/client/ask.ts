/// <reference lib="dom" />
// The Ask sidebar (spec v2 #4 §4, R21): opens from the header button, asks /api/ask when the
// page is served by pnpm wiki:serve, and otherwise routes the question to pages with the
// Pagefind index the site already ships. Answers are rendered by ask-render.ts as text only.
import type { AskResponse, AskStatus } from "@repowiki/core";
import {
  type AskDocument,
  type AskNode,
  guardProgress,
  guardResponse,
  progressText,
  type Route,
  renderAnswer,
  renderRoutes,
  sseReader,
} from "./ask-render.ts";

/** The slice of an element the client drives. */
export interface AskElement extends AskNode {
  hidden: boolean;
  value: string;
  focus(): void;
  getAttribute(name: string): string | null;
  replaceChildren(...nodes: (AskNode | string)[]): void;
  addEventListener(type: string, listener: (event: AskEvent) => void): void;
  querySelector(selector: string): AskElement | null;
}

export interface AskEvent {
  key?: string;
  preventDefault(): void;
}

/** The slice of `document` the client uses. */
export interface AskPageDocument extends AskDocument {
  createElement(tag: string): AskElement;
  getElementById(id: string): AskElement | null;
  querySelector(selector: string): AskElement | null;
  querySelectorAll(selector: string): ArrayLike<AskElement>;
  addEventListener(type: string, listener: (event: AskEvent) => void): void;
}

/** What fetch returns, as far as the client reads it. */
export interface AskFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel?(): Promise<void>;
    };
  } | null;
}

/** The slice of Pagefind's JS API the fallback uses (`/pagefind/pagefind.js`). */
export interface Pagefind {
  search(term: string): Promise<{
    results: {
      data(): Promise<{
        url: string;
        excerpt: string;
        meta?: { title?: string };
        sub_results?: { title: string; url: string; excerpt: string }[];
      }>;
    }[];
  } | null>;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** What the client touches, so a test can stand in for the browser. */
export interface AskEnv {
  document: AskPageDocument;
  location: { pathname: string };
  /** sessionStorage, which may be missing or throw (a private window, blocked site data). */
  storage(): StorageLike | null;
  fetch(
    url: string,
    init?: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
  ): Promise<AskFetchResponse>;
  pagefind(): Promise<Pagefind>;
  /** How long a question may take before the sidebar gives up on it; ASK_TIMEOUT_MS if unset. */
  askTimeoutMs?: number;
}

/** sessionStorage keys: the sidebar's open state, and the last answers. */
export const OPEN_KEY = "repowiki-ask-open";
export const ANSWERS_KEY = "repowiki-ask-answers";
/** The most answers kept for the tab (spec v2 #4 §2). */
export const KEPT_ANSWERS = 10;
/** The most pages the static fallback lists. */
export const ROUTES = 5;
export const PAGEFIND_URL = "/pagefind/pagefind.js";
/**
 * How long the sidebar waits for an answer, POST to last frame, before it cancels the stream and
 * routes the question: past the slowest bounded question (five turns).
 */
export const ASK_TIMEOUT_MS = 120_000;

/** Words too common to search for, removed before a question goes to Pagefind. */
const STOP_WORDS = new Set(
  "a an and are as at be by can do does for from has have how i in is it its me my of on or should that the this to was what when where which who why will with you".split(
    " ",
  ),
);

/** The page a reader is on, as the ask's page hint: a feature id, the About article, or null. */
export function pageHint(pathname: string): string | null {
  if (/^\/special\/about\/?$/.test(pathname)) return "special:about";
  return /^\/wiki\/([a-z0-9-]{1,64})(\/|$)/.exec(pathname)?.[1] ?? null;
}

/** The status endpoint's answer, or null when it is not one (a static host's 404 page). */
function guardStatus(value: unknown): AskStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const s = value as Record<string, unknown>;
  if (s.mode === "answer" && typeof s.questionUsd === "number") return s as AskStatus;
  if (s.mode === "routing" && ["no-key", "disabled", "budget"].includes(s.reason as string))
    return s as AskStatus;
  return null;
}

interface Kept {
  question: string;
  response: AskResponse;
}

/** Installs the sidebar and the /special/ask/ panel on the page (spec v2 #4 R21). */
export function installAsk(env: AskEnv): void {
  const { document } = env;
  const store = {
    get(key: string): string | null {
      try {
        return env.storage()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key: string, value: string): void {
      try {
        env.storage()?.setItem(key, value);
      } catch {
        // No storage: the sidebar works, it just forgets on the next page.
      }
    },
  };
  const kept = (): Kept[] => {
    try {
      const parsed: unknown = JSON.parse(store.get(ANSWERS_KEY) ?? "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((k) => {
        const response = guardResponse((k as Kept | null)?.response);
        const question = (k as Kept | null)?.question;
        return response === null || typeof question !== "string" ? [] : [{ question, response }];
      });
    } catch {
      return [];
    }
  };
  const keep = (entry: Kept) =>
    store.set(ANSWERS_KEY, JSON.stringify([...kept(), entry].slice(-KEPT_ANSWERS)));

  // The status is asked once per page; a probe that found no status is asked again next time.
  let status: Promise<AskStatus | null> | null = null;
  const probe = () => {
    if (status === null) {
      status = env
        .fetch("/api/ask/status")
        .then(async (response) => (response.ok ? guardStatus(await response.json()) : null))
        .catch(() => null);
    }
    const asked = status;
    void asked.then((found) => {
      if (found === null && status === asked) status = null;
    });
    return asked;
  };

  for (const panel of Array.from(document.querySelectorAll("[data-ask]"))) {
    const form = panel.querySelector("[data-ask-form]");
    const input = panel.querySelector("textarea");
    const live = panel.querySelector("[data-ask-live]");
    const result = panel.querySelector("[data-ask-result]");
    if (form === null || input === null || live === null || result === null) continue;
    let asking = false;

    const routes = async (question: string, why: string) => {
      live.textContent = why;
      const words = question
        .toLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((w) => w !== "" && !STOP_WORDS.has(w));
      if (words.length === 0) {
        result.replaceChildren();
        return;
      }
      try {
        const pagefind = await env.pagefind();
        const found = (await pagefind.search(words.join(" ")))?.results ?? [];
        const pages: Route[] = [];
        for (const hit of found.slice(0, ROUTES)) {
          const data = await hit.data();
          pages.push({
            title: data.meta?.title ?? data.url,
            url: data.url,
            excerpt: data.excerpt,
            sections: (data.sub_results ?? []).filter((s) => s.url !== data.url),
          });
        }
        if (pages.length === 0) {
          live.textContent = `${why} No page matches.`;
          result.replaceChildren();
        } else result.replaceChildren(renderRoutes(document, pages));
      } catch {
        live.textContent = `${why} The page search is not available here either.`;
        result.replaceChildren();
      }
    };

    const show = (question: string, response: AskResponse) => {
      const again = document.createElement("button");
      again.setAttribute("type", "button");
      again.className = "ask-again";
      again.textContent = "Ask again";
      again.addEventListener("click", () => void ask(question, true));
      result.replaceChildren(renderAnswer(document, response), again);
      live.textContent = "";
    };

    const ask = async (question: string, fresh: boolean) => {
      if (asking) return;
      asking = true;
      try {
        live.textContent = "Asking\u2026";
        result.replaceChildren();
        const served = await probe();
        if (served === null) {
          return await routes(
            question,
            "Answers need pnpm wiki:serve; here are the pages that match.",
          );
        }
        if (served.mode === "routing") {
          return await routes(
            question,
            served.reason === "budget"
              ? "This session's spending cap is reached; here are the pages that match."
              : "Answers are off on this server; here are the pages that match.",
          );
        }
        // One deadline for the whole answer: it aborts the POST and cancels the stream's reader.
        const controller = new AbortController();
        const expired = new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("timed out")));
        });
        expired.catch(() => {});
        const timer = setTimeout(() => controller.abort(), env.askTimeoutMs ?? ASK_TIMEOUT_MS);
        const tooLong = "The answer took too long; here are the pages that match.";
        let reader: ReturnType<NonNullable<AskFetchResponse["body"]>["getReader"]> | null = null;
        let answer: AskResponse | null = null;
        try {
          let response: AskFetchResponse;
          try {
            response = await Promise.race([
              env.fetch("/api/ask", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ question, page: pageHint(env.location.pathname), fresh }),
                signal: controller.signal,
              }),
              expired,
            ]);
          } catch {
            return await routes(
              question,
              controller.signal.aborted
                ? tooLong
                : "The server did not answer; here are the pages that match.",
            );
          }
          if (response.status === 429) {
            live.textContent = "Another question is being answered; ask again in a moment.";
            return;
          }
          if (!response.ok || response.body === null) {
            return await routes(
              question,
              "The question could not be answered; here are the pages that match.",
            );
          }
          reader = response.body.getReader();
          const decoder = new TextDecoder();
          const sse = sseReader();
          try {
            for (;;) {
              const { done, value } = await Promise.race([reader.read(), expired]);
              const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
              for (const frame of sse.feed(text)) {
                const data: unknown = JSON.parse(frame.data);
                if (frame.event === "status") {
                  const progress = guardProgress(data);
                  if (progress !== null) live.textContent = progressText(progress);
                } else if (frame.event === "answer") answer = guardResponse(data);
              }
              if (done || answer !== null) break;
            }
          } catch {
            answer = null;
          }
          if (answer === null) {
            return await routes(
              question,
              controller.signal.aborted
                ? tooLong
                : "The answer could not be shown; here are the pages that match.",
            );
          }
        } finally {
          clearTimeout(timer);
          // Release the connection whatever happened: answered, failed or timed out.
          reader?.cancel?.().catch(() => {});
        }
        show(question, answer);
        keep({ question, response: answer });
      } finally {
        asking = false;
      }
    };

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const question = input.value.trim();
      if (question !== "") void ask(question, false);
    });
    const last = kept().at(-1);
    if (last !== undefined) {
      input.value = last.question;
      show(last.question, last.response);
    }
  }

  const button = document.querySelector("[data-ask-open]");
  const sidebar = document.getElementById("ask-panel");
  if (button === null || sidebar === null) return;
  const setOpen = (open: boolean, focus: boolean) => {
    sidebar.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    store.set(OPEN_KEY, open ? "1" : "0");
    if (open) void probe();
    if (focus) (open ? (sidebar.querySelector("textarea") ?? sidebar) : button).focus();
  };
  button.hidden = false;
  button.addEventListener("click", () => setOpen(sidebar.hidden, true));
  sidebar.querySelector("[data-ask-close]")?.addEventListener("click", () => setOpen(false, true));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !sidebar.hidden) setOpen(false, true);
  });
  if (store.get(OPEN_KEY) === "1") setOpen(true, false);
}

if (typeof document !== "undefined") {
  installAsk({
    document: document as unknown as AskPageDocument,
    location: window.location,
    storage: () => window.sessionStorage,
    fetch: (url, init) => window.fetch(url, init) as Promise<AskFetchResponse>,
    pagefind: () => import(/* @vite-ignore */ PAGEFIND_URL) as Promise<Pagefind>,
  });
}
