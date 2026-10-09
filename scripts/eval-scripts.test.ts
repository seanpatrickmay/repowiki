import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRun, RESULTS_FILE, type RunInfo, type RunRecord } from "@repowiki/eval";
import { type SampleWiki, SMOKE_QUESTIONS, sampleWiki } from "@repowiki/eval/test-wiki";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BUILD_LOCK } from "./wiki-cli.ts";

let sample: SampleWiki;
let dir: string;
let out: string;
let smoke: string;
beforeAll(() => {
  sample = sampleWiki();
});
afterAll(() => sample.repo.remove());
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "repowiki-eval-")));
  out = join(dir, "wiki");
  mkdirSync(out);
  writeFileSync(join(out, "export.json"), JSON.stringify(sample.wiki));
  smoke = join(dir, "smoke-questions.json");
  copyFileSync(SMOKE_QUESTIONS, smoke);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Variables that steer a request off the machine or choose its credentials, in any case. */
const OUTBOUND_ENV =
  /^(ANTHROPIC_.*|(HTTP|HTTPS|ALL|NO)_PROXY|NODE_USE_ENV_PROXY|REPOWIKI_CASSETTE)$/i;

/** Runs a script with no API key and HOME in the scratch dir; nothing reaches the network. */
function run(script: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!OUTBOUND_ENV.test(name)) env[name] = value;
  }
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...env, HOME: dir },
  });
}

const evalRun = (...args: string[]) =>
  run("scripts/eval-run.ts", sample.repo.dir, "--out", out, ...args);

/** The author's file shape, 30 placeholder questions about the fixture: test data only. */
function exitFile(): string {
  const kinds = ["where", "how", "why", "what-changed"];
  const path = join(dir, "questions.json");
  const questions = Array.from({ length: 30 }, (_, i) => ({
    id: `q${String(i + 1).padStart(2, "0")}`,
    set: i < 20 ? "dev" : "held-out",
    kind: kinds[i % 4],
    question: `Placeholder question ${i + 1} about the sample fixture?`,
    reference: `Placeholder reference ${i + 1}.`,
  }));
  writeFileSync(
    path,
    JSON.stringify({ suite: "exit-criteria", repo: "sample", writtenOn: "2026-10-01", questions }),
  );
  return path;
}

