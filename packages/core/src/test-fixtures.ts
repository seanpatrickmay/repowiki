import type { Architecture, ArchitectureClaim } from "./architecture.ts";
import type { AskResponse } from "./ask.ts";
import type { CodeCitation, CommitCitation } from "./citation.ts";
import type { Claim } from "./claim.ts";
import { contentHash } from "./content-hash.ts";
import type { Feature } from "./feature.ts";
import type {
  GitHubIssue,
  GitHubPull,
  GitHubSnapshot,
  InFlight,
  InFlightIssue,
  InFlightPull,
} from "./inflight.ts";
import type { LedgerEntry } from "./llm.ts";
import type { Manifest } from "./manifest.ts";
import type { PeopleSnapshot, PersonFacts, PersonRevision } from "./person.ts";
import type { Revision } from "./revision.ts";

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const SHA_C = "c".repeat(40);

/** src/signals/ingest.py as the fixtures cite it: 31 lines, with ingest_chunk on lines 10-24. */
export const INGEST_PY = `${[
  '"""Turns ingested chunks into signals."""',
  "",
  "from dataclasses import dataclass",
  "",
  "from .store import save_signal",
  "",
  "MAX_SIGNALS = 50",
  "",
  "",
  "def ingest_chunk(chunk):",
  '    """Creates one signal per sentence in the chunk."""',
  "    signals = []",
  "    # Blank sentences make no signal.",
  "    for sentence in chunk.sentences:",
  "        if not sentence.text.strip():",
  "            continue",
  "        signal = Signal(text=sentence.text, source=chunk.source)",
  "        signals.append(signal)",
  "        if len(signals) >= MAX_SIGNALS:",
  "            # TODO: page through long chunks instead of truncating",
  "            break",
  "    for signal in signals:",
  "        save_signal(signal)",
  "    return signals",
  "",
  "",
  "@dataclass",
  "class Signal:",
  "    text: str",
  "    source: str",
  "",
].join("\n")}\n`;

/** Lines start..end (1-based, inclusive) of a source text, without the final newline. */
export function sourceLines(source: string, start: number, end: number): string {
  return source
    .split("\n")
    .slice(start - 1, end)
    .join("\n");
}

export function codeCitation(overrides: Partial<CodeCitation> = {}): CodeCitation {
  return {
    kind: "code",
    path: "src/signals/ingest.py",
    startLine: 10,
    endLine: 24,
    sha: SHA_A,
    symbol: "ingest_chunk",
    contentHash: contentHash(sourceLines(INGEST_PY, 10, 24)),
    ...overrides,
  };
}

export function commitCitation(overrides: Partial<CommitCitation> = {}): CommitCitation {
  return {
    kind: "commit",
    sha: SHA_A,
    subject: "feat: add signal ingestion",
    pr: 45,
    ...overrides,
  };
}

export function bodyClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: "c-1",
    text: "Signals are created from ingested chunks.",
    kind: "fact",
    citations: [codeCitation()],
    supports: [],
    staleSince: null,
    hook: false,
    ...overrides,
  };
}

export function leadClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: "lead-1",
    text: "**Signal ingestion** is the subsystem that turns ingested chunks into signals.",
    kind: "fact",
    citations: [],
    supports: ["c-1"],
    staleSince: null,
    hook: false,
    ...overrides,
  };
}

export function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: "signals",
    title: "Signal ingestion",
    aliases: ["signal pipeline"],
    status: { kind: "active" },
    lineage: [{ kind: "create", sha: SHA_A }],
    ...overrides,
  };
}

export function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    sha: SHA_A,
    features: [
      makeFeature(),
      makeFeature({ id: "deliverables", title: "Deliverables", aliases: [] }),
    ],
    membership: {
      "src/signals/ingest.py#ingest_chunk": { featureId: "signals", weight: 0.9 },
      "src/deliverables/crud.py": { featureId: "deliverables", weight: 0.7 },
    },
    ...overrides,
  };
}

