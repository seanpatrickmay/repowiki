import { GitSha, IsoDateTime, type WikiExport } from "@repowiki/core";
import { z } from "zod";
import { Facts, plainText } from "./content.ts";
import { MAX_TECHNOLOGIES, TechnologyUse } from "./detect.ts";
import { technologyById } from "./technologies.ts";
import { firstClause, plainWords, sentencesOf } from "./text.ts";

/** One published project as the author's biography reads it (ADR-0013), stored as `entry.json`. */
export const BiographyEntry = z.strictObject({
  title: z.string().min(1).max(120),
  repo: z.strictObject({
    fullName: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
    commitSha: GitSha,
  }),
  firstCommitAt: IsoDateTime,
  lastCommitAt: IsoDateTime,
  /** The wiki's feature articles. */
  articles: z.int().nonnegative(),
  /** The About article's lead as plain text; "" when the wiki has none. */
  lead: plainText(2000),
  contribution: plainText(1200),
  facts: Facts,
  /** The facts' technologies the table knew at preview time (ADR-0014); none in older entries. */
  technologies: z.array(TechnologyUse).max(MAX_TECHNOLOGIES).default([]),
});
export type BiographyEntry = z.infer<typeof BiographyEntry>;

const byTime = (a: string, b: string) => Date.parse(a) - Date.parse(b);

/**
 * A project's entry from its generation, its generated contribution and the hosted export: the
 * About article's title and lead, and the first and last commit dates its pages record.
 */
export function biographyEntry(input: {
  generation: { commitSha: string; facts: Facts };
  contribution: string;
  exp: Pick<WikiExport, "architecture" | "pages" | "exportedAt">;
  repoFullName: string;
}): BiographyEntry {
  const { exp } = input;
  const about = exp.architecture.at(-1);
  const leadSection = about?.sections.find((s) => s.key === "lead");
  const lead = plainWords((leadSection?.claims ?? []).map((c) => c.text).join(" "), 2000);
  const dates = exp.pages
    .flatMap((p) => [p.infobox.firstCommitDate, p.infobox.lastCommitDate])
    .sort(byTime);
  const repoName = input.repoFullName.split("/")[1] ?? input.repoFullName;
  return BiographyEntry.parse({
    title: plainWords(about?.title ?? "", 120) || repoName,
    repo: { fullName: input.repoFullName, commitSha: input.generation.commitSha },
    firstCommitAt: dates[0] ?? exp.exportedAt,
    lastCommitAt: dates.at(-1) ?? exp.exportedAt,
    articles: new Set(exp.pages.map((p) => p.featureId)).size,
    lead: lead.replace(/\s+/g, " ").trim(),
    contribution: input.contribution,
    facts: input.generation.facts,
    technologies: input.generation.facts.technologies.filter(
      (t) => technologyById(t.id) !== undefined,
    ),
  });
}

/** A piece of biography prose: words, a link, the subject's bold name, or a citation marker. */
export type Run =
  | { text: string }
  | { text: string; href: string }
  | { bold: string }
  | { cite: number; use: number };
export type Paragraph = Run[];

/** A published project and where its wiki is read. */
export interface BiographyProject {
  slug: string;
  href: string;
  entry: BiographyEntry;
}

export interface Biography {
  name: string;
  surname: string;
  infobox: {
    github: { login: string; href: string };
    yearsActive: string;
    knownFor: { title: string; href: string }[];
    languages: string[];
    projects: string;
    commits: string;
  };
  lead: Paragraph[];
  works: {
    slug: string;
    years: string;
    title: string;
    href: string;
    description: string;
    languages: string;
    commits: string;
  }[];
  career: {
    id: string;
    heading: string;
    intro: Paragraph;
    projects: {
      slug: string;
      title: string;
      href: string;
      articles: number;
      sha7: string;
      lead: Paragraph;
      contribution: Paragraph;
      label: string;
    }[];
  }[];
  technical: {
    paragraph: Paragraph;
    rows: { language: string; share: string; projects: string[] }[];
  };
  references: { n: number; label: string; url: string; uses: number }[];
  navbox: { group: string; projects: { title: string; href: string }[] }[];
  categories: string[];
}