describe("eval-run.ts as a process (no network)", () => {
  it("states the estimate on a dry run and writes nothing, with no key", () => {
    const result = evalRun("--questions", smoke, "--set", "smoke", "--dry-run");
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(
      /^3 questions to the wiki and repo agents: about \$\d+\.\d\d .*\(--max-usd\)\n$/,
    );
    expect(existsSync(join(out, "eval"))).toBe(false);
  });

  it("estimates the mcp agent on a dry run through a started server, writing nothing", () => {
    const before = readdirSync(out, { recursive: true }).sort();
    const result = evalRun("--questions", smoke, "--set", "smoke", "--agents", "mcp", "--dry-run");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(
      /^3 questions to the mcp agent: about \$\d+\.\d\d \(mcp \$\d+\.\d\d at 5 turns a question, no cache hits\), .*\(--max-usd\)\n$/,
    );
    expect(readdirSync(out, { recursive: true }).sort()).toEqual(before);
  }, 30_000);

  it("says on a dry run when the export records no build run, so the break-even would be unknown", () => {
    writeFileSync(join(out, "export.json"), JSON.stringify({ ...sample.wiki, runs: [] }));
    const result = evalRun("--questions", smoke, "--set", "smoke", "--dry-run");
    expect(result.status).toBe(0);
    const lines = result.stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      "export.json records no build run, so the report cannot state a break-even; re-run pnpm wiki:export to include build tokens first",
    );
  });

  it("names the pnpm command and --env-file when the key is missing, after the estimate", () => {
    const result = evalRun("--questions", smoke, "--set", "smoke");
    expect(result.status).toBe(1);
    const lines = result.stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("ANTHROPIC_API_KEY is not set");
    expect(lines[1]).toContain("pnpm eval:run");
    expect(lines[1]).toContain("scripts/eval-run.ts");
    expect(existsSync(join(out, BUILD_LOCK))).toBe(false);
    expect(existsSync(join(out, "eval"))).toBe(false);
  });

  it("refuses a question file inside the documented repository", () => {
    const inside = join(sample.repo.dir, "questions.json");
    copyFileSync(SMOKE_QUESTIONS, inside);
    try {
      const result = evalRun("--questions", inside, "--set", "smoke", "--dry-run");
      expect(result.status).toBe(2);
      expect(result.stderr).toBe(
        "the question file is inside the documented repository, where the repo agent could read it; keep it elsewhere\n",
      );
    } finally {
      rmSync(inside);
    }
  });

  it("refuses a --run-dir inside the documented repository before the estimate", () => {
    const inside = join(sample.repo.dir, "eval-run");
    const result = evalRun("--questions", smoke, "--set", "smoke", "--run-dir", inside);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe(
      "refusing to write inside the documented repository; choose a --run-dir path elsewhere\n",
    );
    expect(existsSync(inside)).toBe(false);
  });

  it("keeps every set but held-out out of the held-out set's directory", () => {
    const file = exitFile();
    const heldOut = join(out, "eval", "held-out");
    const result = evalRun("--questions", file, "--set", "dev", "--run-dir", heldOut, "--dry-run");
    expect(result.status).toBe(2);
    expect(result.stderr).toBe(
      `${heldOut} is the held-out set's run directory; choose another --run-dir for the dev set\n`,
    );
    expect(existsSync(join(out, "eval"))).toBe(false);
  });

  it("never runs the smoke file as an eval set, nor a file about another repository", () => {
    const asDev = evalRun("--questions", smoke, "--set", "dev", "--dry-run");
    expect(asDev.status).toBe(2);
    expect(asDev.stderr).toBe("this is the smoke question file; run it with --set smoke\n");
    const other = join(dir, "other.json");
    writeFileSync(
      other,
      readFileSync(smoke, "utf8").replace('"repo": "sample"', '"repo": "other"'),
    );
    const mismatch = evalRun("--questions", other, "--set", "smoke", "--dry-run");
    expect(mismatch.status).toBe(2);
    expect(mismatch.stderr).toBe(
      `the question file is about "other", but the wiki in ${out} is "sample"\n`,
    );
  });

  it("refuses to run the held-out set a second time once its run is complete", () => {
    const file = exitFile();
    const runDir = join(out, "eval", "held-out");
    const questions = JSON.parse(readFileSync(file, "utf8")).questions.slice(20);
    const info: RunInfo = {
      set: "held-out",
      repo: "sample",
      head: sample.sha,
      exportHash: "e".repeat(64),
      questionsHash: "f".repeat(64),
      writtenOn: "2026-10-01",
      turnLimit: 15,
      agents: ["wiki", "repo"],
      models: { evalAgent: "claude-haiku-4-5", evalJudge: "claude-haiku-4-5" },
      buildTokens: null,
      questions,
      startedAt: "2026-10-04T12:00:00.000Z",
    };
    openRun(runDir, info);
    const records: RunRecord[] = questions.flatMap((q: { id: string }) =>
      (["wiki", "repo"] as const).flatMap((agent): RunRecord[] => [
        {
          kind: "answer",
          questionId: q.id,
          agent,
          answer: "a",
          stop: "answered",
          turns: 1,
          calls: [],
          usage: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 },
          usd: 0,
          model: "m",
          at: info.startedAt,
        },
        {
          kind: "judgment",
          questionId: q.id,
          agent,
          score: 1,
          verdict: null,
          reason: "r",
          usage: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 },
          usd: 0,
          model: "m",
          batch: true,
          at: info.startedAt,
        },
      ]),
    );
    writeFileSync(
      join(runDir, RESULTS_FILE),
      records.map((r) => `${JSON.stringify(r)}\n`).join(""),
    );
    const result = evalRun("--questions", file, "--set", "held-out", "--dry-run");
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `the held-out set has run once already (begun 2026-10-04T12:00:00.000Z): its report is ${join(runDir, "report.md")}\n`,
    );
    // The dev set of the same file still runs (here, as a dry run).
    expect(evalRun("--questions", file, "--set", "dev", "--dry-run").status).toBe(0);
    // The held-out set is v1's: no other agent may spend it.
    const mcp = evalRun("--questions", file, "--set", "held-out", "--agents", "mcp", "--dry-run");
    expect(mcp.status).toBe(2);
    expect(mcp.stderr).toMatch(
      /^the held-out set is v1's single-use sign-off .* wiki,repo with it; usage: /,
    );

    const report = run("scripts/eval-report.ts", runDir);
    expect(report.status).toBe(0);
    expect(report.stdout).toBe(
      `wiki 10 of 10, repo 10 of 10\nWrote ${join(runDir, "report.md")}\n`,
    );
    expect(existsSync(join(runDir, "spot-check.json"))).toBe(true);
  });

  it("is a usage error, exit 2, for eval:report without a run directory", () => {
    const result = run("scripts/eval-report.ts");
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("usage: pnpm eval:report <run-dir>\n");
  });
});