export function makeLedgerEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    runId: "run-1",
    at: "2026-10-01T12:00:00.000Z",
    purpose: "manifest",
    model: "claude-haiku-4-5-20251001",
    featureId: null,
    batch: false,
    cacheKey: null,
    tokens: { in: 1000, out: 200, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

export function makeRevision(overrides: Partial<Revision> = {}): Revision {
  return {
    id: "rev-1",
    featureId: "signals",
    sha: SHA_A,
    commitDate: "2026-02-03T10:00:00-05:00",
    generatedAt: "2026-09-30T20:00:00Z",
    parentId: null,
    reason: "build",
    pr: null,
    model: "claude-haiku-4-5",
    tokens: { in: 1200, out: 300, cacheRead: 0, cacheWrite: 0 },
    infobox: {
      files: 3,
      loc: 240,
      languages: ["Python"],
      entryPoints: ["src/signals/ingest.py"],
      firstCommitDate: "2026-01-26T09:00:00-05:00",
      lastCommitDate: "2026-02-03T10:00:00-05:00",
    },
    diagram: null,
    seeAlso: ["deliverables"],
    sections: [
      { key: "lead", claims: [leadClaim()] },
      { key: "overview", claims: [bodyClaim()] },
    ],
    ...overrides,
  };
}

/** A body claim of the Architecture article: a cited claim that names no page. */
export function architectureClaim(overrides: Partial<ArchitectureClaim> = {}): ArchitectureClaim {
  return {
    ...bodyClaim({ id: "a-1", text: "Signals feed deliverables." }),
    pages: [],
    ...overrides,
  };
}

/** An Architecture article over makeManifest()'s two features, written at SHA_A. */
export function makeArchitecture(overrides: Partial<Architecture> = {}): Architecture {
  return {
    id: "architecture-aaaaaaaaaaaa-1",
    sha: SHA_A,
    title: "demo",
    commitDate: "2026-02-03T10:00:00-05:00",
    generatedAt: "2026-09-30T20:00:00Z",
    parentId: null,
    reason: "build",
    pr: null,
    model: "claude-haiku-4-5",
    tokens: { in: 4000, out: 900, cacheRead: 0, cacheWrite: 0 },
    basis: ["rev-1"],
    edges: [{ from: "deliverables", to: "signals", imports: 1, calls: 2 }],
    diagram: null,
    sections: [
      {
        key: "lead",
        claims: [
          {
            ...leadClaim({
              id: "lead-1",
              text: "**demo** is built from signals and deliverables.",
            }),
            supports: ["a-1"],
            pages: [],
          },
        ],
      },
      { key: "layers", claims: [architectureClaim()] },
      {
        key: "dependencies",
        claims: [architectureClaim({ id: "a-2", citations: [], pages: ["signals"] })],
      },
    ],
    ...overrides,
  };
}

/** An answered AskResponse: two sentences citing two claims of the signals page. */
export function makeAskResponse(overrides: Partial<AskResponse> = {}): AskResponse {
  return {
    status: "answered",
    question: "Where are signals made?",
    head: SHA_A,
    sentences: [
      { text: "Signals are made by `ingest_chunk` in src/signals/ingest.py.", sources: [1] },
      { text: "Ingestion stops after `MAX_SIGNALS` signals.", sources: [1, 2] },
    ],
    sources: [
      {
        n: 1,
        pageId: "signals",
        pageTitle: "Signal ingestion",
        section: "overview",
        sectionTitle: "Overview",
        claimId: "s-1",
        href: "/wiki/signals/#claim-s-1",
        excerpt: "ingest_chunk makes one signal per non-blank sentence of a chunk.",
      },
      {
        n: 2,
        pageId: "signals",
        pageTitle: "Signal ingestion",
        section: "how-it-works",
        sectionTitle: "How it works",
        claimId: "s-2",
        href: "/wiki/signals/#claim-s-2",
        excerpt: "Ingestion stops once a chunk has made MAX_SIGNALS (50) signals.",
      },
    ],
    readNext: [
      {
        pageId: "deliverables",
        title: "Deliverables",
        href: "/wiki/deliverables/",
        summary: "Deliverables are built from signals.",
      },
    ],
    refused: 0,
    cached: false,
    answeredAt: "2026-10-05T12:00:00.000Z",
    cost: { turns: 2, usd: 0.0098, model: "claude-haiku-4-5-20251001" },
    ...overrides,
  };
}

/** The repository the in-flight fixtures read: acme/demo on github.com, public. */
export const DEMO_REPO = {
  host: "github.com" as const,
  owner: "acme",
  name: "demo",
  private: false,
  defaultBranch: "main",
};

/**
 * Open pull request #12 at SHA_C: it changes ingest.py in signals, would make the signals page's
 * c-1 (and the lead that summarizes it) stale, closes issue #7, and has a one-claim summary.
 */
export function makeInFlightPull(overrides: Partial<InFlightPull> = {}): InFlightPull {
  return {
    number: 12,
    title: "Page through long chunks",
    author: { login: "octo-dev", bot: false, person: null },
    draft: false,
    createdAt: "2026-10-01T09:00:00Z",
    updatedAt: "2026-10-03T09:00:00Z",
    baseRef: "main",
    labels: ["area:signals"],
    closes: [7],
    head: "fetched",
    headSha: SHA_C,
    mergeBase: SHA_A,
    baseSha: SHA_A,
    behind: null,
    merge: "clean",
    mergeReason: null,
    files: [
      {
        path: "src/signals/ingest.py",
        oldPath: "src/signals/ingest.py",
        status: "modified",
        additions: 6,
        deletions: 2,
        featureId: "signals",
        placement: "member",
      },
    ],
    filesTruncated: 0,
    features: [
      {
        featureId: "signals",
        files: 1,
        changedLines: 8,
        added: 0,
        removed: 0,
        churn: 0,
        drifts: false,
      },
    ],
    effects: [
      {
        featureId: "signals",
        revisionId: "rev-1",
        claimId: "c-1",
        reason: "src/signals/ingest.py:10-24 at aaaaaaa: the cited lines changed",
        certain: true,
      },
      {
        featureId: "signals",
        revisionId: "rev-1",
        claimId: "lead-1",
        reason: "it summarizes c-1, which changed",
        certain: true,
      },
    ],
    summary: {
      model: "claude-haiku-4-5-20251001",
      generatedAt: "2026-10-03T10:00:00Z",
      tokens: { in: 4000, out: 300, cacheRead: 0, cacheWrite: 0 },
      claims: [
        {
          id: "p12-c1",
          text: "The pull request makes `ingest_chunk` page through long chunks.",
          citations: [codeCitation({ sha: SHA_C })],
          features: ["signals"],
        },
      ],
    },
    ...overrides,
  };
}

/** Open issue #7, which #12 closes and which maps to signals through it. */
export function makeInFlightIssue(overrides: Partial<InFlightIssue> = {}): InFlightIssue {
  return {
    number: 7,
    title: "Long chunks lose signals",
    author: { login: "reporter", bot: false, person: null },
    labels: ["bug"],
    createdAt: "2026-09-20T09:00:00Z",
    updatedAt: "2026-10-02T09:00:00Z",
    features: [{ featureId: "signals", kind: "pull", detail: "#12" }],
    pulls: [12],
    ...overrides,
  };
}

/** A snapshot of acme/demo derived against SHA_A, the head of makeRevision()'s page. */
export function makeInFlight(overrides: Partial<InFlight> = {}): InFlight {
  return {
    repo: DEMO_REPO,
    fetchedAt: "2026-10-03T09:30:00Z",
    derivedAt: "2026-10-03T10:00:00Z",
    wikiHead: SHA_A,
    pulls: [makeInFlightPull()],
    issues: [makeInFlightIssue()],
    omitted: { pulls: 0, issues: 0 },
    ...overrides,
  };
}

/** Pull request #12 as the GitHub snapshot stores it. */
export function makeGitHubPull(overrides: Partial<GitHubPull> = {}): GitHubPull {
  return {
    number: 12,
    title: "Page through long chunks",
    body: "Long chunks were cut at MAX_SIGNALS; this pages through them.",
    author: { login: "octo-dev", bot: false, person: null },
    draft: false,
    createdAt: "2026-10-01T09:00:00Z",
    updatedAt: "2026-10-03T09:00:00Z",
    baseRef: "main",
    baseRefOid: null,
    headRefOid: SHA_C,
    labels: ["area:signals"],
    closes: [7],
    files: ["src/signals/ingest.py"],
    filesTotal: 1,
    ...overrides,
  };
}

/** Issue #7 as the GitHub snapshot stores it. */
export function makeGitHubIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 7,
    title: "Long chunks lose signals",
    body: "A chunk with more than 50 sentences loses the rest.",
    author: { login: "reporter", bot: false, person: null },
    labels: ["bug"],
    createdAt: "2026-09-20T09:00:00Z",
    updatedAt: "2026-10-02T09:00:00Z",
    ...overrides,
  };
}

