import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Manifest, PeopleConfig } from "@repowiki/core";
import { makeFeature } from "@repowiki/core/test-fixtures";
import type { GenerateRequest, Provider } from "@repowiki/llm";
import { builtWiki, CRUD_PY } from "../freshness/index.ts";
import { createTestRepo, type TestAuthor, type TestRepo } from "../index/index.ts";
import { openStore, type Store } from "../store/index.ts";
import { type Refreshed, refreshPeople } from "./refresh.ts";

/** The fixture's authors. Every email and local part is distinctive, so a scan can find a leak. */
export const ADA: TestAuthor = { name: "Ada Lovelace", email: "ada.q7private@example.com" };
export const BOB: TestAuthor = {
  name: "bob",
  email: "4242+bob-q7login@users.noreply.github.com",
};
export const KIM: TestAuthor = { name: "Kim Hidden", email: "kim.q7hidden@example.com" };
export const BOT: TestAuthor = {
  name: "dependabot[bot]",
  email: "49699333+dependabot[bot]@users.noreply.github.com",
};

/** Every author address of the fixture and its local part, for the privacy scans (spec §13). */
export const PEOPLE_SECRETS: readonly string[] = [
  ...[ADA, BOB, KIM, BOT].map((a) => a.email),
  ...[ADA, BOB, KIM].map((a) => a.email.slice(0, a.email.indexOf("@"))),
  "fixture@example.com",
];

/** builtWiki's repository with a team's history after it, and the store moved to its head. */
export interface PeopleFixture {
  repo: TestRepo;
  store: Store;
  /** builtWiki's first commit, by the Fixture author. */
  first: string;
  /** The head the store documents. */
  head: string;
  /** An out dir outside the repository (holding wiki.db when `onDisk`). */
  out: string;
  remove(): void;
}

/**
 * The People fixture (spec v2 #6 §13): builtWiki, then three commits by Ada in +0100, a pull
 * request of two commits by bob (a noreply address) that Ada merges as #7 with its title in the
 * body, a docs commit by Kim whose subject does not name her, and a lockfile bump by dependabot.
 * The store gets the manifest again at the new head, so People documents it; Ada's address is
 * the repository's configured user.email, so she is the owner. `onDisk` keeps the store at
 * `<out>/wiki.db` and closes it, for process tests. Test-only.
 */