/** How a generated contribution is labelled (ADR-0012). */
export const GENERATED_LABEL = (sha: string) =>
  `Generated from the git history at ${sha.slice(0, 7)}; not written by the author.`;

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const numberWord = (n: number) => WORDS[n] ?? String(n);
const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const plural = (n: number, one: string) => `${thousands(n)} ${one}${n === 1 ? "" : "s"}`;
const yearOf = (iso: string) => iso.slice(0, 4);
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Suffixes after a family name, dropped before the surname is taken (review M1). */
const NAME_SUFFIX = /^(?:jr|sr|ii|iii|iv|phd|md)\.?$/i;

/** `items` joined as "A", "A and B" or "A, B and C", each made by `run`. */
function listed<T>(items: readonly T[], run: (item: T) => Run[]): Run[] {
  return items.flatMap((item, i) => [
    ...(i === 0 ? [] : [{ text: i === items.length - 1 ? " and " : ", " }]),
    ...run(item),
  ]);
}
const listedText = (items: readonly string[]) => listed(items, (t) => [{ text: t }]);

/**
 * What a project is, from its About lead (ADR-0013): the first sentence without its leading
 * "<Title> is", cut when long at its first comma (never inside a list), else at a clause within 110
 * characters; null when the sentence starts otherwise.
 */
export function nounPhrase(lead: string, title: string): string | null {
  const first = sentencesOf(plainWords(lead, 4000).replace(/\s+/g, " "))[0] ?? "";
  const subject = new RegExp(`^(?:the\\s+)?${escapeRe(title)}\\s+(?:is|was|are)\\s+`, "i");
  if (!subject.test(first)) return null;
  const rest = first.replace(subject, "");
  const comma = rest.indexOf(", ", 30);
  // A long phrase ends at its first comma, so a list after it is never cut in half.
  const cut = rest.length > 110 && comma !== -1 && comma < 110 ? rest.slice(0, comma) : rest;
  const phrase = firstClause(cut, 110).replace(/[.!?]+$/, "");
  return phrase === "" ? null : phrase;
}

/** The name a biography is titled with: the display name made plain, or else the login. */
export function biographyName(displayName: string, login: string): string {
  return plainWords(displayName, 120) || login;
}

/**
 * The surname: the display name's last word once bracketed groups ("(she/her)"), anything after
 * a comma, emoji and symbols, and suffixes such as "Jr." or "PhD" are gone; the login when nothing
 * is left or there is no display name (review M1).
 */
