import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMOKE_QUESTIONS } from "@repowiki/eval/test-wiki";
import { type SampleWiki, sampleWiki } from "@repowiki/query/test-wiki";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = "scripts/ask-eval.ts";
const PROCESS_TIMEOUT_MS = 30_000;

let sample: SampleWiki;
let out: string;
beforeAll(() => {
  sample = sampleWiki();
  out = mkdtempSync(join(tmpdir(), "repowiki-ask-eval-out-"));
  writeFileSync(join(out, "export.json"), JSON.stringify(sample.wiki));
});
afterAll(() => {
  sample.repo.remove();
  rmSync(out, { recursive: true, force: true });
});

const keyless = () => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("ANTHROPIC_")) delete env[name];
  return env;
};
const run = (args: readonly string[]) =>
  spawnSync(process.execPath, [SCRIPT, sample.repo.dir, "--out", out, ...args], {
    env: keyless(),
    encoding: "utf8",
    timeout: PROCESS_TIMEOUT_MS,
  });

describe("ask-eval.ts as a process (no network)", () => {
  it(
    "states its estimate on a dry run of the smoke set, and makes no call and writes nothing",
    () => {
      const result = run(["--questions", SMOKE_QUESTIONS, "--set", "smoke", "--dry-run"]);
      expect(result.status).toBe(0);
      expect(result.stderr.trim().split("\n")).toHaveLength(1);
      expect(result.stderr).toMatch(/^3 smoke questions through the ask: about \$0\.\d\d /);
      expect(existsSync(join(out, "eval"))).toBe(false);
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    "refuses the held-out set with exit 2, and a run without a key with exit 1",
    () => {
      const heldOut = run(["--questions", SMOKE_QUESTIONS, "--set", "held-out"]);
      expect(heldOut.status).toBe(2);
      expect(heldOut.stderr).toContain("never runs the held-out set");
      const keylessRun = run(["--questions", SMOKE_QUESTIONS, "--set", "smoke"]);
      expect(keylessRun.status).toBe(1);
      expect(keylessRun.stderr).toContain("ANTHROPIC_API_KEY is not set: pnpm ask:eval");
      expect(existsSync(join(out, "eval"))).toBe(false);
    },
    PROCESS_TIMEOUT_MS,
  );

  it(
    "refuses a question file about another repository",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "repowiki-ask-eval-q-"));
      try {
        const file = join(dir, "q.json");
        writeFileSync(
          file,
          JSON.stringify({
            suite: "smoke",
            repo: "other",
            questions: [{ id: "a", set: "smoke", kind: "where", question: "Q?", reference: "R." }],
          }),
        );
        const result = run(["--questions", file, "--set", "smoke", "--dry-run"]);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain('the question file is about "other"');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    PROCESS_TIMEOUT_MS,
  );
  it(
    "counts a marked support sheet with tally, and refuses a file that is not one",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "repowiki-ask-eval-tally-"));
      try {
        const sheet = join(dir, "support.md");
        writeFileSync(
          sheet,
          [
            "## Support",
            '- [x] `support/s01` (sentence): A. \u2014 cites "a" (P)',
            '- [!] `support/s02` (sentence): B. \u2014 cites "b" (P)',
            "## Routing",
            "- [x] `routing/q-1` (question): Q? \u2014 first source: P (/wiki/p/)",
            "",
          ].join("\n"),
        );
        writeFileSync(
          join(dir, "support-entries.json"),
          JSON.stringify({ support: ["support/s01", "support/s02"], routing: ["routing/q-1"] }),
        );
        const tally = (file: string) =>
          spawnSync(process.execPath, [SCRIPT, "tally", file], {
            env: keyless(),
            encoding: "utf8",
            timeout: PROCESS_TIMEOUT_MS,
          });
        const counted = tally(sheet);
        expect(counted.status).toBe(0);
        expect(counted.stdout).toBe(
          [
            "support: 1 of 2 supported by their cited claims, 1 not, 0 unmarked: does not pass",
            "routing: 1 of 1 routed to the right first page, 0 not, 0 unmarked: passes",
            "",
          ].join("\n"),
        );
        writeFileSync(sheet, "# notes\n");
        const refused = tally(sheet);
        expect(refused.status).toBe(2);
        expect(refused.stderr).toContain('no "## Routing" section');
        rmSync(join(dir, "support-entries.json"));
        const unrecorded = tally(sheet);
        expect(unrecorded.status).toBe(2);
        expect(unrecorded.stderr).toContain("no support-entries.json beside");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    PROCESS_TIMEOUT_MS,
  );
});