export function makeGitHubSnapshot(overrides: Partial<GitHubSnapshot> = {}): GitHubSnapshot {
  return {
    repo: DEMO_REPO,
    fetchedAt: "2026-10-03T09:30:00Z",
    pulls: [makeGitHubPull()],
    issues: [makeGitHubIssue()],
    omitted: { pulls: 0, issues: 0 },
    dropped: 0,
    droppedPaths: 0,
    ...overrides,
  };
}

/**
 * Ada Lovelace's facts: four commits over two features, one pull request she authored and merged,
 * and 90 of the snapshot's current lines.
 */
export function makePersonFacts(overrides: Partial<PersonFacts> = {}): PersonFacts {
  return {
    id: "ada-lovelace",
    name: "Ada Lovelace",
    otherNames: ["ada"],
    kind: "human",
    firstCommit: "2026-01-05T10:00:00+01:00",
    lastCommit: "2026-03-14T16:30:00+01:00",
    commits: 4,
    added: 120,
    deleted: 30,
    currentLines: 90,
    prsAuthored: [{ number: 3, title: "Add signal ingestion", mergedAt: "2026-01-20T09:00:00Z" }],
    prsMerged: [3],
    features: [
      { featureId: "signals", commits: 3, currentLines: 80 },
      { featureId: "deliverables", commits: 1, currentLines: 10 },
    ],
    activity: [
      { day: "2026-01-05", commits: 2, added: 80, deleted: 0 },
      { day: "2026-02-10", commits: 1, added: 30, deleted: 20 },
      { day: "2026-03-14", commits: 1, added: 10, deleted: 10 },
    ],
    ...overrides,
  };
}

