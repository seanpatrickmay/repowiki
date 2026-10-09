import type { Manifest, PeopleSnapshot, PersonFacts } from "@repowiki/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthoredCommit } from "../index/index.ts";
import {
  ancestorsOf,
  buildPersonPack,
  MAX_CHRONICLE_CLAIMS,
  PERSON_BUDGET_TOKENS,
  packFor,
  packText,
} from "./pack.ts";
import type { Refreshed } from "./refresh.ts";
import type { Landing } from "./snapshot.ts";
import { type TeamFixture, teamFixture } from "./test-people.ts";

// The tests only read the fixture, so it is built once.
// R32: the team fixture is built once, in a hook, on a machine that may be loaded.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let fx: TeamFixture;
beforeAll(async () => {
  fx = await teamFixture();
});
afterAll(() => fx.remove());
const history = async () => fx;

const pack = (r: Refreshed, m: Manifest, options = {}) => {
  const p = packFor(r, "ada-lovelace", m, options);
  if (p === null) throw new Error("Ada has a pack");
  return p;
};

describe("buildPersonPack (spec v2 #6 §8.2)", () => {
  it("lays out the person, their features and their episodes oldest first", async () => {
    const fx = await history();
    const p = pack(fx.refreshed, fx.manifest);
    const s = (sha: string) => sha.slice(0, 12);
    expect(p.text.split("\n")).toEqual([
      "# Person: Ada Lovelace",
      "Active between 2026-01-02 and 2026-02-07 (author dates).",
      "## Features (id — title — their commits — share of current lines)",
      "- signals — Signal ingestion — 3 — 100%",
      "- deliverables — Deliverables — 1 — 0%",
      "## Work, oldest first",
      "### Commits outside pull requests, 2026-01",
      `- commit:${s(fx.jan)} 2026-01-02 "feat: start signals" — features: signals — files: "src/signals/ingest.py"`,
      `### PR #3 "Add signal ingestion", 2026-01-03 to 2026-01-04, merged 2026-01-05 (commit:${s(fx.pr3)})`,
      `- commit:${s(fx.a1)} 2026-01-03 "feat: parse chunks" — features: signals — files: "src/signals/ingest.py"`,
      `- commit:${s(fx.a2)} 2026-01-04 "feat: store chunks, mail [email]" — features: deliverables — files: "src/deliverables/crud.py"`,
      "### Commits outside pull requests, 2026-02",
      `- commit:${s(fx.feb)} 2026-02-07 "fix: signals \uFFFD edge" — features: signals — files: "src/signals/ingest.py"`,
      `### Pull requests they merged: #6 "Fix crud" 2026-01-07 (commit:${s(fx.pr6)})`,
    ]);
    expect(p.episodes).toEqual({ full: 3, collapsed: 0, shortened: 0 });
    expect(p.basis).toBe(fx.feb);
  });

  it("makes exactly the shown shas citable: her commits, her PR's merge and the merges she made", async () => {
    const fx = await history();
    const p = pack(fx.refreshed, fx.manifest);
    expect([...p.shas].sort()).toEqual([fx.jan, fx.a1, fx.a2, fx.pr3, fx.pr6, fx.feb].sort());
    expect(p.shas.has(fx.b1)).toBe(false);
    expect(p.dates.get(fx.pr6)).toBe("2026-01-07T00:00:00Z");
    expect(p.dates.get(fx.feb)).toBe("2026-02-07T01:00:00+01:00");
    // Bob's #6, which she merged, credits her with the merge only (the I2 ruling); #3 is hers.
    expect([...p.mergedOnly]).toEqual([fx.pr6]);
  });

  it("collapses the oldest episodes first, drops none, and cites only what it still shows", async () => {
    const fx = await history();
    const whole = pack(fx.refreshed, fx.manifest);
    const collapsed = pack(fx.refreshed, fx.manifest, { budgetTokens: whole.tokens - 30 });
    expect(collapsed.episodes.collapsed).toBeGreaterThan(0);
    expect(collapsed.text).toContain(
      `- Commits outside pull requests, 2026-01, 2026-01-02, 1 commit: commit:${fx.jan.slice(0, 12)}`,
    );
    // Over the budget even collapsed, the pack keeps every episode collapsed and says nothing more.
    const tiny = pack(fx.refreshed, fx.manifest, { budgetTokens: 1 });
    expect(tiny.episodes).toEqual({ full: 0, collapsed: 3, shortened: 0 });
    expect(tiny.text).not.toMatch(/earlier|episode/i);
    expect([...tiny.shas].sort()).toEqual([fx.jan, fx.a1, fx.a2, fx.pr3, fx.feb, fx.pr6].sort());
  });

  it("shows only the episodes after the stored narrative's basis for an append (R25)", async () => {
    const fx = await history();
    const covered = ancestorsOf(fx.refreshed.commits, fx.pr6);
    const p = pack(fx.refreshed, fx.manifest, { covered });
    expect(p.text).toContain("## New work, oldest first");
    expect(p.text).not.toContain("PR #3");
    expect(p.text).not.toContain("Pull requests they merged");
    expect([...p.shas]).toEqual([fx.feb]);
  });

  it("is null for an id with no person, and stays under the budget by default", async () => {
    const fx = await history();
    expect(packFor(fx.refreshed, "nobody", fx.manifest)).toBeNull();
    expect(pack(fx.refreshed, fx.manifest).tokens).toBeLessThan(PERSON_BUDGET_TOKENS);
  });
});

