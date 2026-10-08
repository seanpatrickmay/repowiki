import type { GenerateRequest, Provider } from "@repowiki/llm";
import { LlmOutputError } from "@repowiki/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PersonDraft, PersonFixes } from "./prompt.ts";
import { type TeamFixture, teamFixture } from "./test-people.ts";
import { type PersonRequest, personRequest, writePeople } from "./write.ts";

let fx: TeamFixture;
beforeAll(async () => {
  fx = await teamFixture();
});
afterAll(() => fx.remove());

type Answer = PersonDraft | PersonFixes | Error;

/** Answers People calls in order, and remembers each request with its event-loop turn. */
function provider(answers: Answer[]) {
  const requests: (GenerateRequest<unknown> & { turn: number })[] = [];
  let turn = 0;
  let ticking = false;
  const p: Provider = {
    async generate<T>(request: GenerateRequest<T>) {
      if (!ticking) {
        ticking = true;
        setImmediate(() => {
          turn += 1;
          ticking = false;
        });
      }
      requests.push({ ...(request as GenerateRequest<unknown>), turn });
      const answer = answers[requests.length - 1];
      await new Promise((resolve) => setImmediate(resolve));
      if (answer === undefined) throw new Error("no answer scripted");
      if (answer instanceof Error) throw answer;
      const usage = { in: 100, out: 10, cacheRead: 0, cacheWrite: 0 };
      return { output: request.schema.parse(answer), usage, model: "claude-haiku-4-5-20251001" };
    },
  };
  return { provider: p, requests };
}

const c = (sha: string) => `commit:${sha.slice(0, 12)}`;
/** A narrative of Ada that verifies cleanly. */
const draft = (): PersonDraft => ({
  sections: [
    {
      key: "lead",
      claims: [
        {
          id: "l1",
          text: "**Ada Lovelace** contributed between January and February 2026, to signal ingestion and [[deliverables]].",
          cite: [],
          supports: ["c1", "c2", "a1"],
        },
      ],
    },
    {
      key: "chronicle",
      claims: [
        {
          id: "c1",
          text: "In January 2026, signal ingestion was started.",
          cite: [c(fx.jan)],
          supports: [],
        },
        {
          id: "c2",
          text: "Between 3 January 2026 and 4 January 2026, chunk parsing and storage were added.",
          cite: [c(fx.a1), c(fx.a2)],
          supports: [],
        },
        {
          id: "c3",
          text: "On 7 February 2026, an edge case in signals was fixed.",
          cite: [c(fx.feb)],
          supports: [],
        },
      ],
    },
    {
      key: "areas",
      claims: [
        {
          id: "a1",
          text: "[[signals|Signal ingestion]]: the commits started and parsed chunks.",
          cite: [c(fx.jan), c(fx.a1)],
          supports: [],
        },
        {
          id: "a2",
          text: "[[deliverables]]: a commit stored chunks.",
          cite: [c(fx.a2)],
          supports: [],
        },
      ],
    },
  ],
});

const request = (options: Partial<Parameters<typeof personRequest>[3]> = {}): PersonRequest => {
  const r = personRequest(fx.refreshed, "ada-lovelace", fx.manifest, {
    parent: null,
    append: false,
    ...options,
  });
  if (r === null) throw new Error("Ada has a request");
  return r;
};
const write = (answers: Answer[], requests = [request()]) => {
  const p = provider(answers);
  const log: string[] = [];
  return writePeople(
    { requests, manifest: fx.manifest, sha: fx.refreshed.sha, commitDate: "2026-02-07T00:00:00Z" },
    {
      provider: p.provider,
      repoName: "demo",
      log: (l) => log.push(l),
      now: () => new Date("2026-10-06T12:00:00Z"),
    },
  ).then((outcomes) => ({ outcomes, requests: p.requests, log }));
};