describe("eval-accuracy.ts as a process (no network)", () => {
  const sheetPath = () => join(out, "eval", "accuracy-review.md");

  it("writes the review sheet for the named pages, and never over a sheet that exists", () => {
    const first = run(
      "scripts/eval-accuracy.ts",
      "sheet",
      sample.repo.dir,
      "--out",
      out,
      "deliverables",
    );
    expect(first.status).toBe(0);
    expect(first.stdout).toBe(`Wrote ${sheetPath()}: 3 claims to review\n`);
    writeFileSync(sheetPath(), readFileSync(sheetPath(), "utf8").replaceAll("- [ ]", "- [x]"));
    const again = run("scripts/eval-accuracy.ts", "sheet", sample.repo.dir, "--out", out);
    expect(again.status).toBe(2);
    expect(again.stderr).toBe(
      `${sheetPath()} exists and may hold your marks; move it aside to write a new sheet\n`,
    );
    const tally = run("scripts/eval-accuracy.ts", "tally", sheetPath());
    expect(tally.status).toBe(0);
    expect(tally.stdout).toBe(
      "Reviewed 3 claims, 0 false, 0 not reviewed: pass (spec §9 allows at most 1 false claim per 50 reviewed).\n",
    );
  });

  it("refuses a page the wiki does not have, and a mark it does not know", () => {
    const unknown = run(
      "scripts/eval-accuracy.ts",
      "sheet",
      sample.repo.dir,
      "--out",
      out,
      "kafka",
    );
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toBe("no page for kafka; the pages are deliverables, signals\n");
    const bad = join(dir, "sheet.md");
    writeFileSync(bad, "- [?] `signals/s-1` (Overview): x\n");
    const tally = run("scripts/eval-accuracy.ts", "tally", bad);
    expect(tally.status).toBe(2);
    expect(tally.stderr).toBe(`${bad}: line 1: mark a claim [x], [!] or [ ], not [?]\n`);
    expect(run("scripts/eval-accuracy.ts").status).toBe(2);
  });
});

describe("the issue templates for the author's reviews", () => {
  it("label a false claim accuracy, and ask a rabbit-hole session for five hops", () => {
    const accuracy = readFileSync(".github/ISSUE_TEMPLATE/accuracy.yml", "utf8");
    expect(accuracy).toContain('labels: ["accuracy", "v1", "area:eval"]');
    const rabbit = readFileSync(".github/ISSUE_TEMPLATE/rabbit-hole.yml", "utf8");
    expect(rabbit).toContain('value: "1. \\n2. \\n3. \\n4. \\n5. \\n"');
  });
});
