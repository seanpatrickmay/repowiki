import { codeCitation } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  type ArchitectureContext,
  type ArchitectureDraftClaim,
  verifyArchitectureClaim,
} from "./architecture.ts";
import { testContext } from "./test-context.ts";

/** The pack showed lines 10-24 of ingest.py and nothing else. */
const shown = new Map([
  ["src/signals/ingest.py", new Set(Array.from({ length: 15 }, (_, i) => i + 10))],
]);
const ctx: ArchitectureContext = {
  ...testContext(),
  pages: new Set(["signals", "deliverables"]),
  shown,
};
const NOT_SHOWN =
  "which the pack did not show; cite only lines the pack numbers or gives for an edge, or name the feature page instead";

const draft = (overrides: Partial<ArchitectureDraftClaim> = {}): ArchitectureDraftClaim => ({
  id: "y1",
  text: "Ingestion sits in the API layer.",
  cite: ["src/signals/ingest.py:10-24"],
  pages: [],
  supports: [],
  ...overrides,
});

describe("verifyArchitectureClaim", () => {
  it("resolves a cited claim to a fact claim with the hashed citation and no hook", () => {
    expect(verifyArchitectureClaim("layers", draft(), ctx)).toEqual({
      claim: {
        id: "y1",
        text: "Ingestion sits in the API layer.",
        kind: "fact",
        citations: [codeCitation()],
        supports: [],
        pages: [],
        staleSince: null,
        hook: false,
      },
      problems: [],
    });
  });

  it("refuses a code citation of a line the pack did not show, in a file it showed or not", () => {
    expect(
      verifyArchitectureClaim("layers", draft({ cite: ["src/signals/ingest.py:20-25"] }), ctx),
    ).toEqual({
      claim: null,
      problems: [`the claim cites "src/signals/ingest.py" lines 20-25, ${NOT_SHOWN}`],
    });
    expect(
      verifyArchitectureClaim("layers", draft(), { ...ctx, shown: new Map() }).problems,
    ).toEqual([`the claim cites "src/signals/ingest.py" lines 10-24, ${NOT_SHOWN}`]);
  });

  it("names an edge copied into a citation, showing the path and line to cite instead", () => {
    const problem = (cite: string, example: string) =>
      `citation ${JSON.stringify(cite)} names an edge, not a line; cite only the path and line, e.g. ${JSON.stringify(example)}`;
    const cases: [string, string][] = [
      ["signals -> deliverables:src/signals/ingest.py:12", "src/signals/ingest.py:12"],
      ["deliverables:src/signals/ingest.py:12", "src/signals/ingest.py:12"],
      ["signals -> deliverables: src/signals/ingest.py:12-14", "src/signals/ingest.py:12-14"],
      ["signals -> deliverables", "src/app.py:12"],
    ];
    for (const [cite, example] of cases) {
      expect(verifyArchitectureClaim("dependencies", draft({ cite: [cite] }), ctx), cite).toEqual({
        claim: null,
        problems: [problem(cite, example)],
      });
    }
  });

  it("still resolves a top-level file whose name is a feature id", () => {
    const sources = new Map([...ctx.sources, ["signals", "a\nb\n"]]);
    const seen = new Map([...shown, ["signals", new Set([1, 2])]]);
    const result = verifyArchitectureClaim("layers", draft({ cite: ["signals:1-2"] }), {
      ...ctx,
      sources,
      shown: seen,
    });
    expect(result.problems).toEqual([]);
  });

  it("accepts a claim backed by pages of this build alone, trimmed and named once", () => {
    const result = verifyArchitectureClaim(
      "dependencies",
      draft({ cite: [], pages: [" signals", "signals", "deliverables"] }),
      ctx,
    );
    expect(result.problems).toEqual([]);
    expect(result.claim?.pages).toEqual(["signals", "deliverables"]);
    expect(result.claim?.citations).toEqual([]);
  });

  it("refuses a page that is not a page of this build, quoting the model's id", () => {
    const result = verifyArchitectureClaim(
      "dependencies",
      draft({ cite: [], pages: ["ghost\u202e", "signals"] }),
      ctx,
    );
    expect(result).toEqual({
      claim: null,
      problems: ['the claim names "ghost\\u202e", which is not a feature page of this wiki'],
    });
  });

  it("refuses more than three pages", () => {
    const pages = new Set(["a", "b", "c", "d"]);
    const result = verifyArchitectureClaim(
      "layers",
      draft({ cite: [], pages: ["a", "b", "c", "d"] }),
      { ...ctx, pages },
    );
    expect(result.problems).toEqual(["the claim names more than 3 pages; name the closest ones"]);
  });

  it("refuses a body claim with no citation and no page, and a request path with pages only", () => {
    expect(verifyArchitectureClaim("layers", draft({ cite: [] }), ctx).problems).toEqual([
      "body claims need a citation or a feature page",
    ]);
    expect(
      verifyArchitectureClaim("request-paths", draft({ cite: [], pages: ["signals"] }), ctx)
        .problems,
    ).toEqual(["request-path claims need a code or commit citation"]);
  });

  it("checks the text and the references as a feature page's claims are checked", () => {
    const result = verifyArchitectureClaim(
      "layers",
      draft({
        text: "See src/signals/ingest.py:10-24 for <b>details</b>.",
        cite: ["src/signals/ingest.py:900-901"],
      }),
      ctx,
    );
    expect(result.claim).toBeNull();
    expect(result.problems).toEqual([
      "the claim uses markup outside **bold**, *italic*, `code` and [[links]]: an HTML tag",
      'the claim text holds a citation ("src/signals/ingest.py:10-24"); citations go only in "cite", never in the text',
      'citation "src/signals/ingest.py:900-901" is outside the file\'s lines 1-31',
    ]);
  });

  it("keeps a lead's supports, and strips the citations and pages a lead carries", () => {
    const lead = draft({ id: "l1", cite: [], supports: ["y1"] });
    expect(verifyArchitectureClaim("lead", lead, ctx).claim?.supports).toEqual(["y1"]);
    // Even references that would not resolve, or lines the pack never showed: they are dropped.
    const carrying = {
      ...lead,
      cite: ["src/signals/ingest.py:1-2", "nope.py:1"],
      pages: ["ghost"],
    };
    expect(verifyArchitectureClaim("lead", carrying, ctx)).toEqual({
      claim: expect.objectContaining({ id: "l1", citations: [], pages: [], supports: ["y1"] }),
      problems: [],
    });
    expect(verifyArchitectureClaim("layers", draft({ supports: ["y2"] }), ctx).problems).toEqual([
      "only lead claims may support other claims",
    ]);
  });

  it("still checks the citation and lead rules when a page is unknown", () => {
    expect(
      verifyArchitectureClaim("request-paths", draft({ cite: [], pages: ["ghost"] }), ctx).problems,
    ).toEqual([
      'the claim names "ghost", which is not a feature page of this wiki',
      "body claims need a citation or a feature page",
      "request-path claims need a code or commit citation",
    ]);
    expect(
      verifyArchitectureClaim("lead", draft({ id: "l1", pages: ["ghost", "signals"] }), ctx)
        .problems,
    ).toEqual(["lead claims must support at least one body claim"]);
  });

  it("refuses a page that is not a feature id even when the context lists it", () => {
    const result = verifyArchitectureClaim(
      "dependencies",
      draft({ cite: [], pages: ["Sig\u2028nals", " "] }),
      { ...ctx, pages: new Set(["Sig\u2028nals", ""]) },
    );
    expect(result).toEqual({
      claim: null,
      problems: [
        'the claim names "Sig\\u2028nals", which is not a feature page of this wiki',
        'the claim names "", which is not a feature page of this wiki',
        "body claims need a citation or a feature page",
      ],
    });
  });

  it("quotes at most three unknown pages, each cut short", () => {
    const long = `x${"\u202e".repeat(200)}`;
    const result = verifyArchitectureClaim(
      "dependencies",
      draft({ cite: [], pages: [long, "g1", "g2", "g3"] }),
      ctx,
    );
    expect(result.problems).toEqual([
      `the claim names "x${"\\u202e".repeat(79)}…", which is not a feature page of this wiki`,
      'the claim names "g1", which is not a feature page of this wiki',
      'the claim names "g2", which is not a feature page of this wiki',
      "the claim names more than 3 pages; name the closest ones",
      "body claims need a citation or a feature page",
    ]);
  });
});