describe("packText", () => {
  it("is one line with no email and no structure-forging character, cut short", () => {
    expect(packText("a\nb\u0085c ada@example.com")).toBe("a b c [email]");
    expect(packText("x".repeat(300))).toHaveLength(200);
  });
});

/** A synthetic pack input: Ada's commits as given, every landing hers. */
function synthetic(
  commits: AuthoredCommit[],
  landings: Landing[] = [],
  budgetTokens?: number,
  maxEpisodes?: number,
  author = 0,
) {
  const person = {
    id: "ada",
    name: "Ada",
    otherNames: [],
    firstCommit: "2020-01-01T00:00:00Z",
    lastCommit: "2030-01-01T00:00:00Z",
    features: [],
  } as unknown as PersonFacts;
  return buildPersonPack({
    person,
    group: 0,
    commits: [...commits].reverse(),
    groupOf: () => 0,
    commitFeatures: new Map(),
    landings: new Map(landings.map((l) => [l.number, l])),
    prAuthors: new Map(landings.map((l) => [l.number, author])),
    snapshot: { sha: "f".repeat(40), featureLines: {} } as unknown as PeopleSnapshot,
    manifest: { features: [] } as unknown as Manifest,
    ...(budgetTokens === undefined ? {} : { budgetTokens }),
    ...(maxEpisodes === undefined ? {} : { maxEpisodes }),
  });
}
const hex = (n: number) => n.toString(16).padStart(40, "0");
const commit = (n: number, date: string, subject: string, pr: number | null = null) =>
  ({
    sha: hex(n),
    parents: [hex(n - 1)],
    authorName: "Ada",
    authorEmail: "ada@example.com",
    authorDate: date,
    commitDate: date,
    subject,
    mergeTitle: null,
    files: [{ path: "a.py", added: 1, deleted: 0 }],
    pr,
  }) as AuthoredCommit;