/**
 * The People snapshot at SHA_A over makeManifest()'s features: Ada Lovelace, Grace Hopper and the
 * dependabot bot, with 40 lines whose author is excluded.
 */
export function makePeopleSnapshot(overrides: Partial<PeopleSnapshot> = {}): PeopleSnapshot {
  return {
    sha: SHA_A,
    commitDate: "2026-03-14T16:30:00+01:00",
    commits: 9,
    people: [
      makePersonFacts(),
      makePersonFacts({
        id: "dependabot",
        name: "dependabot[bot]",
        otherNames: [],
        kind: "bot",
        firstCommit: "2026-02-01T00:00:00Z",
        lastCommit: "2026-02-01T00:00:00Z",
        commits: 1,
        added: 0,
        deleted: 0,
        currentLines: 0,
        prsAuthored: [],
        prsMerged: [],
        features: [],
        activity: [{ day: "2026-02-01", commits: 1, added: 0, deleted: 0 }],
      }),
      makePersonFacts({
        id: "grace-hopper",
        name: "Grace Hopper",
        otherNames: [],
        firstCommit: "2026-01-10T09:00:00-05:00",
        lastCommit: "2026-02-20T09:00:00-05:00",
        commits: 3,
        added: 150,
        deleted: 10,
        currentLines: 110,
        prsAuthored: [],
        prsMerged: [],
        features: [{ featureId: "signals", commits: 3, currentLines: 110 }],
        activity: [
          { day: "2026-01-10", commits: 1, added: 100, deleted: 0 },
          { day: "2026-02-20", commits: 2, added: 50, deleted: 10 },
        ],
      }),
    ],
    redirects: [{ from: "ada", to: "ada-lovelace" }],
    others: [{ day: "2026-02-15", commits: 1, added: 40, deleted: 0 }],
    featureLines: { deliverables: 40, signals: 200 },
    totalLines: 240,
    unattributedLines: 40,
    ...overrides,
  };
}

/**
 * Ada Lovelace's narrative at SHA_A: a lead over one chronicle claim and one areas claim, each
 * citing her commit SHA_B.
 */
export function makePersonRevision(overrides: Partial<PersonRevision> = {}): PersonRevision {
  const cite = commitCitation({ sha: SHA_B, subject: "feat: add signal ingestion", pr: 3 });
  return {
    id: "person-ada-lovelace-aaaaaaaaaaaa-1",
    personId: "ada-lovelace",
    sha: SHA_A,
    commitDate: "2026-03-14T16:30:00+01:00",
    generatedAt: "2026-10-06T12:00:00Z",
    parentId: null,
    reason: "build",
    model: "claude-haiku-4-5",
    tokens: { in: 5000, out: 900, cacheRead: 0, cacheWrite: 0 },
    basis: SHA_B,
    sections: [
      {
        key: "lead",
        claims: [
          leadClaim({
            id: "l1",
            text: "**Ada Lovelace** contributed between January and March 2026, to [[signals]].",
            supports: ["c1", "a1"],
          }),
        ],
      },
      {
        key: "chronicle",
        claims: [
          bodyClaim({
            id: "c1",
            kind: "history",
            text: "On 5 January 2026, she added signal ingestion.",
            citations: [cite],
          }),
        ],
      },
      {
        key: "areas",
        claims: [
          bodyClaim({
            id: "a1",
            text: "[[signals]]: her commits added the ingestion loop.",
            citations: [cite],
          }),
        ],
      },
    ],
    ...overrides,
  };
}
