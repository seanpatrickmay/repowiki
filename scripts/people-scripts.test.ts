import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makePersonRevision } from "@repowiki/core/test-fixtures";
import { openStore } from "@repowiki/engine";
import { listing } from "@repowiki/engine/test-inflight";
import {
  KIM,
  PEOPLE_SECRETS,
  type PeopleFixture,
  peopleFixture,
} from "@repowiki/engine/test-people";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each test builds a fixture wiki and runs the command as a process: seconds on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SUGGEST = fileURLToPath(new URL("./people-suggest.ts", import.meta.url));
const PEOPLE = fileURLToPath(new URL("./wiki-people.ts", import.meta.url));
const CHECK = fileURLToPath(new URL("./wiki-check.ts", import.meta.url));
const EXPORT = fileURLToPath(new URL("./wiki-export.ts", import.meta.url));
const ACCURACY = fileURLToPath(new URL("./eval-accuracy.ts", import.meta.url));

let fx: PeopleFixture;
beforeEach(async () => {
  fx = await peopleFixture({ onDisk: true });
});
afterEach(() => fx.remove());

/** The command as a process with no API key: no test reaches the network. */
const run = (script: string, ...argv: string[]) =>
  spawnSync(process.execPath, [script, fx.repo.dir, "--out", fx.out, ...argv], {
    encoding: "utf8",
    env: { ...process.env, ANTHROPIC_API_KEY: "" },
  });
const scan = (texts: string[]) => {
  for (const text of texts) for (const secret of PEOPLE_SECRETS) expect(text).not.toContain(secret);
};