describe("buildPersonPack against hostile and large histories", () => {
  const hostile = 'x, {range}, merged 2030-01-01 (commit:bbbbbbbbbbbb) "Kim" ada@example.com';
  const landing = {
    number: 3,
    sha: hex(900),
    title: hostile,
    mergedAt: "2026-01-09T00:00:00Z",
    merger: 0,
  };
  const commits = [
    commit(1, "2026-01-03T00:00:00Z", hostile, 3),
    commit(2, "2026-01-08T00:00:00Z", "{range}", 3),
  ];
  const title = `"x, {range}, merged 2030-01-01 (commit:bbbbbbbbbbbb) 'Kim' [email]"`;

  it("builds a pull request's heading from its parts, so a title's {range} is only text", () => {
    const p = synthetic(commits, [landing]);
    const heading = p.text.split("\n").find((l) => l.startsWith("### PR #3"));
    expect(heading).toBe(
      `### PR #3 ${title}, 2026-01-03 to 2026-01-08, merged 2026-01-09 (commit:${hex(900).slice(0, 12)})`,
    );
    expect(p.text).toContain(`"{range}" — features`);
  });

  it("collapses the same heading with its title whole and its quote closed", () => {
    const whole = synthetic(commits, [landing]);
    const p = synthetic(commits, [landing], whole.tokens - 20);
    expect(p.episodes.collapsed).toBe(1);
    expect(p.text.split("\n")).toContain(
      `- PR #3 ${title}, 2026-01-03–2026-01-08, 2 commits: commit:${hex(1).slice(0, 12)} … commit:${hex(2).slice(0, 12)} (merged: commit:${hex(900).slice(0, 12)})`,
    );
  });

  it("lists the 50 merged pull requests that landed last, in landing order", () => {
    const merged = Array.from({ length: 60 }, (_, i) => ({
      number: i + 1,
      sha: hex(1000 + i),
      title: null,
      // Low numbers land last: #1 lands in 2026-03, #60 in 2026-01.
      mergedAt: new Date(Date.UTC(2026, 0, 1) + (60 - i) * 86_400_000).toISOString(),
      merger: 0,
    }));
    // Written by someone else (group 1): a pull request of her own is an episode instead.
    const p = synthetic(
      [commit(1, "2026-01-01T00:00:00Z", "start")],
      merged,
      undefined,
      undefined,
      1,
    );
    const line = p.text.split("\n").find((l) => l.startsWith("### Pull requests they merged"));
    const listed = [...(line ?? "").matchAll(/#(\d+) /g)].map((m) => Number(m[1]));
    expect(listed).toEqual(Array.from({ length: 50 }, (_, i) => 50 - i));
    expect(p.shas.has(hex(1000 + 59))).toBe(false);
    expect(p.mergedOnly.size).toBe(50);
    // Her own merged pull requests are not listed (the I2 ruling).
    const own = synthetic([commit(1, "2026-01-01T00:00:00Z", "start")], merged);
    expect(own.text).not.toContain("Pull requests they merged");
  });

  it("builds a 6,000-commit pack in linear time, its token count the text's", () => {
    const many = Array.from({ length: 6048 }, (_, i) =>
      commit(i + 1, new Date(Date.UTC(1990, 0, 1) + i * 2.5 * 86_400_000).toISOString(), `c ${i}`),
    );
    const started = performance.now();
    const p = synthetic(many);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(p.tokens).toBe(Math.ceil(p.text.length / 2.5));
    expect(p.tokens).toBeLessThanOrEqual(PERSON_BUDGET_TOKENS);
    expect(p.episodes.collapsed + p.episodes.shortened).toBeGreaterThan(0);
    expect(p.text.split("\n").filter((l) => l.startsWith("### ")).length).toBeLessThanOrEqual(30);
  });
});

describe("packText's bounds", () => {
  it("cuts a long unbroken token before scrubbing it, in well under a second", () => {
    const started = performance.now();
    expect(packText("a".repeat(80_000))).toHaveLength(200);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("scrubs an address the cut would split, and never ends on half a surrogate pair", () => {
    expect(packText(`${"x".repeat(190)} ada@example.com`)).toBe(`${"x".repeat(190)} [email]`);
    const cut = packText("\u{1F600}".repeat(150));
    expect(cut.isWellFormed()).toBe(true);
    expect(cut.endsWith("…")).toBe(true);
  });
});

describe("buildPersonPack's chronicle cap (the Task 18 ruling)", () => {
  // Forty months of one commit each: forty episodes, too many days, weeks or months: quarters.
  const months = Array.from({ length: 40 }, (_, i) =>
    commit(i + 1, new Date(Date.UTC(2020, i, 15)).toISOString(), `c ${i}`),
  );
  const headings = (text: string) => text.split("\n").filter((l) => l.startsWith("### "));

  it("never shows more than 30 headings: past them, all are grouped by the finest period that fits", () => {
    const p = synthetic(months);
    const shown = headings(p.text);
    expect(shown.length).toBeLessThanOrEqual(MAX_CHRONICLE_CLAIMS);
    // Thirteen full quarters, and April 2023 alone in its quarter, shown as itself.
    expect(shown).toEqual([
      ...[2020, 2021, 2022].flatMap((y) => [1, 2, 3, 4].map((q) => `### Changes in Q${q} ${y}`)),
      "### Changes in Q1 2023",
      "### Commits outside pull requests, 2023-04",
    ]);
    const lines = p.text.split("\n");
    const q1 = lines.indexOf("### Changes in Q1 2020");
    expect(lines.slice(q1 + 1, q1 + 4).map((l) => l.slice(0, 32))).toEqual(
      [1, 2, 3].map((n) => `- commit:${hex(n).slice(0, 12)} 2020-0${n}-15`),
    );
    expect(p.shas.size).toBe(40);
    expect(p.episodes).toEqual({ full: 14, collapsed: 0, shortened: 0 });
  });

  it("groups to the room an append leaves, by year and then a span, and shortens the longest", () => {
    const p = synthetic(months, [], undefined, 3);
    expect(headings(p.text)).toEqual([
      "### Changes from 2020 to 2021",
      "### Changes in 2022",
      "### Changes in 2023",
    ]);
    const tight = synthetic(months, [], p.tokens - 300, 3);
    expect(headings(tight.text)).toEqual(headings(p.text));
    expect(tight.episodes).toEqual({ full: 2, collapsed: 0, shortened: 1 });
    expect(tight.shas.size).toBeLessThan(40);
    expect(tight.tokens).toBeLessThanOrEqual(p.tokens - 300);
    // Over the budget at one subject a group, every period still shows.
    const tiny = synthetic(months, [], 1, 3);
    expect(headings(tiny.text)).toEqual(headings(p.text));
    expect(tiny.shas.size).toBe(3);
  });
});

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const mm = (m: number) => String(m + 1).padStart(2, "0");

/**
 * `count` commits `stepHours` apart from `start`: runs of `run` commits in a pull request merged an
 * hour after its last one, then one commit outside pull requests; each commit's size differs.
 */
function longRun(start: number, count: number, stepHours: number, run: number) {
  /** A sha whose first 12 digits, the ones a pack prints, are `n`'s own. */
  const sha = (n: number, tail: string) => n.toString(16).padStart(12, "0").padEnd(40, tail);
  const commits: AuthoredCommit[] = [];
  const landings: Landing[] = [];
  for (let i = 0; i < count; i++) {
    const date = new Date(start + i * stepHours * 3_600_000).toISOString();
    const block = Math.floor(i / (run + 1));
    const pr = i % (run + 1) < run ? block + 1 : null;
    const c = commit(i + 1, date, `change ${i} of the long history`, pr);
    commits.push({
      ...c,
      sha: sha(i + 1, "a"),
      files: [{ path: `f${i % 7}.ts`, oldPath: null, added: (i * 37) % 101, deleted: i % 13 }],
    });
    if (pr !== null && (i % (run + 1) === run - 1 || i === count - 1))
      landings.push({
        number: pr,
        sha: sha(0xf00000 + pr, "b"),
        title: `Work ${pr}`,
        mergedAt: new Date(Date.parse(date) + 3_600_000).toISOString(),
        merger: 0,
      });
  }
  return { commits, landings };
}

/** Whether the pack names month `m` of `y`: a period heading holding it, or a date in it. */
const names = (text: string, y: number, m: number) =>
  text.includes(`${MONTHS[m]} ${y}`) ||
  text.includes(`Q${Math.floor(m / 3) + 1} ${y}`) ||
  text.includes(`### Changes in ${y}\n`) ||
  text.includes(` ${y}-${mm(m)}-`) ||
  text.includes(`, ${y}-${mm(m)}`);

/** Every year and month from the first commit's to the last's. */
function monthsOf(commits: readonly AuthoredCommit[]): [number, number][] {
  const first = new Date(commits[0]?.authorDate ?? "");
  const last = new Date(commits.at(-1)?.authorDate ?? "");
  const out: [number, number][] = [];
  for (let y = first.getUTCFullYear(), m = first.getUTCMonth(); ; m++) {
    if (m === 12) [y, m] = [y + 1, 0];
    out.push([y, m]);
    if (y === last.getUTCFullYear() && m === last.getUTCMonth()) return out;
  }
}

describe("buildPersonPack over a long history (#616)", () => {
  // About 600 commits over ten months of 2025, a hundred pull requests among them.
  const long = longRun(Date.UTC(2025, 0, 1), 600, 12, 5);
  const size = new Map(
    long.commits.map((c) => [
      c.sha.slice(0, 12),
      (c.files[0]?.added ?? 0) + (c.files[0]?.deleted ?? 0),
    ]),
  );
  const at = new Map(long.commits.map((c) => [c.sha.slice(0, 12), c.authorDate]));
  /** Each period heading's label and the shas it lists, in order. */
  const periods = (text: string) => {
    const out: { label: string; shas: string[] }[] = [];
    let current: string[] | null = null;
    for (const line of text.split("\n")) {
      if (line.startsWith("### Changes ")) {
        current = [];
        out.push({ label: line.slice(4), shas: current });
      } else if (!line.startsWith("- commit:")) current = null;
      else current?.push(line.slice(9, 21));
    }
    return out;
  };
  const groups = (text: string) => periods(text).map((g) => g.shas);
  /** The day each commit's episode started: its pull request's first commit's, or its own. */
  const startOf = (commits: readonly AuthoredCommit[]) => {
    const first = new Map<number, string>();
    for (const c of commits) if (c.pr !== null && !first.has(c.pr)) first.set(c.pr, c.authorDate);
    return (c: AuthoredCommit) =>
      new Date((c.pr === null ? undefined : first.get(c.pr)) ?? c.authorDate);
  };
  /** How many commits each month's heading holds. */
  const members = (commits: readonly AuthoredCommit[]) => {
    const start = startOf(commits);
    const out = new Map<string, number>();
    for (const c of commits) {
      const d = start(c);
      const label = `Changes in ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
      out.set(label, (out.get(label) ?? 0) + 1);
    }
    return out;
  };
  /** No period shows two or more subjects more than another, unless that one shows them all. */
  const proportional = (text: string, held: ReadonlyMap<string, number>) => {
    const shown = periods(text);
    for (const a of shown)
      for (const b of shown)
        if (a.shas.length - b.shas.length >= 2) expect(b.shas.length).toBe(held.get(b.label));
  };

  it("names every month from the first commit to the last, within the budget", () => {
    const p = synthetic(long.commits, long.landings);
    expect(monthsOf(long.commits)).toHaveLength(10);
    for (const [y, m] of monthsOf(long.commits)) expect(names(p.text, y, m)).toBe(true);
    expect(p.text.split("\n").filter((l) => l.startsWith("### "))).toEqual(
      monthsOf(long.commits).map(([y, m]) => `### Changes in ${MONTHS[m]} ${y}`),
    );
    expect(p.text).not.toMatch(/episode/i);
    const labels = p.text.split("\n").filter((l) => l.startsWith("### Changes "));
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label.replace(/\b\d{4}\b/g, "")).not.toMatch(/\d/);
    expect(p.text.split("\n").filter((l) => l.startsWith("### ")).length).toBeLessThanOrEqual(30);
    expect(p.tokens).toBeLessThanOrEqual(PERSON_BUDGET_TOKENS);
    expect(p.episodes.shortened).toBeGreaterThan(0);
  });

  it("lists a period's largest changes first, then the oldest, then by sha", () => {
    const p = synthetic(long.commits, long.landings);
    expect(groups(p.text).length).toBeGreaterThan(5);
    for (const shas of groups(p.text)) {
      expect(shas.length).toBeGreaterThan(0);
      const sorted = [...shas].sort(
        (a, b) =>
          (size.get(b) ?? 0) - (size.get(a) ?? 0) ||
          Date.parse(at.get(a) ?? "") - Date.parse(at.get(b) ?? "") ||
          (a < b ? -1 : 1),
      );
      expect(shas).toEqual(sorted);
    }
  });

  it("shortens periods in proportion: one subject at a time from the one showing the most", () => {
    const p = synthetic(long.commits, long.landings);
    expect(p.episodes.shortened).toBe(10);
    proportional(p.text, members(long.commits));
    const counts = groups(p.text).map((g) => g.length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    // January keeps only its first thirteen commits: it shows them all, the rest even.
    const uneven = long.commits.filter((c, i) => i < 13 || !c.authorDate.startsWith("2025-01"));
    const q = synthetic(uneven, long.landings, 12_000);
    expect(periods(q.text)[0]).toMatchObject({ label: "Changes in January 2025" });
    expect(periods(q.text)[0]?.shas).toHaveLength(13);
    proportional(q.text, members(uneven));
  });

  it("never drops a period: over the budget it keeps one subject a period and collapses the rest", () => {
    const tiny = synthetic(long.commits, long.landings, 1);
    for (const [y, m] of monthsOf(long.commits)) expect(names(tiny.text, y, m)).toBe(true);
    for (const shas of groups(tiny.text)) expect(shas).toHaveLength(1);
    expect(tiny.text).not.toMatch(/episode|earlier/i);
    expect(tiny.episodes.full).toBe(0);
    expect(tiny.tokens).toBeGreaterThan(1);
  });

  it("names every period of five years, by quarter or year, within the budget", () => {
    // Five years of 2025's pace: a pull request of two commits, and a commit outside, every 3 days.
    const five = longRun(Date.UTC(2020, 0, 1), 1800, 24, 2);
    const p = synthetic(five.commits, five.landings);
    expect(monthsOf(five.commits)).toHaveLength(60);
    for (const [y, m] of monthsOf(five.commits)) expect(names(p.text, y, m)).toBe(true);
    expect(p.text).toMatch(/### Changes in (Q[1-4] )?2020\n/);
    expect(p.text).not.toMatch(/episode/i);
    expect(p.text.split("\n").filter((l) => l.startsWith("### ")).length).toBeLessThanOrEqual(30);
    expect(p.tokens).toBeLessThanOrEqual(PERSON_BUDGET_TOKENS);
  });

  it("gives a dense ten-day history one heading a day", () => {
    // Three hundred commits over ten days of October 2026, fifty pull requests among them.
    const dense = longRun(Date.UTC(2026, 9, 1), 300, 0.78, 5);
    const p = synthetic(dense.commits, dense.landings);
    expect(p.text.split("\n").filter((l) => l.startsWith("### "))).toEqual(
      Array.from({ length: 10 }, (_, d) => `### Changes on ${d + 1} October 2026`),
    );
    // Each day holds the work started that day: a commit outside pull requests by its own date.
    const start = startOf(dense.commits);
    for (const { label, shas } of periods(p.text))
      for (const sha of shas) {
        const c = dense.commits.find((x) => x.sha.startsWith(sha)) as AuthoredCommit;
        expect(label).toBe(`Changes on ${start(c).getUTCDate()} October 2026`);
      }
    expect(p.tokens).toBeLessThanOrEqual(PERSON_BUDGET_TOKENS);
  });

  it("places work on the day its pack line prints, in the author's own offset (R18)", () => {
    // Pull requests of one evening commit at -04:00, already the next day in UTC, merged later.
    const evenings = Array.from({ length: 31 }, (_, i) =>
      commit(
        i + 1,
        `2026-10-${String(1 + Math.floor(i / 3.1)).padStart(2, "0")}T2${i % 3}:00:00-04:00`,
        `evening ${i}`,
        i + 1,
      ),
    );
    const merged = evenings.map((_, i) => ({
      number: i + 1,
      sha: (0xe00 + i).toString(16).padStart(12, "0").padEnd(40, "c"),
      title: null,
      mergedAt: "2026-10-20T12:00:00Z",
      merger: 0,
    }));
    const p = synthetic(evenings, merged);
    expect(p.text.split("\n").filter((l) => l.startsWith("### "))).toEqual(
      Array.from({ length: 10 }, (_, d) => `### Changes on ${d + 1} October 2026`),
    );
  });

  it("names a week by its Monday", () => {
    // Sixty commits a day apart from Thursday 1 October 2026: too many days, so weeks.
    const weeks = longRun(Date.UTC(2026, 9, 1), 60, 24, 1);
    const p = synthetic(weeks.commits, weeks.landings);
    const shown = p.text.split("\n").filter((l) => l.startsWith("### "));
    expect(shown[0]).toBe("### Changes in the week of 28 September 2026");
    expect(shown[1]).toBe("### Changes in the week of 5 October 2026");
    expect(shown.length).toBeLessThanOrEqual(30);
  });

  it("makes exactly the shas the text shows citable (R17), at any budget", () => {
    for (const budget of [undefined, 12_000, 1]) {
      const p = synthetic(long.commits, long.landings, budget);
      const shown = new Set([...p.text.matchAll(/commit:([0-9a-f]{12})/g)].map((m) => m[1]));
      expect(new Set([...p.shas].map((s) => s.slice(0, 12)))).toEqual(shown);
      expect(new Set(p.dates.keys())).toEqual(p.shas);
    }
  });

  it("gives byte-identical output for the same input", () => {
    const a = synthetic(long.commits, long.landings);
    const b = synthetic(structuredClone(long.commits), structuredClone(long.landings));
    expect(b.text).toBe(a.text);
    expect([...b.shas]).toEqual([...a.shas]);
  });
});
