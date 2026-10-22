import {
  leadClaim,
  makeArchitecture,
  makeManifest,
  makeRevision,
} from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  type Biography,
  BiographyEntry,
  type BiographyProject,
  biography,
  biographyEntry,
  biographyName,
  nounPhrase,
  type Run,
  surnameOf,
} from "./biography.ts";
import type { Facts } from "./content.ts";

const sha = (c: string) => c.repeat(40);

/** A made-up published project; the dates are its first and last commits. */
function project(
  title: string,
  first: string,
  last: string,
  patch: {
    commits?: number;
    lines?: number;
    languages?: Facts["languages"];
    lead?: string;
    contribution?: string;
    technologies?: [id: string, importingFiles: number | null, path?: string][];
  } = {},
): BiographyProject {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const lines = patch.lines ?? 1000;
  return {
    slug,
    href: `/ada/${slug}/`,
    entry: BiographyEntry.parse({
      title,
      repo: { fullName: `ada/${slug}`, commitSha: sha(String(title.length % 10)) },
      firstCommitAt: first,
      lastCommitAt: last,
      articles: 7,
      lead:
        patch.lead ??
        `${title} is a tool that sorts the mail into folders by sender. It runs every night. It keeps a log.`,
      contribution: patch.contribution ?? `Lovelace wrote 10 of the repository's 12 commits.`,
      facts: {
        languages: patch.languages ?? [{ name: "Python", share: 1 }],
        indexedFiles: 10,
        featureIds: ["cli"],
        author: {
          commits: patch.commits ?? 10,
          totalCommits: Math.max(12, patch.commits ?? 10),
          currentLines: lines,
          totalLines: lines,
          features: [],
        },
      },
      technologies: (patch.technologies ?? []).map(([id, importingFiles, path]) => ({
        id,
        evidence: { path: path ?? "package.json" },
        importingFiles,
      })),
    }),
  };
}

const ADA = { login: "ada-l", displayName: "Ada Lovelace" };
const AS_OF = "2026-10-15T00:00:00Z";
const three = [
  project("Engine", "2025-03-01T00:00:00Z", "2025-06-01T00:00:00Z", {
    lines: 600,
    languages: [
      { name: "Rust", share: 0.8 },
      { name: "Python", share: 0.2 },
    ],
  }),
  project("Mailbox", "2026-01-10T00:00:00Z", "2026-10-01T00:00:00Z", {
    lines: 4000,
    commits: 300,
    languages: [
      { name: "TypeScript", share: 0.9 },
      { name: "CSS", share: 0.1 },
    ],
  }),
  project("Planner", "2026-05-01T00:00:00Z", "2026-07-01T00:00:00Z", { lines: 2000, commits: 20 }),
];

/** The visible words of some runs. */
const words = (runs: readonly Run[]) =>
  runs.map((r) => ("cite" in r ? "" : "bold" in r ? r.bold : r.text)).join("");
/** Every run of the article, in document order. */
function allRuns(bio: Biography): Run[] {
  return [
    ...bio.lead.flat(),
    ...bio.career.flatMap((p) => [
      ...p.intro,
      ...p.projects.flatMap((x) => [...x.lead, ...x.contribution]),
    ]),
    ...bio.technical.paragraph,
    ...(bio.technical.libraries?.paragraph ?? []),
    ...(bio.technical.libraries?.rows.flatMap((r) => r.projects) ?? []),
  ];
}
/** The template's own words: the subject's bold name (their own words) left out. */
const templateWords = (runs: readonly Run[]) => words(runs.filter((r) => !("bold" in r)));
/** All the prose the templates wrote, with the entries' own free text left out. */
function templateText(bio: Biography): string {
  return [
    ...bio.lead.map(templateWords),
    ...bio.career.map((p) => words(p.intro)),
    words(bio.technical.paragraph),
    words(bio.technical.libraries?.paragraph ?? []),
    bio.infobox.yearsActive,
    bio.infobox.projects,
    bio.infobox.commits,
    ...bio.categories,
    ...bio.career.map((p) => p.heading),
    ...bio.works.map((w) => w.description),
  ].join("\n");
}

