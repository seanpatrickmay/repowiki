import { type Feature, type Revision, SCHEMA_VERSION, WikiExport } from "@repowiki/core";
import {
  bodyClaim,
  codeCitation,
  commitCitation,
  leadClaim,
  makeFeature,
  makeRevision,
  SHA_A,
  SHA_B,
  SHA_C,
} from "@repowiki/core/test-fixtures";

const ingest = codeCitation();
const models = codeCitation({
  path: "src/signals/models.py",
  startLine: 3,
  endLine: 18,
  symbol: null,
});
const oddPath = codeCitation({
  path: "src/signals/odd name#1.py",
  startLine: 1,
  endLine: 9,
  sha: SHA_B,
});
const todo = codeCitation({ startLine: 30, endLine: 30, symbol: null, sha: SHA_B });
const crud = codeCitation({
  path: "src/deliverables/crud.py",
  startLine: 1,
  endLine: 40,
  symbol: null,
});

const signalsV1 = makeRevision({
  id: "signals-1",
  sections: [
    {
      key: "lead",
      claims: [
        leadClaim({ text: "**Signal ingestion** turns chunks into signals.", supports: ["s-o1"] }),
      ],
    },
    {
      key: "overview",
      claims: [bodyClaim({ id: "s-o1", text: "Signals are built from chunks." })],
    },
    {
      key: "known-limitations",
      claims: [
        bodyClaim({
          id: "s-l0",
          kind: "limitation",
          text: "Fetch errors are not retried (a `TODO` notes it).",
          citations: [todo],
        }),
      ],
    },
  ],
});

const signalsV2 = makeRevision({
  id: "signals-2",
  parentId: "signals-1",
  reason: "update",
  sha: SHA_B,
  pr: 88,
  commitDate: "2026-03-10T16:30:00+01:00",
  infobox: {
    files: 4,
    loc: 1312,
    languages: ["Python", "TypeScript"],
    entryPoints: ["src/signals/ingest.py", "src/signals/api.ts"],
    firstCommitDate: "2026-01-26T09:00:00-05:00",
    lastCommitDate: "2026-03-10T16:30:00+01:00",
  },
  diagram:
    "flowchart LR\n  fetch[Fetcher] --> ingest[ingest_chunk]\n  ingest --> store[(signals table)]",
  seeAlso: ["deliverables", "reports", "ghost"],
  sections: [
    {
      key: "lead",
      claims: [
        leadClaim({
          id: "s-lead-1",
          text: "**Signal ingestion** is the subsystem of demo-repo that turns ingested chunks into [[deliverables|deliverable records]].",
          supports: ["s-o1", "s-o2"],
        }),
        leadClaim({
          id: "s-lead-2",
          text: "It retries failed fetches with [[wp:Exponential backoff]].",
          supports: ["s-h2"],
        }),
      ],
    },
    {
      key: "overview",
      claims: [
        bodyClaim({
          id: "s-o1",
          text: "Signals are created from ingested chunks by `ingest_chunk`.",
          hook: true,
        }),
        bodyClaim({
          id: "s-o2",
          text: "Each signal stores its source chunk and a *confidence* score.",
          citations: [ingest, models],
        }),
      ],
    },
    {
      key: "how-it-works",
      claims: [
        bodyClaim({
          id: "s-h1",
          text: "The [[scheduler]] triggers ingestion every five minutes.",
          citations: [oddPath],
          staleSince: SHA_B,
        }),
        bodyClaim({
          id: "s-h2",
          text: "Failed fetches are retried up to three times; [[ghost]] described the old approach. Payloads containing `<script>` tags are stored escaped, and so is <b>this</b>.",
          citations: [models],
        }),
      ],
    },
    {
      key: "data-flow",
      claims: [
        bodyClaim({
          id: "s-d1",
          text: "Chunks pass through [[legacy-signals]] storage before promotion.",
        }),
      ],
    },
    {
      key: "history",
      claims: [
        bodyClaim({
          id: "s-hist1",
          kind: "history",
          text: "Signal ingestion was introduced in PR #45.",
          citations: [commitCitation()],
          hook: true,
        }),
      ],
    },
    {
      key: "known-limitations",
      claims: [
        bodyClaim({
          id: "s-l1",
          kind: "limitation",
          text: "Deduplication is not implemented (a `TODO` in the ingest module).",
          citations: [todo],
        }),
      ],
    },
  ],
});

const deliverables = makeRevision({
  id: "deliverables-1",
  parentId: "deliverables-0",
  reason: "update",
  featureId: "deliverables",
  commitDate: "2026-02-20T11:00:00-05:00",
  seeAlso: ["signals", "hostile-title"],
  infobox: {
    files: 2,
    loc: 410,
    languages: ["Python"],
    entryPoints: ["src/deliverables/crud.py"],
    firstCommitDate: "2026-02-01T09:00:00-05:00",
    lastCommitDate: "2026-02-20T11:00:00-05:00",
  },
  sections: [
    {
      key: "lead",
      claims: [
        leadClaim({
          id: "d-lead",
          text: "**Deliverables** are the records that [[signals]] feed.",
          supports: ["d-o1"],
        }),
      ],
    },
    {
      key: "overview",
      claims: [
        bodyClaim({
          id: "d-o1",
          text: "Deliverables are stored as rows in the `deliverables` table.",
          citations: [crud],
          hook: true,
        }),
      ],
    },
  ],
});