export function surnameOf(displayName: string, login: string): string {
  const name = plainWords(displayName, 120);
  if (name === "" || name === login) return login;
  const kept = (name.replace(/\([^)]*\)|\[[^\]]*\]/g, " ").split(",")[0] ?? "")
    .replace(/[^\p{L}\p{M}\p{N}\s'’.-]/gu, " ")
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
  while (kept.length > 0 && NAME_SUFFIX.test(kept.at(-1) ?? "")) kept.pop();
  return kept.at(-1) ?? login;
}

/** Numbered references, one per URL, in the order first cited. */
function referenceList() {
  const refs: Biography["references"] = [];
  const cite = (label: string, url: string): Run => {
    let ref = refs.find((r) => r.url === url);
    if (ref === undefined) {
      ref = { n: refs.length + 1, label, url, uses: 0 };
      refs.push(ref);
    }
    ref.uses += 1;
    return { cite: ref.n, use: ref.uses - 1 };
  };
  return { refs, cite };
}

const github = (e: BiographyEntry, kind: "tree" | "commits") =>
  `https://github.com/${e.repo.fullName}/${kind}/${e.repo.commitSha}`;

/** Lines per language over all the projects, most first (ADR-0013). */
function languageLines(projects: readonly BiographyProject[]) {
  const lines = new Map<string, number>();
  for (const { entry } of projects) {
    for (const l of entry.facts.languages) {
      lines.set(l.name, (lines.get(l.name) ?? 0) + l.share * entry.facts.author.totalLines);
    }
  }
  const total = [...lines.values()].reduce((a, b) => a + b, 0);
  return [...lines]
    .filter(([, n]) => n > 0)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .map(([language, n]) => ({ language, share: n / total }));
}

/**
 * The biography of `person` from their published projects (ADR-0013): every sentence a template
 * over the entries, the subject named by surname and never by a pronoun. `asOf` is the newest
 * publish (a preview's now); a last commit within 12 months of it makes the years "–present".
 */
export function biography(input: {
  person: { login: string; displayName: string };
  projects: readonly BiographyProject[];
  asOf: string;
}): Biography {
  const { login } = input.person;
  const name = biographyName(input.person.displayName, login);
  const surname = surnameOf(input.person.displayName, login);
  const possessive = `${surname}'s`;
  const projects = [...input.projects].sort(
    (a, b) =>
      byTime(b.entry.lastCommitAt, a.entry.lastCommitAt) ||
      (a.entry.title < b.entry.title ? -1 : 1),
  );
  const { refs, cite } = referenceList();
  const treeCite = (p: BiographyProject) =>
    cite(
      `${p.entry.title} repository at commit ${p.entry.repo.commitSha.slice(0, 7)}`,
      github(p.entry, "tree"),
    );
  const historyCite = (p: BiographyProject) =>
    cite(
      `${p.entry.title} git history at commit ${p.entry.repo.commitSha.slice(0, 7)}`,
      github(p.entry, "commits"),
    );
  const link = (p: BiographyProject): Run => ({ text: p.entry.title, href: p.href });

  // Known for: the most current lines by the author; ties keep the newest-first order.
  const known = [...projects]
    .sort((a, b) => b.entry.facts.author.currentLines - a.entry.facts.author.currentLines)
    .slice(0, 2);
  const others = projects.filter((p) => !known.includes(p));
  const languages = languageLines(projects);
  const commits = projects.reduce((n, p) => n + p.entry.facts.author.commits, 0);

  const lead1: Paragraph = [
    { bold: name },
    { text: " is a software developer and the author of " },
    ...known.flatMap((p, i) => {
      const phrase = nounPhrase(p.entry.lead, p.entry.title);
      const last = i === known.length - 1;
      return [
        ...(i === 0 ? [] : [{ text: " and " }]),
        link(p),
        {
          text: `${phrase === null ? "" : `, ${phrase}`}${last ? "." : phrase === null ? "" : ","}`,
        },
        treeCite(p),
      ];
    }),
  ];
  const top = languages.slice(0, 3).map((l) => l.language);
  const across =
    projects.length === 1
      ? "In this project"
      : `Across these ${numberWord(projects.length)} projects`;
  const lead2: Paragraph = [
    ...(others.length === 0
      ? []
      : [
          { text: `${possessive} other public projects include ` },
          ...listed(others, (p) => [link(p)]),
          { text: ". " },
        ]),
    { text: `${across} ${surname} has made ${plural(commits, "commit")}` },
    ...(top.length === 0 ? [] : [{ text: ", written mostly in " }, ...listedText(top)]),
    { text: "." },
  ];

  const firstYear = (p: BiographyProject) => yearOf(p.entry.firstCommitAt);
  const years = (from: string, to: string) => (from === to ? from : `${from}–${to}`);
  const works = projects.map((p) => {
    const phrase = nounPhrase(p.entry.lead, p.entry.title);
    const description =
      phrase === null
        ? firstClause(p.entry.lead, 110)
        : `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`;
    return {
      slug: p.slug,
      years: years(firstYear(p), yearOf(p.entry.lastCommitAt)),
      title: p.entry.title,
      href: p.href,
      description,
      languages:
        p.entry.facts.languages
          .slice(0, 2)
          .map((l) => l.name)
          .join(", ") || "—",
      commits: thousands(p.entry.facts.author.commits),
    };
  });

  const latestYear = projects.map(firstYear).sort().at(-1) ?? "";
  const current = projects.filter((p) => firstYear(p) === latestYear);
  const earlier = projects.filter((p) => firstYear(p) !== latestYear);
  const earlierYears = earlier.map(firstYear).sort();
  const span = years(earlierYears[0] ?? "", earlierYears.at(-1) ?? "");
  const titles = (ps: readonly BiographyProject[]) => listedText(ps.map((p) => p.entry.title));
  const period = (id: string, heading: string, intro: Paragraph, ps: BiographyProject[]) => ({
    id,
    heading,
    intro,
    projects: ps.map((p) => ({
      slug: p.slug,
      title: p.entry.title,
      href: p.href,
      articles: p.entry.articles,
      sha7: p.entry.repo.commitSha.slice(0, 7),
      lead:
        p.entry.lead === ""
          ? []
          : [{ text: sentencesOf(p.entry.lead).slice(0, 2).join(" ") }, treeCite(p)],
      contribution: [{ text: p.entry.contribution }, historyCite(p)],
      label: GENERATED_LABEL(p.entry.repo.commitSha),
    })),
  });
  const career = [
    period(
      `career-${latestYear}`,
      latestYear,
      current.length === 1
        ? [
            { text: `In ${latestYear} ${surname} began work on ` },
            ...titles(current),
            { text: "." },
          ]
        : [
            {
              text: `In ${latestYear} ${surname} began work on ${numberWord(current.length)} projects: `,
            },
            ...titles(current),
            { text: "." },
          ],
      current,
    ),
    ...(earlier.length === 0
      ? []
      : [
          period(
            "career-earlier",
            `Earlier projects (${span})`,
            earlier.length === 1
              ? [
                  { text: `${possessive} earlier documented work, from ${span}, is ` },
                  ...titles(earlier),
                  { text: "." },
                ]
              : [
                  {
                    text: `${possessive} earlier documented work, from ${span.replace("–", " to ")}, comprises ${numberWord(earlier.length)} projects: `,
                  },
                  ...titles(earlier),
                  { text: "." },
                ],
            earlier,
          ),
        ]),
  ];

  const percent = (share: number) => `${Math.round(share * 100)}%`;
  const rows = languages
    .filter((l) => l.share >= 0.01)
    .slice(0, 8)
    .map(({ language, share }) => {
      const has = (min: number) =>
        projects.filter((p) =>
          p.entry.facts.languages.some((l) => l.name === language && l.share >= min),
        );
      const strong = has(0.03);
      return {
        language,
        share: percent(share),
        projects: (strong.length > 0 ? strong : has(0)).map((p) => p.entry.title),
      };
    });
  const [l1, ...rest] = languages.slice(0, 3);
  const paragraph: Paragraph =
    l1 === undefined
      ? [{ text: `The documented projects record no lines by language.` }]
      : Math.round(l1.share * 100) === 100
        ? [{ text: `All of the code in ${possessive} documented projects is ${l1.language}.` }]
        : [
            {
              text: `Most of the code in ${possessive} documented projects is ${l1.language} (${percent(l1.share)} of lines)`,
            },
            ...(rest.length === 0
              ? []
              : [
                  { text: ", followed by " },
                  ...listed(rest, (l) => [{ text: `${l.language} (${percent(l.share)})` }]),
                ]),
            { text: "." },
          ];

  const latestLast =
    projects
      .map((p) => p.entry.lastCommitAt)
      .sort(byTime)
      .at(-1) ?? input.asOf;
  const earliest = projects.map((p) => p.entry.firstCommitAt).sort(byTime)[0] ?? input.asOf;
  const present = Date.parse(input.asOf) - Date.parse(latestLast) <= YEAR_MS;
  return {
    name,
    surname,
    infobox: {
      github: { login, href: `https://github.com/${login}` },
      yearsActive: present
        ? `${yearOf(earliest)}–present`
        : years(yearOf(earliest), yearOf(latestLast)),
      knownFor: known.map((p) => ({ title: p.entry.title, href: p.href })),
      languages: languages.slice(0, 4).map((l) => l.language),
      projects: `${projects.length} documented`,
      commits: `${thousands(commits)} ${projects.length === 1 ? "in that project" : "across those projects"}`,
    },
    lead: [lead1, lead2],
    works,
    career,
    technical: { paragraph, rows },
    references: refs,
    navbox: career.map((c) => ({
      group: c.id === "career-earlier" ? "Earlier" : c.heading,
      projects: c.projects.map((p) => ({ title: p.title, href: p.href })),
    })),
    categories: [
      "Software developers",
      ...languages.filter((l) => l.share >= 0.1).map((l) => `${l.language} programmers`),
    ],
  };
}