describe("biographyEntry", () => {
  const exp = {
    repo: "mailbox",
    exportedAt: "2026-10-01T00:00:00Z",
    architecture: [
      makeArchitecture({
        title: "Mailbox",
        sections: [
          {
            key: "lead",
            claims: [
              {
                ...leadClaim({ id: "l-1", text: "**Mailbox** is a [[cli|tool]] that sorts mail." }),
                supports: [],
                pages: [],
              },
            ],
          },
        ],
      }),
    ],
    pages: [
      makeRevision({ id: "r-1", featureId: "cli" }),
      makeRevision({
        id: "r-2",
        featureId: "rules",
        infobox: {
          ...makeRevision().infobox,
          firstCommitDate: "2025-12-01T09:00:00-05:00",
          lastCommitDate: "2026-03-01T09:00:00-05:00",
        },
      }),
    ],
    manifest: makeManifest(),
  };
  const generation = {
    commitSha: sha("c"),
    facts: three[0]?.entry.facts as Facts,
  };

  it("takes the title, dates, articles and plain lead from the export", () => {
    const entry = biographyEntry({
      generation,
      contribution: "Lovelace wrote it.",
      exp,
      repoFullName: "ada/mailbox",
    });
    expect(entry.title).toBe("Mailbox");
    expect(entry.firstCommitAt).toBe("2025-12-01T09:00:00-05:00");
    expect(entry.lastCommitAt).toBe("2026-03-01T09:00:00-05:00");
    expect(entry.articles).toBe(2);
    expect(entry.lead).toBe("Mailbox is a tool that sorts mail.");
    expect(entry.repo).toEqual({ fullName: "ada/mailbox", commitSha: sha("c") });
  });

  it("keeps the technologies the table knows, and reads old entries as having none (ADR-0014)", () => {
    const react = { id: "react", evidence: { path: "package.json" }, importingFiles: 2 };
    const gone = { id: "no-such-entry", evidence: { path: "package.json" }, importingFiles: 1 };
    const entry = biographyEntry({
      generation: { ...generation, facts: { ...generation.facts, technologies: [react, gone] } },
      contribution: "Lovelace wrote it.",
      exp,
      repoFullName: "ada/mailbox",
    });
    expect(entry.technologies).toEqual([react]);
    const { technologies: _, ...old } = entry;
    expect(BiographyEntry.parse(old).technologies).toEqual([]);
  });

  it("falls back to the repository's name and the export's date", () => {
    const entry = biographyEntry({
      generation,
      contribution: "Lovelace wrote it.",
      exp: { ...exp, architecture: [], pages: [] },
      repoFullName: "ada/mailbox",
    });
    expect(entry.title).toBe("mailbox");
    expect(entry.firstCommitAt).toBe("2026-10-01T00:00:00Z");
    expect(entry.lastCommitAt).toBe("2026-10-01T00:00:00Z");
    expect(entry.lead).toBe("");
  });
});

