import { wikipediaUrl } from "./urls.ts";

export interface InlineOptions {
  /** Resolves a [[featureId]] token; null renders the label as plain text. */
  link(id: string): { href: string; title: string } | null;
  /** False renders every link token as its plain label (hover previews). Default true. */
  links?: boolean;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

const TOKEN = /`([^`]+)`|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
// Placeholders use private-use characters, built at runtime so no formatter rewrites them.
const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);
const PLACEHOLDER_CHARS = new RegExp(`[${OPEN}${CLOSE}]`, "g");
const SLOT = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");

/**
 * Renders claim text to HTML. Everything is escaped; the only markup produced is **bold**,
 * *italic*, `code`, [[featureId]] / [[featureId|label]] and [[wp:Title]] / [[wp:Title|label]].
 */
export function renderInline(text: string, options: InlineOptions): string {
  const slots: string[] = [];
  const hold = (html: string): string => `${OPEN}${slots.push(html) - 1}${CLOSE}`;
  const held = text
    .replace(PLACEHOLDER_CHARS, "")
    .replace(TOKEN, (_match, code: string | undefined, target = "", label?: string) =>
      hold(
        code !== undefined
          ? `<code>${escapeHtml(code)}</code>`
          : renderLink(target.trim(), label?.trim(), options),
      ),
    );
  return escapeHtml(held)
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "<b>$1</b>")
    .replace(/\*(?=\S)([^*]+?)(?<=\S)\*/g, "<i>$1</i>")
    .replace(SLOT, (_match, index: string) => slots[Number(index)] ?? "");
}

function renderLink(target: string, label: string | undefined, options: InlineOptions): string {
  const links = options.links !== false;
  if (target.startsWith("wp:")) {
    const title = target.slice(3).trim();
    const text = escapeHtml(label ?? title);
    if (!links || title === "") return text;
    return `<a class="external" href="${escapeHtml(wikipediaUrl(title))}" title="Wikipedia: ${escapeHtml(title)}">${text}</a>`;
  }
  const resolved = options.link(target);
  const text = escapeHtml(label ?? resolved?.title ?? target);
  if (!links || resolved === null) return text;
  // data-preview is read by the hover-preview script.
  return `<a class="wikilink" href="${escapeHtml(resolved.href)}" title="${escapeHtml(resolved.title)}" data-preview="${escapeHtml(target)}">${text}</a>`;
}
