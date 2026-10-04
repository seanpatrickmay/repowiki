import { makeFeature, makeRevision } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  createPageLinker,
  createTargetResolver,
  linkTokensIn,
  normalizeWikipediaTitle,
  unlinkText,
  wikipediaTitlesIn,
} from "./links.ts";
import { linkManifest } from "./test-manifest.ts";
import { linksWithoutPage, linkViolations } from "./violations.ts";

const NO_WP = new Map<string, string | null>();

describe("createTargetResolver", () => {
  const resolve = createTargetResolver(linkManifest());
  it.each([
    ["deliverables", "deliverables"],
    ["Deliverable Records", "deliverables"],
    [" signal pipeline ", "signals"],
    ["legacy-signals", "signals"],
    ["Legacy signals", "signals"],
    ["retired-thing", null],
    ["nowhere", null],
  ])("resolves %j to %j", (target, id) => {
    expect(resolve(target)?.id ?? null).toBe(id);
  });
});

describe("createPageLinker", () => {
  it("links each feature on its first mention on the page only, across claims", () => {
    const link = createPageLinker(linkManifest(), "signals", NO_WP);
    expect(link("Stored as [[deliverables]] and [[deliverables|records]].")).toBe(
      "Stored as [[deliverables]] and records.",
    );
    expect(link("See [[deliverable records]] again.")).toBe("See deliverable records again.");
  });

  it("canonicalizes titles and aliases to ids and keeps the reader's words", () => {
    const link = createPageLinker(linkManifest(), "signals", NO_WP);
    expect(link("Bills go to [[invoices]]; also [[Deliverables|the CRUD layer]].")).toBe(
      "Bills go to [[billing|invoices]]; also [[deliverables|the CRUD layer]].",
    );
  });

  it("follows redirects to the final feature", () => {
    const link = createPageLinker(linkManifest(), "billing", NO_WP);
    expect(link("Uses [[legacy-signals]].")).toBe("Uses [[signals|Legacy signals]].");
  });

  it("turns unknown, retired and self links into their words (spec §7.3)", () => {
    const link = createPageLinker(linkManifest(), "signals", NO_WP);
    expect(link("[[nowhere]], [[retired-thing|old]], [[signals]], [[Signal ingestion|it]].")).toBe(
      "nowhere, old, Signal ingestion, it.",
    );
  });

  it("leaves tokens inside code spans alone", () => {
    const link = createPageLinker(linkManifest(), "signals", NO_WP);
    expect(link("Write `[[billing]]` to link [[billing]].")).toBe(
      "Write `[[billing]]` to link [[billing]].",
    );
  });

  it("links a Wikipedia title that checked out, once, under its canonical title", () => {
    const wp = new Map<string, string | null>([
      ["Message queue", "Message queue"],
      ["Message queues", "Message queue"],
      ["Made-up thing", null],
    ]);
    const link = createPageLinker(linkManifest(), "signals", wp);
    expect(link("A [[wp:message queue]] and [[wp:Message_queues|queues]].")).toBe(
      "A [[wp:Message queue|message queue]] and queues.",
    );
    expect(link("[[wp:Made-up thing]] and [[wp:Unchecked]].")).toBe("Made-up thing and Unchecked.");
  });
});

describe("Wikipedia titles", () => {
  it("normalizes like Wikipedia: underscores, spaces, first letter", () => {
    expect(normalizeWikipediaTitle("  message_queue  telemetry ")).toBe("Message queue telemetry");
    expect(normalizeWikipediaTitle(" ")).toBe("");
  });

  it("finds every wp title outside code spans", () => {
    expect(
      wikipediaTitlesIn("[[wp:Cron]] `[[wp:Not this]]` [[wp:message_queue|q]] [[billing]]"),
    ).toEqual(["Cron", "Message queue"]);
  });
});