/** Same claim text as `deliverables`; only tokens and infobox differ, so its diff is empty. */
const deliverablesV0: Revision = {
  ...deliverables,
  id: "deliverables-0",
  parentId: null,
  reason: "build",
  commitDate: "2026-02-10T11:00:00-05:00",
  tokens: { in: 900, out: 200, cacheRead: 0, cacheWrite: 0 },
  infobox: { ...deliverables.infobox, loc: 380, lastCommitDate: "2026-02-10T11:00:00-05:00" },
};

const legacy = makeRevision({
  id: "legacy-1",
  featureId: "legacy-signals",
  commitDate: "2026-01-30T08:00:00-05:00",
  seeAlso: [],
  sections: [
    {
      key: "lead",
      claims: [
        leadClaim({ text: "**Legacy signals** stored raw signals before ingestion was rebuilt." }),
      ],
    },
    { key: "overview", claims: [bodyClaim()] },
  ],
});

const exporter = makeRevision({
  id: "exporter-1",
  featureId: "exporter",
  commitDate: "2026-01-15T12:00:00-05:00",
  seeAlso: [],
  sections: [
    {
      key: "lead",
      claims: [leadClaim({ text: "The **CSV exporter** wrote signals to CSV files." })],
    },
    { key: "overview", claims: [bodyClaim({ citations: [crud] })] },
  ],
});

/** Plain-text fields (title, alias) and claim text that are markup, quotes and private-use characters. */
export const HOSTILE_TITLE = "<img src=x onerror=alert(1)> \"q\" & 'p'\uE000\uE001";

const hostile = makeRevision({
  id: "hostile-1",
  featureId: "hostile-title",
  commitDate: "2026-02-25T09:00:00-05:00",
  diagram: 'flowchart LR\n  a["<img src=x onerror=alert(1)>"] --> b',
  seeAlso: ["deliverables"],
  sections: [
    {
      key: "lead",
      claims: [leadClaim({ text: 'She said "hi" and it\'s \uE000fine.' })],
    },
    { key: "overview", claims: [bodyClaim()] },
  ],
});

const pages: Revision[] = [deliverables, exporter, hostile, legacy, signalsV2];

/** A small but complete export: every feature status, two revisions, stale and hook claims. */
export function fixtureExport(): WikiExport {
  return WikiExport.parse({
    schemaVersion: SCHEMA_VERSION,
    repo: "demo-repo",
    head: SHA_C,
    exportedAt: "2026-09-30T21:00:00Z",
    manifest: {
      sha: SHA_C,
      features: [
        makeFeature({ aliases: ["signal pipeline", "SIGNALS_TABLE", "/api/signals"] }),
        makeFeature({
          id: "deliverables",
          title: "Deliverables",
          aliases: ["deliverable records", "signal pipeline", "Signals", "Deliverables"],
        }),
        makeFeature({
          id: "legacy-signals",
          title: "Legacy signals",
          aliases: [],
          status: { kind: "redirect", to: "signals" },
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "merge", sha: SHA_B, into: "signals" },
          ],
        }),
        makeFeature({
          id: "reports",
          title: "Reports",
          aliases: [],
          status: { kind: "disambiguation", to: ["signals", "deliverables"] },
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "split", sha: SHA_B, into: ["signals", "deliverables"] },
          ],
        }),
        makeFeature({
          id: "exporter",
          title: "CSV exporter",
          aliases: [],
          status: { kind: "retired" },
          lineage: [
            { kind: "create", sha: SHA_A },
            { kind: "retire", sha: SHA_C },
          ],
        }),
        makeFeature({ id: "scheduler", title: "Scheduler", aliases: [] }),
        makeFeature({ id: "hostile-title", title: HOSTILE_TITLE, aliases: ["<i>x</i>"] }),
      ],
      membership: {
        "src/signals/ingest.py#ingest_chunk": { featureId: "signals", weight: 0.9 },
        "src/deliverables/crud.py": { featureId: "deliverables", weight: 0.7 },
        "src/scheduler.py": { featureId: "scheduler", weight: 0.6 },
      },
    },
    pages,
    history: {
      deliverables: [deliverablesV0, deliverables],
      exporter: [exporter],
      "hostile-title": [hostile],
      "legacy-signals": [legacy],
      signals: [signalsV1, signalsV2],
    },
  });
}

/** The fixture export with extra manifest features, parsed so the manifest rules still apply. */
export function fixtureExportWith(extra: Feature[]): WikiExport {
  const base = fixtureExport();
  return WikiExport.parse({
    ...base,
    manifest: { ...base.manifest, features: [...base.manifest.features, ...extra] },
  });
}
