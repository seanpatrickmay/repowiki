// Just enough of a DOM for the Ask client's tests: elements with attributes, children, text,
// listeners and simple selector queries. Setting innerHTML throws, so a test proves it is never
// used. Test-only.

type Listener = (event: FakeEvent) => void;

export interface FakeEvent {
  type: string;
  target?: unknown;
  key?: string;
  defaultPrevented?: boolean;
  preventDefault(): void;
}

export const event = (type: string, extra: Partial<FakeEvent> = {}): FakeEvent => {
  const e: FakeEvent = {
    type,
    defaultPrevented: false,
    preventDefault() {
      e.defaultPrevented = true;
    },
    ...extra,
  };
  return e;
};

/** One compound selector: a tag, an #id, .classes and [attr] or [attr="value"] parts. */
function matches(element: FakeElement, selector: string): boolean {
  const parts = selector.match(/^[a-z]+|#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]/g) ?? [];
  if (parts.join("") !== selector) throw new Error(`unsupported selector ${selector}`);
  return parts.every((part) => {
    if (part.startsWith("#")) return element.id === part.slice(1);
    if (part.startsWith(".")) return element.className.split(/\s+/).includes(part.slice(1));
    if (part.startsWith("[")) {
      const [, name = "", value] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part) ?? [];
      return value === undefined
        ? element.attributes.has(name)
        : element.attributes.get(name) === value;
    }
    return element.tagName === part;
  });
}

export class FakeElement {
  readonly tagName: string;
  readonly ownerDocument: FakeDocument;
  children: (FakeElement | string)[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  className = "";
  value = "";

  constructor(document: FakeDocument, tag: string) {
    this.ownerDocument = document;
    this.tagName = tag;
  }

  get id(): string {
    return this.attributes.get("id") ?? "";
  }

  get hidden(): boolean {
    return this.attributes.has("hidden");
  }

  set hidden(value: boolean) {
    if (value) this.attributes.set("hidden", "");
    else this.attributes.delete("hidden");
  }

  get textContent(): string {
    return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
  }

  set textContent(text: string | null) {
    this.children = text === null || text === "" ? [] : [text];
  }

  set innerHTML(_html: string) {
    throw new Error(`${this.tagName}: the Ask client never sets innerHTML`);
  }

  append(...nodes: (FakeElement | string)[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: (FakeElement | string)[]): void {
    this.children = nodes;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** Runs this element's listeners for `e`, then its document's (as a bubbling event would). */
  dispatch(e: FakeEvent): FakeEvent {
    e.target ??= this;
    for (const listener of this.listeners.get(e.type) ?? []) listener(e);
    this.ownerDocument.dispatch(e);
    return e;
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  /** Every element below this one, depth first. */
  descendants(): FakeElement[] {
    return this.children.flatMap((c) => (typeof c === "string" ? [] : [c, ...c.descendants()]));
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter((e) => matches(e, selector));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

export class FakeDocument {
  readonly body: FakeElement;
  activeElement: FakeElement | null = null;
  readonly listeners = new Map<string, Listener[]>();

  constructor() {
    this.body = new FakeElement(this, "body");
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(this, tag);
  }

  /** An element with attributes and children, for building a page. */
  build(
    tag: string,
    attributes: Record<string, string> = {},
    ...children: (FakeElement | string)[]
  ): FakeElement {
    const element = this.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (name === "class") element.className = value;
      else element.setAttribute(name, value);
    }
    element.append(...children);
    return element;
  }

  getElementById(id: string): FakeElement | null {
    return this.body.querySelector(`#${id}`);
  }

  querySelector(selector: string): FakeElement | null {
    return this.body.querySelector(selector);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.body.querySelectorAll(selector);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatch(e: FakeEvent): FakeEvent {
    for (const listener of this.listeners.get(e.type) ?? []) listener(e);
    return e;
  }
}