export async function peopleFixture(options: { onDisk?: boolean } = {}): Promise<PeopleFixture> {
  const root = mkdtempSync(join(tmpdir(), "repowiki-people-"));
  const out = join(root, "out");
  mkdirSync(out);
  const { repo, store, first } = await builtWiki(
    options.onDisk === true ? join(out, "wiki.db") : ":memory:",
  );
  repo.git("config", "user.email", ADA.email);
  const ingest = (n: number) => `${"# notes\n".repeat(n)}`;
  for (let n = 1; n <= 3; n++) {
    repo.write("src/signals/notes.py", ingest(n));
    repo.commit(`feat: note ${n} on signals`, "+0100", ADA);
  }
  repo.git("switch", "-q", "-c", "topic");
  repo.write("src/deliverables/crud.py", `${CRUD_PY}# paged\n`);
  repo.commit("feat: page deliverables", "-0500", BOB);
  repo.write("src/deliverables/crud.py", `${CRUD_PY}# paged\n# twice\n`);
  repo.commit("fix: page twice", "-0500", BOB);
  repo.git("switch", "-q", "main");
  repo.merge(
    "topic",
    "Merge pull request #7 from bob-q7login/topic\n\nPage through deliverables",
    ADA,
  );
  repo.write("docs/signals.md", "# Signals\n\nHow signals work, tidied.\n");
  repo.commit("docs: tidy the signals page", "+0000", KIM);
  repo.write("package-lock.json", '{"lockfileVersion": 3}\n');
  const head = repo.commit("chore(deps): bump", "+0000", BOT);
  const manifest = store.getLatestManifest();
  if (manifest === null) throw new Error("builtWiki stores a manifest");
  store.putManifest({ ...manifest, sha: head });
  store.setHead(head);
  if (options.onDisk === true) store.close();
  return {
    repo,
    store,
    first,
    head,
    out,
    remove() {
      if (options.onDisk !== true) store.close();
      repo.remove();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const TEAM_ADA: TestAuthor = { name: "Ada Lovelace", email: "ada.q7pack@example.com" };
const TEAM_BOB: TestAuthor = { name: "Bob Smith", email: "bob@example.com" };
const TEAM_KIM: TestAuthor = { name: "Kim Filler", email: "kim@example.com" };

/** A small team's history, refreshed, for the pack, verify and write tests. Test-only. */
export interface TeamFixture {
  repo: TestRepo;
  store: Store;
  jan: string;
  a1: string;
  a2: string;
  pr3: string;
  b1: string;
  pr6: string;
  feb: string;
  manifest: Manifest;
  refreshed: Refreshed;
  remove(): void;
}

/** Ada: a January commit, PR #3 merged by Bob, a February commit; she merges Bob's PR #6. */
export async function teamFixture(): Promise<TeamFixture> {
  const repo = createTestRepo();
  const store = openStore(":memory:");
  repo.write("src/signals/ingest.py", "a = 1\n");
  const jan = repo.commit("feat: start signals", "+0100", TEAM_ADA);
  repo.git("switch", "-q", "-c", "topic");
  repo.write("src/signals/ingest.py", "a = 1\nb = 2\n");
  const a1 = repo.commit("feat: parse chunks", "+0100", TEAM_ADA);
  repo.write("src/deliverables/crud.py", "x = 1\n");
  const a2 = repo.commit("feat: store chunks, mail ada.q7pack@example.com", "+0100", TEAM_ADA);
  repo.git("switch", "-q", "main");
  const pr3 = repo.merge(
    "topic",
    "Merge pull request #3 from ada/topic\n\nAdd signal ingestion",
    TEAM_BOB,
  );
  repo.git("switch", "-q", "-c", "topic2");
  repo.write("src/deliverables/crud.py", "x = 2\n");
  const b1 = repo.commit("fix: crud", "+0000", TEAM_BOB);
  repo.git("switch", "-q", "main");
  const pr6 = repo.merge("topic2", "Merge pull request #6 from bob/topic2\n\nFix crud", TEAM_ADA);
  for (let i = 0; i < 30; i++) {
    repo.write("docs/filler.md", `${i}\n`);
    repo.commit(`docs: filler ${i}`, "+0000", TEAM_KIM);
  }
  repo.write("src/signals/ingest.py", "a = 1\nb = 3\n");
  const feb = repo.commit("fix: signals \u202E\u2028 edge", "+0100", TEAM_ADA);
  const manifest: Manifest = {
    sha: feb,
    features: [
      makeFeature({
        id: "signals",
        title: "Signal ingestion",
        aliases: [],
        lineage: [{ kind: "create", sha: jan }],
      }),
      makeFeature({
        id: "deliverables",
        title: "Deliverables",
        aliases: [],
        lineage: [{ kind: "create", sha: jan }],
      }),
    ],
    membership: {
      "src/signals/ingest.py": { featureId: "signals", weight: 1 },
      "src/deliverables/crud.py": { featureId: "deliverables", weight: 1 },
    },
  };
  store.putManifest(manifest);
  store.setHead(feb);
  const refreshed = await refreshPeople({
    repo: repo.dir,
    sha: feb,
    store,
    config: PeopleConfig.parse({}),
    ownerEmail: null,
  });
  return {
    repo,
    store,
    jan,
    a1,
    a2,
    pr3,
    b1,
    pr6,
    feb,
    manifest,
    refreshed,
    remove() {
      store.close();
      repo.remove();
    },
  };
}

const MONTH_NAMES = [
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

/**
 * A provider that answers every People call with a narrative that verifies: a lead naming the
 * pack's person and one dated chronicle claim per commit line of the pack (up to six), and
 * records each request. Test-only.
 */
export function chronicleProvider(): { provider: Provider; requests: GenerateRequest<unknown>[] } {
  const requests: GenerateRequest<unknown>[] = [];
  const provider: Provider = {
    async generate<T>(request: GenerateRequest<T>) {
      requests.push(request as GenerateRequest<unknown>);
      const turn = request.messages.at(-1)?.content ?? "";
      const name = /^# Person: (.+?)(?: \(other names:.*)?$/m.exec(turn)?.[1] ?? "Someone";
      const commits = [...turn.matchAll(/^- commit:([0-9a-f]{12}) (\d{4})-(\d{2})-(\d{2}) /gm)];
      const chronicle = commits.slice(0, 6).map((m, i) => ({
        id: `c${i + 1}`,
        text: `On ${Number(m[4])} ${MONTH_NAMES[Number(m[3]) - 1]} ${m[2]}, a change was made.`,
        cite: [`commit:${m[1]}`],
        supports: [],
      }));
      const output = {
        sections: [
          {
            key: "lead",
            claims: [
              {
                id: "l1",
                text: `**${name}** contributed to the repository.`,
                cite: [],
                supports: chronicle.map((c) => c.id),
              },
            ],
          },
          { key: "chronicle", claims: chronicle },
        ],
      };
      const usage = { in: 1000, out: 200, cacheRead: 0, cacheWrite: 0 };
      return { output: request.schema.parse(output), usage, model: "claude-haiku-4-5-20251001" };
    },
  };
  return { provider, requests };
}