// The M5 site (packages/site/src/inline.ts) reads claim text with one left-to-right pass over
// `code` | [[target]] | [[target|label]]. Whatever it would render as a link, the linker must see.
const SITE_TOKEN = /`([^`]+)`|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

describe("crafted claim text (the site's parser is the contract)", () => {
  const WP = new Map<string, string | null>([["Cron", "Cron"]]);
  const linker = (wp = NO_WP) => createPageLinker(linkManifest(), "signals", wp);

  it.each([
    ["[[../../etc]]", "../../etc"],
    ["[[javascript:alert(1)]]", "javascript:alert(1)"],
    ["[[wp:javascript:alert(1)]]", "javascript:alert(1)"],
    ["[[ghost|<img onerror=1>]]", "<img onerror=1>"],
  ])("turns %j into plain words", (text, words) => {
    expect(linker()(text)).toBe(words);
  });

  it("ends a label at the first ] (the site's label is [^\\]]+), never inside a token", () => {
    expect(linker()("[[billing|a]]b]]")).toBe("[[billing|a]]b]]");
    expect(linker()("[[ghost|a]]b]]")).toBe("ab]]");
    expect(linker()("[[billing|a]b]]")).toBe("[[billing|a]b]]");
    expect(linker()("[[billing|a|b]]")).toBe("[[billing|a|b]]");
  });

  it("neutralises nested brackets so the output holds no new token", () => {
    expect(linker()("[[[[x]]]]")).toBe("x]]");
    expect(linker()("[[[[billing]]]]")).toBe("billing]]");
    expect(linker()("[[ghost[]][billing]]")).toBe("ghost[billing]]");
  });

  it("sees a link whose label holds a backtick, as the site does", () => {
    expect(linker(WP)("[[wp:Un|x`y`]] [[wp:Cron|x`y`]]")).toBe("xy [[wp:Cron|x`y`]]");
    expect(linker()("[[Billing|`a`]]")).toBe("[[billing|`a`]]");
  });

  it("does not let a freed backtick pair up and uncover a token it left alone", () => {
    expect(linker()("[[wp:Un|x`]] `[[wp:Unchecked]]` z")).toBe("x `[[wp:Unchecked]]` z");
  });

  it("treats an empty label as no label, like the site", () => {
    expect(linker(WP)("[[Billing| ]] [[wp:Cron| ]]")).toBe("[[billing|Billing]] [[wp:Cron]]");
  });

  it("only ever emits links the site may follow, and is idempotent (random claims)", () => {
    const pieces = [
      "[[",
      "]]",
      "[",
      "]",
      "|",
      "`",
      "\ue000",
      "\ue001",
      " ",
      "x",
      "billing",
      "Billing",
      "signals",
      "ghost",
      "invoices",
      "legacy-signals",
      "retired-thing",
      "wp:Cron",
      "wp:Bad",
      "wp:Un",
      "Cron",
    ];
    const resolve = createTargetResolver(linkManifest());
    let seed = 12345;
    const next = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 4000; i++) {
      const text = Array.from({ length: 4 + next(12) }, () => pieces[next(pieces.length)]).join("");
      const out = linker(WP)(text);
      const seen = new Set<string>();
      for (const [, code, target = "", label] of out
        .replace(/[\ue000\ue001]/g, "")
        .matchAll(SITE_TOKEN)) {
        if (code !== undefined) continue;
        const key = target.trim();
        const ok = key.startsWith("wp:") ? key === "wp:Cron" : resolve(key)?.id === key;
        expect({ text, out, key, ok }).toMatchObject({ ok: true });
        expect({ text, out, key }).not.toMatchObject({ key: "signals" });
        expect({ text, out, key, again: seen.has(key) }).toMatchObject({ again: false });
        expect(label ?? "").not.toContain("]");
        seen.add(key);
      }
      expect({ text, out: linker(WP)(out) }).toEqual({ text, out });
    }
  });
});

describe("fix round 1", () => {
  const WP = new Map<string, string | null>([["Cron", "Cron"]]);
  // The site deletes U+E000 and U+E001 from claim text before it reads any token.
  const OPEN = String.fromCharCode(0xe000);
  const CLOSE = String.fromCharCode(0xe001);
  const split = (token: string) => `[${OPEN}[${token}]${CLOSE}]`;

  it("reads tokens the way the site does after it deletes its placeholder characters", () => {
    const link = createPageLinker(linkManifest(), "signals", WP);
    expect(link(split("wp:Evil"))).toBe("Evil");
    expect(link(split("signals"))).toBe("Signal ingestion");
    expect(link(`[[billing]] ${split("billing")} ${split("wp:Cron")} ${split("wp:Cron")}`)).toBe(
      "[[billing]] Billing [[wp:Cron]] Cron",
    );
    expect(wikipediaTitlesIn(split("wp:Evil"))).toEqual(["Evil"]);
  });

  it("flags a token that only exists once the placeholder characters are deleted", () => {
    const revision = makeRevision();
    const lead = revision.sections[0];
    if (lead?.claims[0] === undefined) throw new Error("fixture has a lead");
    lead.claims[0].text = split("nowhere");
    expect(linkViolations(revision, linkManifest())).toEqual([
      'signals "lead-1": a link to "nowhere" is not a feature id',
    ]);
  });

  it("resolves a name to an active feature over a retired one that shares it", () => {
    const retired = makeFeature({
      id: "a-old-billing",
      title: "Billing",
      aliases: ["invoices"],
      status: { kind: "retired" },
    });
    const manifest = linkManifest();
    manifest.features.unshift(retired);
    const resolve = createTargetResolver(manifest);
    expect(resolve("Billing")?.id).toBe("billing");
    expect(resolve("invoices")?.id).toBe("billing");
  });

  it("resolves a name two active features share to the smaller id", () => {
    const manifest = linkManifest();
    manifest.features.unshift(
      makeFeature({ id: "ledger", title: "Ledger", aliases: ["billing"] }),
      makeFeature({ id: "accounts", title: "Accounts", aliases: ["BILLING"] }),
    );
    const resolve = createTargetResolver(manifest);
    expect(resolve("Billing")?.id).toBe("accounts");
    expect(resolve("billing")?.id).toBe("billing");
  });

  it("resolves a redirect cycle to no page", () => {
    const manifest = linkManifest();
    manifest.features.push(
      makeFeature({
        id: "loop-a",
        title: "Loop A",
        aliases: [],
        status: { kind: "redirect", to: "loop-b" },
      }),
      makeFeature({
        id: "loop-b",
        title: "Loop B",
        aliases: [],
        status: { kind: "redirect", to: "loop-a" },
      }),
    );
    const resolve = createTargetResolver(manifest);
    expect(resolve("loop-a")).toBeNull();
    expect(resolve("Loop B")).toBeNull();
    expect(createPageLinker(manifest, "signals", NO_WP)("[[loop-a]]")).toBe("Loop A");
  });

  it("emits nothing for a dropped link whose words are all stripped, and never the raw token", () => {
    const link = createPageLinker(linkManifest(), "signals", NO_WP);
    expect(link("a[[ghost|`]]b [[ghost|[]]c")).toBe("ab c");
    const manifest = linkManifest();
    manifest.features.push(
      makeFeature({
        id: "old",
        title: "]",
        aliases: [],
        status: { kind: "redirect", to: "billing" },
      }),
    );
    expect(createPageLinker(manifest, "signals", NO_WP)("[[old]]")).toBe("[[billing]]");
  });
});

