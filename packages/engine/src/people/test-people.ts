import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtWiki, CRUD_PY } from "../freshness/index.ts";
import type { TestAuthor, TestRepo } from "../index/index.ts";
import type { Store } from "../store/index.ts";

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