describe("writePeople (spec v2 #6 §8.4)", () => {
  it("writes a verified, linked narrative revision from one batched call", async () => {
    const { outcomes, requests } = await write([draft()]);
    const [ada] = outcomes;
    expect(ada?.failure).toBeNull();
    const revision = ada?.revision;
    expect(revision).toMatchObject({
      id: `person-ada-lovelace-${fx.feb.slice(0, 12)}-1`,
      personId: "ada-lovelace",
      parentId: null,
      reason: "build",
      basis: fx.feb,
    });
    expect(revision?.sections.map((s) => [s.key, s.claims.length])).toEqual([
      ["lead", 1],
      ["chronicle", 3],
      ["areas", 2],
    ]);
    // The commit subject is stored without its email.
    const subjects = revision?.sections.flatMap((s) =>
      s.claims.flatMap((cl) => cl.citations.map((x) => (x.kind === "commit" ? x.subject : ""))),
    );
    expect(subjects).toContain("feat: store chunks, mail [email]");
    expect(JSON.stringify(revision)).not.toContain("q7pack");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ purpose: "people", featureId: null, batch: true });
    // One call, and a short prompt: no cache key (R-cache).
    expect(requests[0]?.cacheKey).toBeUndefined();
  });

  it("retries the failing claims once in a second batch, and drops what fails twice", async () => {
    const bad = draft();
    const chronicle = bad.sections[1];
    chronicle?.claims.push({
      id: "c4",
      text: "In 2025, 12 commits landed.",
      cite: [c(fx.feb)],
      supports: [],
    });
    chronicle?.claims.push({
      id: "c5",
      text: "Bob Smith reviewed it in February 2026.",
      cite: [c(fx.feb)],
      supports: [],
    });
    const fixes: PersonFixes = {
      claims: [
        {
          id: "c4",
          text: "In February 2026, a signals edge case was found.",
          cite: [c(fx.feb)],
          supports: [],
        },
        {
          id: "c5",
          text: "With Kim Filler, in February 2026, it was fixed.",
          cite: [c(fx.feb)],
          supports: [],
        },
      ],
    };
    const { outcomes, requests, log } = await write([bad, fixes]);
    expect(requests.map((r) => r.turn)).toEqual([0, 1]);
    expect(requests[1]?.messages.at(-1)?.content).toContain('"c4"');
    const ada = outcomes[0];
    expect(ada?.revision?.sections[1]?.claims.map((x) => x.text)).toEqual([
      "In January 2026, signal ingestion was started.",
      "Between 3 January 2026 and 4 January 2026, chunk parsing and storage were added.",
      "On 7 February 2026, an edge case in signals was fixed.",
      "In February 2026, a signals edge case was found.",
    ]);
    expect(ada?.dropped).toEqual([
      {
        section: "chronicle",
        problems: ["the claim names another person; name no one but the page's subject"],
      },
    ]);
    expect(log.join("\n")).not.toMatch(/Bob|Kim/);
    expect(ada?.calls).toBe(2);
  });

  it("asks again for a whole answer that has no lead, and fails a person whose call fails", async () => {
    const noLead: PersonDraft = { sections: draft().sections.slice(1) };
    const again = await write([noLead, draft()]);
    expect(again.outcomes[0]?.revision).not.toBeNull();
    expect(again.requests[1]?.messages.at(-1)?.content).toContain("needs at least one lead claim");
    const failed = await write([new Error("network down")]);
    expect(failed.outcomes[0]).toMatchObject({ revision: null, callFailed: true });
    expect(failed.outcomes[0]?.failure).toBe("the people call failed: Error");
    const unusable = await write([
      new LlmOutputError("bad json", "{"),
      new LlmOutputError("bad json", "{"),
    ]);
    expect(unusable.outcomes[0]).toMatchObject({ revision: null, callFailed: false });
  });

  it("appends: keeps the stored chronicle word for word and asks only for new episodes (R25)", async () => {
    const built = (await write([draft()])).outcomes[0]?.revision ?? null;
    if (built === null) throw new Error("built");
    // A parent whose basis is the PR #6 merge: only February's episode is new.
    const parent = {
      ...built,
      basis: fx.pr6,
      sections: built.sections.map((s) =>
        s.key === "chronicle" ? { ...s, claims: s.claims.slice(0, 2) } : s,
      ),
    };
    const appended: PersonDraft = {
      sections: [
        {
          key: "lead",
          claims: [
            {
              id: "l1",
              text: "**Ada Lovelace** contributed in 2026.",
              cite: [],
              supports: ["c2", "n1"],
            },
          ],
        },
        {
          key: "chronicle",
          claims: [
            {
              id: "n1",
              text: "On 7 February 2026, a signals edge was fixed.",
              cite: [c(fx.feb)],
              supports: [],
            },
          ],
        },
        {
          key: "areas",
          claims: [
            {
              id: "a1",
              text: "[[signals]]: a commit fixed an edge.",
              cite: [c(fx.feb)],
              supports: [],
            },
          ],
        },
      ],
    };
    const { outcomes, requests } = await write([appended], [request({ parent, append: true })]);
    const revision = outcomes[0]?.revision;
    expect(outcomes[0]?.failure).toBeNull();
    expect(revision).toMatchObject({
      reason: "update",
      parentId: built.id,
      id: `person-ada-lovelace-${fx.feb.slice(0, 12)}-2`,
    });
    const texts = revision?.sections.find((s) => s.key === "chronicle")?.claims.map((x) => x.text);
    expect(texts).toEqual([
      ...(parent.sections.find((s) => s.key === "chronicle")?.claims.map((x) => x.text) ?? []),
      "On 7 February 2026, a signals edge was fixed.",
    ]);
    const turn = requests[0]?.messages[0]?.content ?? "";
    expect(turn).toContain("# Stored chronicle (kept word for word; do not repeat it)");
    expect(turn).toContain("## New episodes, oldest first");
    expect(turn).not.toContain("PR #3");
  });
});
