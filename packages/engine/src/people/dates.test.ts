import { PeopleConfig, PeopleSnapshot } from "@repowiki/core";
import { afterEach, expect, it, vi } from "vitest";
import { configuredEmail, readHistory } from "../index/index.ts";
import { refreshPeople } from "./refresh.ts";
import { type PeopleFixture, peopleFixture } from "./test-people.ts";

// The Task 37 re-review's probe (rr37-probes/probe-i3): crafted author and committer dates on
// commits below the head never stop People, whatever reaches a schema (the I3 residual ruling).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let fx: PeopleFixture;
afterEach(() => fx.remove());

/** A commit object on `parent` (and `extra`), with a crafted author and committer stamp. */
function craft(
  parent: string,
  who: string,
  author: string,
  committer: string,
  subject: string,
  extra?: string,
): string {
  const body = fx.repo
    .git("cat-file", "commit", parent)
    .replace(/^parent .*\n/gm, "")
    .replace(
      /^(tree .*)$/m,
      `$1\nparent ${parent}${extra === undefined ? "" : `\nparent ${extra}`}`,
    )
    .replace(/^author .*$/m, `author ${who} ${author}`)
    .replace(/^(committer .*>) \d+ [+-]\d{4}$/m, `$1 ${committer}`)
    .split("\n\n")[0];
  fx.repo.write(".git/crafted", `${body}\n\n${subject}\n`);
  return fx.repo.git("hash-object", "--literally", "-t", "commit", "-w", ".git/crafted");
}

const refresh = (sha: string) =>
  refreshPeople({
    repo: fx.repo.dir,
    sha,
    store: fx.store,
    config: PeopleConfig.parse({}),
    ownerEmail: configuredEmail(fx.repo.dir),
    lock: null,
  });

it("reads a year-10000 author date with a +9959 committer offset below the head", async () => {
  fx = await peopleFixture();
  const both = craft(
    fx.head,
    "Both <both.q7@example.com>",
    "253402300800 +0000",
    "1767225600 +9959",
    "crafted",
  );
  const top = craft(
    both,
    "Ada Lovelace <ada.q7private@example.com>",
    "1767225800 +0000",
    "1767225800 +0000",
    "top",
  );
  readHistory(fx.repo.dir, top);
  const { snapshot } = await refresh(top);
  expect(PeopleSnapshot.safeParse(snapshot).success).toBe(true);
  const person = snapshot.people.find((p) => p.name === "Both");
  expect(person?.commits).toBe(1);
  expect(person?.activity).toEqual([]);
  expect(person?.firstCommit).toMatch(/\+00:00$/);
});

it("reads an undated pull request merge with a +9959 committer offset", async () => {
  fx = await peopleFixture();
  const side = craft(
    fx.head,
    "Pat <pat.q7@example.com>",
    "1767225600 +0000",
    "1767225600 +0000",
    "feat: pat (#77)",
  );
  const merge = craft(
    fx.head,
    "Mer <mer.q7@example.com>",
    "253402300800 +0000",
    "1767225700 +9959",
    "Merge pull request #77 from x/y",
    side,
  );
  const { snapshot } = await refresh(merge);
  expect(PeopleSnapshot.safeParse(snapshot).success).toBe(true);
  const pat = snapshot.people.find((p) => p.name === "Pat");
  expect(pat?.prsAuthored[0]?.mergedAt).toMatch(/\+00:00$/);
});