describe("nounPhrase", () => {
  it("takes the sentence that defines the project, wherever the lead puts it (ADR-0019)", () => {
    const lead =
      "Its features cover the solver and the live bot. **PokerML** is a research engine for heads-up hold'em. It has a terminal table.";
    expect(nounPhrase(lead, "PokerML")).toBe("a research engine for heads-up hold'em");
  });

  const alpha =
    "AlphaSettler is a four-player Settlers of Catan bot that combines a Rust rules engine, information-set Monte Carlo tree search over hidden hands, and a graph network trained by self-play.";

  it("ends a long phrase before the clause that opens a list, never after its first item (recruiter review)", () => {
    const lead =
      "Life Dashboard is a self-hosted wellness application that aggregates health metrics from Garmin, tracks nutrition intake, and surfaces AI-generated insights through a Monet-inspired interface. More.";
    expect(nounPhrase(lead, "Life Dashboard")).toBe("a self-hosted wellness application");
    expect(nounPhrase(alpha, "AlphaSettler")).toBe("a four-player Settlers of Catan bot");
  });

  it("keeps the whole phrase when it fits the limit", () => {
    expect(nounPhrase(alpha, "AlphaSettler", 180)).toBe(
      "a four-player Settlers of Catan bot that combines a Rust rules engine, information-set Monte Carlo tree search over hidden hands, and a graph network trained by self-play",
    );
  });

  it("cuts at the first comma when the clause before a list leaves too short a phrase (local feedback)", () => {
    const lecteur =
      "LecteurAide is a full-stack application that ingests French book PDFs, processes them with Google's Gemini models, and presents them in a reading interface.";
    expect(nounPhrase(lecteur, "LecteurAide")).toBe(
      "a full-stack application that ingests French book PDFs",
    );
    const repowiki =
      "RepoWiki is a system that generates Wikipedia-style wiki articles documenting a git repository's architecture, features and contributors using large language models.";
    expect(nounPhrase(repowiki, "RepoWiki")).toBe(
      "a system that generates Wikipedia-style wiki articles documenting a git repository's architecture",
    );
  });

  it("drops the leading '<Title> is' and cuts at a clause within 110 characters", () => {
    expect(nounPhrase("RepoWiki is a tool that writes wikis. More.", "RepoWiki")).toBe(
      "a tool that writes wikis",
    );
    const long =
      "PokerML is a simulation-driven heads-up and multiplayer no-limit hold'em engine that blends heuristic game-tree search with configurable card and action abstractions.";
    const cut = nounPhrase(long, "PokerML") ?? "";
    expect(cut.length).toBeLessThanOrEqual(110);
    expect(cut).toBe("a simulation-driven heads-up and multiplayer no-limit hold'em engine");
  });

  it("ends without a full stop, question or exclamation mark (review M6)", () => {
    expect(nounPhrase("RepoWiki is a tool?", "RepoWiki")).toBe("a tool");
    expect(nounPhrase("RepoWiki is a tool! It works.", "RepoWiki")).toBe("a tool");
  });

  it("keeps an abbreviation's full stop inside the sentence (review M6)", () => {
    expect(nounPhrase("RepoWiki is a tool, e.g. for mail. More.", "RepoWiki")).toBe(
      "a tool, e.g. for mail",
    );
    expect(
      nounPhrase("RepoWiki is a viewer, i.e. a reader, etc. for repos. More.", "RepoWiki"),
    ).toBe("a viewer, i.e. a reader, etc. for repos");
  });

  it("is null when the lead does not start with the title", () => {
    expect(nounPhrase("A tool that writes wikis.", "RepoWiki")).toBeNull();
    expect(nounPhrase("", "RepoWiki")).toBeNull();
  });
});

describe("biographyName", () => {
  it("is the display name made plain, or the login", () => {
    expect(biographyName("Ada **Lovelace**", "ada")).toBe("Ada Lovelace");
    expect(biographyName(" ", "ada")).toBe("ada");
  });
});

describe("surnameOf", () => {
  it("is the display name's last word, or the login without one", () => {
    expect(surnameOf("Ada King Lovelace", "ada")).toBe("Lovelace");
    expect(surnameOf("ada", "ada")).toBe("ada");
    expect(surnameOf("  ", "ada")).toBe("ada");
  });

  it("drops pronouns in brackets, what follows a comma, symbols and suffixes (review M1)", () => {
    expect(surnameOf("Jane Doe (she/her)", "jd")).toBe("Doe");
    expect(surnameOf("Jane Doe [they/them]", "jd")).toBe("Doe");
    expect(surnameOf("John Smith Jr.", "js")).toBe("Smith");
    expect(surnameOf("John Smith III", "js")).toBe("Smith");
    expect(surnameOf("Ada Lovelace, PhD", "ada")).toBe("Lovelace");
    expect(surnameOf("Grace Hopper MD", "gh")).toBe("Hopper");
    expect(surnameOf("Sean May 🚀", "sean")).toBe("May");
    expect(surnameOf("🚀 (he/him)", "sean")).toBe("sean");
    expect(surnameOf("Jr.", "sean")).toBe("sean");
  });
});