describe("pnpm people:suggest (spec v2 #6 §6 step 6)", () => {
  it("prints the people with masked emails only, and writes neither the store nor the repo", () => {
    const db = readFileSync(join(fx.out, "wiki.db"));
    const repo = listing(fx.repo.dir);
    const result = run(SUGGEST);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("`a…@example.com`");
    expect(result.stdout).toContain("`ada-lovelace`");
    for (const secret of PEOPLE_SECRETS)
      expect(result.stdout + result.stderr).not.toContain(secret);
    expect(readFileSync(join(fx.out, "wiki.db")).equals(db)).toBe(true);
    expect(listing(fx.repo.dir)).toEqual(repo);
  });

  it("never prints an address, not even a name that is one, and keeps its scratch copy in the out dir", () => {
    // Kim committed once with her address as her name; "kimh" is a handle suggested for her.
    fx.repo.write("docs/kim.md", "kim\n");
    fx.repo.commit("docs: kim", "+0000", { name: KIM.email, email: KIM.email });
    fx.repo.write("docs/more.md", "more\n");
    const head = fx.repo.commit("docs: more", "+0000", {
      name: "kimh",
      email: "kimh.q7other@example.com",
    });
    const store = openStore(join(fx.out, "wiki.db"));
    const manifest = store.getLatestManifest();
    if (manifest === null) throw new Error("the fixture stores a manifest");
    store.putManifest({ ...manifest, sha: head });
    store.setHead(head);
    store.close();
    const tmp = join(fx.out, "..", "tmp");
    mkdirSync(tmp);
    const result = spawnSync(process.execPath, [SUGGEST, fx.repo.dir, "--out", fx.out], {
      encoding: "utf8",
      env: { ...process.env, ANTHROPIC_API_KEY: "", TMPDIR: tmp },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("`k…@example.com`");
    expect(result.stdout).toContain("A name of kim-hidden gives no name key");
    scan([result.stdout, result.stderr]);
    expect(result.stdout + result.stderr).not.toContain("q7other");
    expect(readdirSync(tmp)).toEqual([]);
    expect(readdirSync(fx.out).filter((f) => f.startsWith(".people-scratch-"))).toEqual([]);
  });

  it("refuses a people file that is a broken link, or unreadable, with exit 2", () => {
    symlinkSync(join(fx.out, "gone.json"), join(fx.out, "people.json"));
    const broken = run(SUGGEST);
    expect(broken.status).toBe(2);
    expect(broken.stderr).toMatch(/people file .* is a broken link/);
    const locked = join(fx.out, "locked.json");
    writeFileSync(locked, "{}");
    chmodSync(locked, 0o000);
    const unreadable = run(SUGGEST, "--people-file", locked);
    chmodSync(locked, 0o600);
    expect(unreadable.status).toBe(2);
    expect(unreadable.stderr).toMatch(/cannot read the people file/);
  });

  it("refuses a people file inside the repository with exit 2", () => {
    const result = run(SUGGEST, "--people-file", join(fx.repo.dir, "people.json"));
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/inside the documented repository/);
  });

  it("refuses an out dir with no wiki", () => {
    const result = spawnSync(
      process.execPath,
      [SUGGEST, fx.repo.dir, "--out", join(fx.out, "empty")],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/run pnpm wiki:build first/);
  });
});

describe("pnpm wiki:people (spec v2 #6 §10)", () => {
  it("turns People on with facts only, and leaks no email anywhere it writes", () => {
    const repo = listing(fx.repo.dir);
    const result = run(PEOPLE, "--no-narrative");
    expect(result.status).toBe(0);
    const exported = readFileSync(join(fx.out, "export.json"), "utf8");
    const llms = readFileSync(join(fx.out, "llms.txt"), "utf8");
    const summary = readFileSync(join(fx.out, `people-${fx.head.slice(0, 7)}.md`), "utf8");
    expect(JSON.parse(exported).people.snapshot.sha).toBe(fx.head);
    expect(summary).toContain(
      "| `ada-lovelace` | `Ada Lovelace` | 3 | skipped (--no-narrative) | 0 |",
    );
    expect(summary).toContain("This run: no LLM call made.");
    scan([exported, llms, summary, result.stdout, result.stderr]);
    expect(listing(fx.repo.dir)).toEqual(repo);
  });

  it("fails once, before any call, when a narrative is due and there is no key", () => {
    const result = run(PEOPLE);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/ANTHROPIC_API_KEY is not set: pnpm wiki:people/);
    expect(result.stderr).toMatch(/1 narrative due; 1 within the \$1\.0000 ceiling/);
  });

  it("prints the table and the estimate for a dry run, and leaves the store as it was", () => {
    const db = readFileSync(join(fx.out, "wiki.db"));
    const result = run(PEOPLE, "--dry-run");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("| `ada-lovelace` | `Ada Lovelace` | 3 | due (missing) | 0 |");
    expect(readFileSync(join(fx.out, "wiki.db")).equals(db)).toBe(true);
    expect(existsSync(join(fx.out, "export.json"))).toBe(false);
  });

  it("turns People off with --disable, and forgets a person by match key, printing counts only", () => {
    expect(run(PEOPLE, "--no-narrative").status).toBe(0);
    const forgot = run(PEOPLE, "--forget", "name:Kim Hidden");
    expect(forgot.status).toBe(0);
    expect(forgot.stdout).toMatch(/^Forgot 1 person \(0 narrative revisions\)/);
    expect(forgot.stdout).not.toContain("kim");
    const store = openStore(join(fx.out, "wiki.db"));
    try {
      expect(store.listPeopleRegistry().map((r) => r.id)).not.toContain("kim-hidden");
    } finally {
      store.close();
    }
    const off = run(PEOPLE, "--disable");
    expect(off.status).toBe(0);
    expect(JSON.parse(readFileSync(join(fx.out, "export.json"), "utf8")).people).toBeNull();
  });

  it("needs a built wiki, with exit 2", () => {
    const result = spawnSync(
      process.execPath,
      [PEOPLE, fx.repo.dir, "--out", join(fx.out, "none")],
      {
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/run pnpm wiki:build first/);
  });
});

describe("pnpm wiki:check's People half (spec v2 #6 §9)", () => {
  it("scans the outputs for an author's email, naming the file and never the address", () => {
    expect(run(PEOPLE, "--no-narrative").status).toBe(0);
    // The fixture's About article cites a made-up sha, so wiki:check exits 1 for it already;
    // People adds no problem of its own.
    const clean = run(CHECK);
    expect(clean.stderr).not.toContain("email");
    expect(clean.stdout).toMatch(
      /0 person narratives re-verified and 3 files scanned for an author's email; no problems/,
    );
    const llms = join(fx.out, "llms.txt");
    writeFileSync(llms, `${readFileSync(llms, "utf8")}\nContact: KIM.q7hidden@example.com\n`);
    const leaked = run(CHECK);
    expect(leaked.status).toBe(1);
    expect(leaked.stderr).toContain("llms.txt holds an author's email address");
    scan([leaked.stdout, leaked.stderr]);
    // A fullwidth at sign is the same address once normalised (the Task 28 ruling).
    const exported = join(fx.out, "export.json");
    writeFileSync(llms, readFileSync(llms, "utf8").replace("KIM.q7hidden@example.com", ""));
    writeFileSync(exported, `${readFileSync(exported, "utf8")}\n kim.q7hidden\uFF20example.com\n`);
    const fullwidth = run(CHECK);
    expect(fullwidth.stderr).toContain("export.json holds an author's email address");
    expect(fullwidth.stderr).not.toContain("llms.txt holds");
  });
});

describe("pnpm wiki:check with People off (the I4 ruling, C4)", () => {
  it("runs no People half: a broken people file and a quoted address change nothing", () => {
    expect(run(EXPORT).status).toBe(0);
    const before = run(CHECK);
    expect(before.stdout).not.toContain("person narratives");
    // A v1 export whose cited subject quotes an author's address, and a broken people file.
    const llms = join(fx.out, "llms.txt");
    writeFileSync(llms, `${readFileSync(llms, "utf8")}\nContact: ${KIM.email}\n`);
    writeFileSync(join(fx.out, "people.json"), "{ not json");
    const after = run(CHECK);
    expect([after.status, after.stdout, after.stderr]).toEqual([
      before.status,
      before.stdout,
      before.stderr,
    ]);
  });
});

describe("the remembered people file (the C1 ruling)", () => {
  it("is read by wiki:people and wiki:check, and a lost one undoes nothing", () => {
    const team = join(fx.out, "..", "team-people.json");
    writeFileSync(team, JSON.stringify({ exclude: [`email:${KIM.email}`] }));
    const ids = () =>
      JSON.parse(readFileSync(join(fx.out, "export.json"), "utf8")).people.snapshot.people.map(
        (p: { id: string }) => p.id,
      );
    expect(run(PEOPLE, "--no-narrative", "--people-file", team).status).toBe(0);
    expect(ids()).not.toContain("kim-hidden");
    // No flag: the file wiki:people was given, not <out>/people.json.
    expect(run(PEOPLE, "--no-narrative").status).toBe(0);
    expect(ids()).not.toContain("kim-hidden");
    expect(run(CHECK).stderr).not.toContain("people file");
    rmSync(team);
    const check = run(CHECK);
    expect(check.status).toBe(1);
    expect(check.stderr).toMatch(/people file: the people file .*team-people\.json is missing/);
    const people = run(PEOPLE, "--no-narrative");
    expect(people.status).toBe(2);
    expect(people.stderr).toMatch(
      /team-people\.json is missing; restore it or run pnpm wiki:people/,
    );
    expect(ids()).not.toContain("kim-hidden");
    scan([check.stdout, check.stderr, people.stdout, people.stderr]);
  });
});

describe("pnpm eval:accuracy sheet --person (spec v2 #6 §15.4)", () => {
  it("writes a sheet of a person's narrative claims, and refuses a person with none", () => {
    expect(run(PEOPLE, "--no-narrative").status).toBe(0);
    const store = openStore(join(fx.out, "wiki.db"));
    try {
      store.putPersonRevision(
        makePersonRevision({ sha: fx.head, id: `person-ada-lovelace-${fx.head.slice(0, 12)}-1` }),
      );
    } finally {
      store.close();
    }
    expect(run(EXPORT).status).toBe(0);
    const sheet = spawnSync(
      process.execPath,
      [ACCURACY, "sheet", fx.repo.dir, "--out", fx.out, "--person", "ada-lovelace"],
      { encoding: "utf8" },
    );
    expect(sheet.status).toBe(0);
    const text = readFileSync(join(fx.out, "eval", "accuracy-review.md"), "utf8");
    expect(text).toContain("## Person: Ada Lovelace (people/ada-lovelace)");
    scan([text, sheet.stdout, sheet.stderr]);
    const none = spawnSync(
      process.execPath,
      [ACCURACY, "sheet", fx.repo.dir, "--out", fx.out, "--person", "bob"],
      { encoding: "utf8" },
    );
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('no narrative for "bob"; the people with one are ada-lovelace');
  });
});