describe("link words built from a feature title", () => {
  const OPEN = String.fromCharCode(0xe000);
  const withOld = (title: string) => {
    const manifest = linkManifest();
    manifest.features.push(
      makeFeature({
        id: "old",
        title,
        aliases: [],
        status: { kind: "redirect", to: "billing" },
      }),
    );
    return manifest;
  };

  it("strips brackets, backticks and placeholder characters, so the title cannot start a token", () => {
    const out = createPageLinker(
      withOld("a`x [[wp:Evil"),
      "signals",
      NO_WP,
    )("Uses ` tick [[old]] here.");
    expect(out).toBe("Uses ` tick [[billing|ax wp:Evil]] here.");
    // The site pairs the lone backtick with one from the label; none is left to pair with.
    const targets = [...out.matchAll(SITE_TOKEN)].flatMap((m) =>
      m[1] === undefined ? [m[2]] : [],
    );
    expect(targets).toEqual(["billing"]);
    expect(wikipediaTitlesIn(out)).toEqual([]);
    expect(createPageLinker(withOld(`a${OPEN}b`), "signals", NO_WP)("[[old]]")).toBe(
      "[[billing|ab]]",
    );
  });

  it("keeps a plain title as the label", () => {
    expect(createPageLinker(withOld("Old name"), "signals", NO_WP)("[[old]]")).toBe(
      "[[billing|Old name]]",
    );
  });
});

describe("unlinkText", () => {
  const titles = new Map([["deliverables", "Deliverables"]]);

  it("turns every link token into its plain words and keeps code spans", () => {
    expect(
      unlinkText(
        "See [[deliverables]], [[deliverables|the records]] and [[wp:Message queue]]; `[[x]]` stays.",
        titles,
      ),
    ).toBe("See Deliverables, the records and Message queue; `[[x]]` stays.");
  });

  it("strips brackets and backticks from the words, and the site's placeholder characters", () => {
    expect(unlinkText("[[wp:Evil|a `b` [c]]", titles)).toBe("a b c");
    expect(unlinkText("[\ue000[wp:Evil]]", titles)).toBe("Evil");
  });

  it("leaves no token behind for odd runs of brackets", () => {
    const out = unlinkText("[[[ ]][x]]", titles);
    expect(linkTokensIn(out)).toEqual([]);
    expect(out).not.toContain("[[");
  });
});

describe("linksWithoutPage", () => {
  it("counts links and See also entries to active features that have no stored page", () => {
    const signals = makeRevision({ seeAlso: ["deliverables", "billing"] });
    const lead = signals.sections[0]?.claims[0];
    if (lead) lead.text = "[[billing|Bills]], [[deliverables]], [[wp:Cron]] and [[signals]].";
    const billing = makeRevision({ id: "rev-2", featureId: "billing", seeAlso: ["signals"] });
    // deliverables has no page: once in See also, once as a link. A Wikipedia link is not counted.
    expect(linksWithoutPage([signals, billing], linkManifest())).toBe(2);
    expect(linksWithoutPage([signals], linkManifest())).toBe(4);
  });
});