describe("biography", () => {
  const bio = biography({ person: ADA, projects: three, asOf: AS_OF });

  it("orders Works, Career and the navbox newest first by last commit", () => {
    expect(bio.works.map((w) => w.title)).toEqual(["Mailbox", "Planner", "Engine"]);
    expect(bio.career.flatMap((p) => p.projects.map((x) => x.title))).toEqual([
      "Mailbox",
      "Planner",
      "Engine",
    ]);
    expect(bio.navbox.flatMap((g) => g.projects.map((x) => x.title))).toEqual([
      "Mailbox",
      "Planner",
      "Engine",
    ]);
  });

  it("writes the lead from the two projects with the most current lines", () => {
    expect(words(bio.lead[0] ?? [])).toBe(
      "Ada Lovelace is a software developer and the author of Mailbox, a tool that sorts the mail into folders by sender, and Planner, a tool that sorts the mail into folders by sender.",
    );
    expect(words(bio.lead[1] ?? [])).toBe(
      "Lovelace's other public projects include Engine. Across these three projects Lovelace has made 330 commits, written mostly in TypeScript, Python and Rust.",
    );
    expect(bio.infobox.knownFor.map((k) => k.title)).toEqual(["Mailbox", "Planner"]);
  });

  it("fills the infobox from the entries", () => {
    expect(bio.name).toBe("Ada Lovelace");
    expect(bio.infobox).toMatchObject({
      github: { login: "ada-l", href: "https://github.com/ada-l" },
      yearsActive: "2025–present",
      languages: ["TypeScript", "Python", "Rust", "CSS"],
      projects: "3 documented",
      commits: "330 across those projects",
    });
  });

  it("ends the years at the last commit when it is over 12 months before the newest publish", () => {
    const old = biography({ person: ADA, projects: three, asOf: "2027-10-02T00:00:00Z" });
    expect(old.infobox.yearsActive).toBe("2025–2026");
    const one = biography({ person: ADA, projects: [three[0] as BiographyProject], asOf: AS_OF });
    expect(one.infobox.yearsActive).toBe("2025");
  });

  it("keeps Works by last commit, but groups the career and navbox by start year (review I1)", () => {
    const longLived = project("Atlas", "2024-03-01T00:00:00Z", "2026-10-10T00:00:00Z");
    const out = biography({ person: ADA, projects: [...three, longLived], asOf: AS_OF });
    expect(out.works.map((w) => w.title)).toEqual(["Atlas", "Mailbox", "Planner", "Engine"]);
    expect(out.career.map((p) => [p.heading, p.projects.map((x) => x.title)])).toEqual([
      ["2026", ["Mailbox", "Planner"]],
      ["Earlier projects (2024–2025)", ["Atlas", "Engine"]],
    ]);
    expect(out.navbox).toEqual([
      {
        group: "2026",
        projects: [
          expect.objectContaining({ title: "Mailbox" }),
          expect.objectContaining({ title: "Planner" }),
        ],
      },
      {
        group: "Earlier",
        projects: [
          expect.objectContaining({ title: "Atlas" }),
          expect.objectContaining({ title: "Engine" }),
        ],
      },
    ]);
  });

  it("describes a Works row with the whole phrase, and names the project in the lead by its short one (recruiter review)", () => {
    const lead =
      "AlphaSettler is a four-player Settlers of Catan bot that combines a Rust rules engine, information-set Monte Carlo tree search over hidden hands, and a graph network trained by self-play. More.";
    const out = biography({
      person: ADA,
      projects: [project("AlphaSettler", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", { lead })],
      asOf: AS_OF,
    });
    expect(out.works[0]?.description).toBe(
      "A four-player Settlers of Catan bot that combines a Rust rules engine, information-set Monte Carlo tree search over hidden hands, and a graph network trained by self-play",
    );
    expect(words(out.lead[0] ?? [])).toContain(
      "AlphaSettler, a four-player Settlers of Catan bot.",
    );
  });

  it("keeps an abbreviation inside the career's two sentences (review M6)", () => {
    const out = biography({
      person: ADA,
      projects: [
        project("Solo", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", {
          lead: "Solo is a tool, e.g. for mail. It runs nightly. It logs.",
        }),
      ],
      asOf: AS_OF,
    });
    expect(words(out.career[0]?.projects[0]?.lead ?? [])).toBe(
      "Solo is a tool, e.g. for mail. It runs nightly.",
    );
  });

  it("groups the career by first-commit year, latest year first", () => {
    expect(bio.career.map((p) => [p.heading, p.projects.length])).toEqual([
      ["2026", 2],
      ["Earlier projects (2025)", 1],
    ]);
    expect(words(bio.career[0]?.intro ?? [])).toBe(
      "In 2026 Lovelace began work on two projects: Mailbox and Planner.",
    );
    expect(words(bio.career[1]?.intro ?? [])).toBe(
      "Lovelace's earlier documented work, from 2025, is Engine.",
    );
    const mailbox = bio.career[0]?.projects[0];
    expect(mailbox?.articles).toBe(7);
    expect(words(mailbox?.lead ?? [])).toBe(
      "Mailbox is a tool that sorts the mail into folders by sender. It runs every night.",
    );
    expect(mailbox?.label).toBe(
      `Written by an AI model from the git history at ${"7".repeat(7)}, not by Ada Lovelace.`,
    );
  });

  it("says when the student reviewed and published each project (the persona review)", () => {
    const [engine, ...rest] = three;
    const published = { ...(engine as BiographyProject), publishedAt: "2026-03-04T12:00:00Z" };
    const one = biography({ person: ADA, projects: [published, ...rest], asOf: AS_OF });
    const label = one.career.flatMap((c) => c.projects).find((p) => p.title === "Engine")?.label;
    expect(label).toBe(
      `Written by an AI model from the git history at ${"6".repeat(7)}, not by Ada Lovelace, who reviewed it and published it on 4 March 2026.`,
    );
  });

  it("adds up lines by language for the technical profile and the categories", () => {
    expect(bio.technical.rows).toEqual([
      { language: "TypeScript", share: "55%", projects: ["Mailbox"] },
      { language: "Python", share: "32%", projects: ["Planner", "Engine"] },
      { language: "Rust", share: "7%", projects: ["Engine"] },
      { language: "CSS", share: "6%", projects: ["Mailbox"] },
    ]);
    expect(words(bio.technical.paragraph)).toBe(
      "Most of the code in Lovelace's documented projects is TypeScript (55% of lines), followed by Python (32%) and Rust (7%).",
    );
    expect(bio.categories).toEqual([
      "Software developers",
      "TypeScript programmers",
      "Python programmers",
    ]);
  });

  it("cites each repository once per URL, numbered in reading order", () => {
    const cites = allRuns(bio).flatMap((r) => ("cite" in r ? [r] : []));
    const numbers = bio.references.map((r) => r.n);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    for (const c of cites) expect(numbers).toContain(c.cite);
    for (const ref of bio.references) {
      const uses = cites.filter((c) => c.cite === ref.n);
      expect(uses.map((u) => u.use)).toEqual(uses.map((_, i) => i));
      expect(ref.uses).toBe(uses.length);
    }
    expect(bio.references.map((r) => r.url)).toContain(
      `https://github.com/ada/mailbox/tree/${sha("7")}`,
    );
    expect(bio.references.map((r) => r.url)).toContain(
      `https://github.com/ada/mailbox/commits/${sha("7")}`,
    );
    expect(new Set(bio.references.map((r) => r.url)).size).toBe(bio.references.length);
  });

  it("uses the login for a person with no display name", () => {
    const bare = biography({
      person: { login: "ada-l", displayName: "ada-l" },
      projects: three,
      asOf: AS_OF,
    });
    expect(bare.name).toBe("ada-l");
    expect(words(bare.lead[1] ?? [])).toContain("ada-l's other public projects");
  });

  it("leaves out what does not apply for one project", () => {
    const one = biography({
      person: ADA,
      projects: [
        project("Solo", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", { languages: [] }),
      ],
      asOf: AS_OF,
    });
    expect(words(one.lead[0] ?? [])).toBe(
      "Ada Lovelace is a software developer and the author of Solo, a tool that sorts the mail into folders by sender.",
    );
    expect(words(one.lead[1] ?? [])).toBe("In this project Lovelace has made 10 commits.");
    expect(one.career.map((p) => p.heading)).toEqual(["2026"]);
    expect(one.categories).toEqual(["Software developers"]);
    expect(one.technical.rows).toEqual([]);
    expect(one.infobox.commits).toBe("10 in that project");
  });

  it("never uses a pronoun, over many inputs", () => {
    const PRONOUN =
      /\b(?:he|she|they|him|his|her|hers|their|theirs|them|himself|herself|themselves)\b/i;
    const names = [
      "Ada Lovelace",
      "ada-l",
      "Grace Brewster Hopper",
      "Q",
      "Jane Doe (she/her)",
      "John Smith Jr.",
      "Ada Lovelace, PhD",
      "Sean May 🚀",
    ];
    const languageSets: Facts["languages"][] = [
      [],
      [{ name: "Go", share: 1 }],
      [
        { name: "Go", share: 0.5 },
        { name: "C", share: 0.3 },
        { name: "Shell", share: 0.2 },
      ],
    ];
    for (const displayName of names) {
      for (let count = 1; count <= 7; count++) {
        for (const languages of languageSets) {
          const projects = Array.from({ length: count }, (_, i) =>
            project(
              `Tool ${String.fromCharCode(65 + i)}`,
              `${2023 + (i % 3)}-02-01T00:00:00Z`,
              `${2025 + (i % 2)}-03-01T00:00:00Z`,
              {
                lines: (i + 1) * 100,
                commits: i,
                languages,
                lead: i % 2 ? "" : undefined,
                technologies: i % 3 ? [["react", i]] : [],
              },
            ),
          );
          const out = biography({ person: { login: "q", displayName }, projects, asOf: AS_OF });
          expect(templateText(out)).not.toMatch(PRONOUN);
        }
      }
    }
  });

  describe("libraries and tools (ADR-0014)", () => {
    const built = [
      project("Engine", "2025-03-01T00:00:00Z", "2025-06-01T00:00:00Z", {
        technologies: [
          ["react", 5],
          ["vite", 0],
          ["docker", null, "deploy/Dockerfile"],
        ],
      }),
      project("Mailbox", "2026-01-10T00:00:00Z", "2026-10-01T00:00:00Z", {
        technologies: [
          ["pytest", 0, "api/pyproject.toml"],
          ["react", 2, "web/package.json"],
          ["fastapi", 10, "api/pyproject.toml"],
        ],
      }),
      project("Planner", "2026-05-01T00:00:00Z", "2026-07-01T00:00:00Z", {
        technologies: [
          ["fastapi", null, "requirements.txt"],
          ["postgresql", null, "docker compose.yml"],
          ["docker", null, "Dockerfile"],
          ["no-such-entry", 99],
        ],
      }),
    ];
    const withTech = biography({ person: ADA, projects: built, asOf: AS_OF });
    const libraries = withTech.technical.libraries;

    it("ranks the infobox's top 5 libraries before tools, then by projects, files and name", () => {
      // Docker is in two projects, PostgreSQL in one: libraries still come first (owner, review).
      expect(withTech.infobox.technologies).toEqual([
        "FastAPI",
        "React",
        "PostgreSQL",
        "Docker",
        "pytest",
      ]);
    });

    it("gives each work its top 3, libraries before tools, then by importing files, kind and name", () => {
      expect(withTech.works.map((w) => [w.title, w.builtWith])).toEqual([
        ["Mailbox", "FastAPI, React, pytest"],
        ["Planner", "FastAPI, PostgreSQL, Docker"],
        ["Engine", "React, Vite, Docker"],
      ]);
      const testHeavy = project("Suite", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", {
        technologies: [
          ["vitest", 40],
          ["react", 3],
        ],
      });
      const one = biography({ person: ADA, projects: [testHeavy], asOf: AS_OF });
      expect(one.works[0]?.builtWith).toBe("React, Vitest");
    });

    it("tables the top 15 with kinds and a citation per project to the evidence", () => {
      expect(words(libraries?.paragraph ?? [])).toBe(
        "Lovelace's projects are built most often with FastAPI, React and PostgreSQL.",
      );
      expect(libraries?.rows.map((r) => [r.name, r.kind, words(r.projects)])).toEqual([
        ["FastAPI", "Web framework", "Mailbox, Planner"],
        ["React", "UI library", "Mailbox, Engine"],
        ["PostgreSQL", "Database", "Planner"],
        ["Docker", "Infrastructure", "Planner, Engine"],
        ["pytest", "Testing", "Mailbox"],
        ["Vite", "Build tool", "Engine"],
      ]);
      const urls = withTech.references.map((r) => r.url);
      expect(urls).toContain(
        `https://github.com/ada/planner/blob/${"7".repeat(40)}/docker%20compose.yml`,
      );
      expect(withTech.references.find((r) => r.url.endsWith("/api/pyproject.toml"))?.label).toBe(
        `Mailbox: api/pyproject.toml at commit ${"7".repeat(7)}`,
      );
      // One reference per URL: Mailbox's FastAPI and pytest share theirs, cited twice.
      expect(new Set(urls).size).toBe(urls.length);
      expect(withTech.references.find((r) => r.url.endsWith("/api/pyproject.toml"))?.uses).toBe(2);
      const cited = new Set(allRuns(withTech).flatMap((r) => ("cite" in r ? [r.cite] : [])));
      expect(withTech.references.every((r) => cited.has(r.n))).toBe(true);
    });

    it("names no category from a dependency file: a library imported is not a skill (ADR-0020)", () => {
      expect(withTech.categories.filter((c) => c.endsWith("developers"))).toEqual([
        "Software developers",
      ]);
      const single = biography({
        person: ADA,
        projects: [built[0] as BiographyProject],
        asOf: AS_OF,
      });
      expect(single.categories.filter((c) => c.endsWith(" developers"))).toEqual([
        "Software developers",
      ]);
      expect(words(single.technical.libraries?.paragraph ?? [])).toBe(
        "Lovelace's project is built with React, Vite and Docker.",
      );
    });

    it("leaves it all out when no project has a technology", () => {
      expect(bio.technical.libraries).toBeNull();
      expect(bio.infobox.technologies).toEqual([]);
      expect(bio.works.every((w) => w.builtWith === "—")).toBe(true);
      expect(
        bio.categories.some((c) => c.endsWith(" developers") && c !== "Software developers"),
      ).toBe(false);
    });

    it("breaks ties by kind before name, so no import data still reads well (owner ruling)", () => {
      const p = (title: string, ids: string[]) =>
        project(title, "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", {
          technologies: ids.map((id): [string, null] => [id, null]),
        });
      const owner = [
        p("One", ["fastapi", "pytorch", "alembic"]),
        p("Two", ["fastapi", "react", "pydantic", "alembic"]),
        p("Three", ["fastapi", "pytorch", "react", "pydantic"]),
        p("Four", ["alembic", "apscheduler", "aws-sdk", "fastapi", "react", "openai"]),
      ];
      // In the first three: FastAPI in three projects; PyTorch, React, Pydantic and Alembic in two.
      const ranked = biography({ person: ADA, projects: owner.slice(0, 3), asOf: AS_OF });
      expect(ranked.infobox.technologies).toEqual([
        "FastAPI",
        "PyTorch",
        "React",
        "Pydantic",
        "Alembic",
      ]);
      const four = biography({
        person: ADA,
        projects: [owner[3] as BiographyProject],
        asOf: AS_OF,
      });
      expect(four.works[0]?.builtWith).toBe("OpenAI API, FastAPI, React");
    });
  });
});
