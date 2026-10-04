import type { Manifest } from "@repowiki/core";
import { makeFeature, makeManifest } from "@repowiki/core/test-fixtures";
import { describe, expect, it } from "vitest";
import { codeAliases, IDENTIFIER_PATTERNS, MAX_CODE_ALIASES } from "./aliases.ts";
import { linkManifest } from "./test-manifest.ts";

const sources = new Map([
  [
    "src/signals/ingest.py",
    [
      '@router.get("/api/signals")',
      '@router.post("/api/signals")',
      "class SignalRow(Base):",
      '    __tablename__ = "signals_table"',
      'URL = os.environ["SIGNALS_URL"]',
      'TOKEN = os.getenv("SHARED_TOKEN")',
      '@cli.command("ingest-signals")',
    ].join("\n"),
  ],
  [
    "src/signals/score.py",
    'op.create_table("Signal Ingestion")\nCREATE TABLE IF NOT EXISTS scores (id int)',
  ],
  ["src/deliverables/crud.py", 'TOKEN = os.getenv("SHARED_TOKEN")\napp.get(`/deliverables/:id`)'],
  [
    "src/billing/invoice.py",
    "const key = process.env.STRIPE_KEY;\nconst v = import.meta.env.VITE_API_URL;",
  ],
]);

/** linkManifest() with these files as the only members (file paths to feature ids). */
function withMembers(members: Record<string, string>): Manifest {
  return {
    ...linkManifest(),
    membership: Object.fromEntries(
      Object.keys(members).map((path) => [path, { featureId: members[path] ?? "", weight: 1 }]),
    ),
  };
}

/** What billing finds in `text` stored at `path`. */
function billingAt(path: string, text: string): string[] | undefined {
  return codeAliases(withMembers({ [path]: "billing" }), new Map([[path, text]])).billing;
}

/** The aliases found when `text` is the only source, in billing's one file. */
function billingFrom(text: string): string[] | undefined {
  return codeAliases(linkManifest(), new Map([["src/billing/invoice.py", text]])).billing;
}

describe("codeAliases (F01)", () => {
  it("finds routes, tables, env vars and commands in each feature's files, most frequent first", () => {
    expect(codeAliases(linkManifest(), sources)).toEqual({
      billing: ["STRIPE_KEY", "VITE_API_URL"],
      deliverables: ["/deliverables/:id"],
      // "scores" shares no word with Signal ingestion's names, so it is no table alias of it.
      signals: ["/api/signals", "SIGNALS_URL", "ingest-signals", "signals_table"],
    });
  });

  it("leaves out identifiers two features share and ones that collide with a feature's names", () => {
    const found = Object.values(codeAliases(linkManifest(), sources)).flat();
    expect(found).not.toContain("SHARED_TOKEN");
    expect(found).not.toContain("Signal Ingestion");
  });

  it(`keeps at most ${MAX_CODE_ALIASES} per feature`, () => {
    const many = Array.from(
      { length: 15 },
      (_, i) => `x = os.getenv("VAR_${String(i).padStart(2, "0")}")`,
    );
    const found = codeAliases(
      linkManifest(),
      new Map([["src/billing/invoice.py", many.join("\n")]]),
    );
    expect(found.billing).toHaveLength(MAX_CODE_ALIASES);
  });

  it("skips, never truncates, an identifier that is not a valid manifest alias", () => {
    const route60 = `/${"a".repeat(59)}`;
    const route61 = `/${"a".repeat(60)}`;
    // An astral character is two UTF-16 units but one code point, as proposalProblems counts.
    const astral60 = `/a${"\u{1F600}".repeat(58)}`;
    const astral61 = `/a${"\u{1F600}".repeat(59)}`;
    const found = billingFrom(
      [route60, route61, astral60, astral61].map((route) => `@router.get("${route}")`).join("\n"),
    );
    expect(found).toEqual([astral60, route60].sort());
  });

  it("treats a name two features spell in different letter cases as shared", () => {
    const found = codeAliases(
      linkManifest(),
      new Map([
        ["src/billing/invoice.py", 'x = os.getenv("TOKEN_X")'],
        ["src/deliverables/crud.py", 'x = os.getenv("TOKEN_X")\ny = os.getenv("ONLY_HERE")'],
        ["src/signals/ingest.py", '@router.get("/Same")'],
        ["src/deliverables/api.py", '@router.get("/same")'],
      ]),
    );
    expect(found).toEqual({ deliverables: ["ONLY_HERE"] });
  });

  it("skips routes holding control, line-separator or bidi characters", () => {
    const bad = ["\u202E", "\u2066", "\uFEFF", "\u2028", "\u0007", "\u0085"];
    const text = [
      ...bad.map((c) => `@router.get("/a${c}b")`),
      '@router.get("/fine")',
      'x = os.getenv("STRIPE\u202E_KEY")',
      'y = os.getenv("OTHER_KEY")',
    ].join("\n");
    expect(billingFrom(text)).toEqual(["/fine", "OTHER_KEY"]);
  });

  it("scans adversarial lines in linear time: 8 times the text costs far less than 64 times", () => {
    // Each line at n units of its adversarial shape. A backtracking pattern is at least quadratic
    // on one of them, so its 8x line would cost about 64x; a linear one costs about 8x. The bound
    // is that growth, not a wall-clock ceiling, so a slow or loaded machine does not fail it.
    const unit = "@a.b.c.d.e.f.g.h";
    const shapes: ((n: number) => string)[] = [
      (n) => unit.repeat(Math.ceil((2 * n) / unit.length)),
      (n) => "@a".repeat(n),
      (n) => `@${"a.".repeat(n)}`,
      (n) => `@${"a".repeat(2 * n)}`,
      (n) => "CREATE ".repeat(Math.ceil((3 * n) / 10)),
      (n) => `CREATE${" ".repeat(2 * n)}TABLE${" ".repeat(10)}`,
      (n) => `CREATE TABLE${" ".repeat(2 * n)}`,
      (n) => `os.getenv(${" ".repeat(2 * n)}`,
      (n) => `app.get(${" ".repeat(2 * n)}`,
      (n) => "a.".repeat(n),
      (n) => `CREATE TABLE ${"a.".repeat(n)}`,
      (n) => `CREATE TEMP TABLE IF NOT EXISTS ${"[a].".repeat(Math.ceil(n / 2))}`,
      (n) => `process.env[${" ".repeat(2 * n)}`,
      (n) => `@a.get("/${"a".repeat(2 * n)}`,
    ];
    /** The fastest of three scans, so one pause of the machine is not counted. */
    const cost = (line: string) =>
      Math.min(
        ...[1, 2, 3].map(() => {
          const started = performance.now();
          expect(billingFrom(line)).toBeUndefined();
          return performance.now() - started;
        }),
      );
    for (const shape of shapes) {
      const small = cost(shape(2_500));
      const large = cost(shape(20_000));
      // 32x is 4 times the linear growth and half the quadratic; 20 ms absorbs timer noise.
      expect(large).toBeLessThan(32 * small + 20);
    }
  });

  it("has no pattern that can match the empty string", () => {
    for (const { pattern } of IDENTIFIER_PATTERNS) expect("".match(pattern)).toBeNull();
  });

  it("counts a decorated route once, so frequency ranks real uses", () => {
    const text = [
      '@router.get("/a1")',
      'router.get("/b1")',
      'router.get("/b1")',
      '@router.get("/c1")',
      'router.get("/c1")',
      '@router.get("/d1")',
      'router.get("/e1")',
    ].join("\n");
    expect(billingFrom(text)).toEqual(["/b1", "/c1", "/a1", "/d1", "/e1"]);
  });

  it("finds Flask route decorators and routes on any receiver", () => {
    const text = [
      '@app.route("/flask", methods=["POST"])',
      "@bp.route('/blueprint')",
      '@router.api_route("/api-route")',
      'userRouter.get("/user-router", handler)',
      'fastify.get("/fastify", handler)',
      'server.post("/server", handler)',
      'this.app.use("/mounted", handler)',
      'api.all("/everything", handler)',
      '@api_v1.delete("/removal")',
    ].join("\n");
    expect(billingFrom(text)).toEqual([
      "/api-route",
      "/blueprint",
      "/everything",
      "/fastify",
      "/flask",
      "/mounted",
      "/removal",
      "/server",
      "/user-router",
    ]);
  });

  it("drops a route's query and fragment, and skips routes that name nothing", () => {
    const text = [
      '@router.get("/search?q=1&page=2")',
      '@router.get("/docs#intro")',
      '@router.get("/")',
      '@router.get("/?debug=1")',
      '@router.get("/{id}")',
      '@router.get("/:id")',
      '@router.get("/<int:id>")',
      '@router.get("/{org}/{repo}")',
      '@router.get("/*")',
      '@router.get("/{id}/edit")',
    ].join("\n");
    expect(billingFrom(text)).toEqual(["/docs", "/search", "/{id}/edit"]);
  });

  it("reads CREATE TABLE names, last part of a qualified name, only when a column list follows", () => {
    const text = [
      "-- create table if needed",
      "See: create table of contents (below)",
      "CREATE TABLE IF NOT EXISTS public.invoices (",
      'CREATE TABLE "public"."invoice_items" (',
      "CREATE TEMP TABLE tmp_invoice(",
      "CREATE UNLOGGED TABLE [dbo].[billing_log] (",
      "CREATE TEMPORARY TABLE IF NOT EXISTS `ev`.`billing_events` (",
      "CREATE TABLE billing_no_column_list",
      "create table lower_invoice (",
    ].join("\n");
    // Every name shares a word with Billing's own names, so only the parsing decides.
    expect(billingFrom(text)).toEqual([
      "billing_events",
      "billing_log",
      "invoice_items",
      "invoices",
      "lower_invoice",
      "tmp_invoice",
    ]);
  });

  it("reads bracketed Node and Vite env vars and Python setdefault/pop, minus ubiquitous names", () => {
    const text = [
      'process.env["API_TOKEN"]',
      "import.meta.env['VITE_FLAG']",
      'os.environ.setdefault("SET_DEFAULT_VAR", "x")',
      'os.environ.pop("POPPED_VAR")',
      ...[
        "NODE_ENV",
        "PORT",
        "HOST",
        "DEBUG",
        "ENV",
        "PATH",
        "HOME",
        "PWD",
        "USER",
        "PYTHONPATH",
        "LOG_LEVEL",
      ].map((name) => `os.getenv("${name}") + process.env.${name}`),
    ].join("\n");
    expect(billingFrom(text)).toEqual(["API_TOKEN", "POPPED_VAR", "SET_DEFAULT_VAR", "VITE_FLAG"]);
  });

  it("skips HTTP-client receivers but keeps routers and blueprints", () => {
    const clients = [
      "requests",
      "httpx",
      "axios",
      "http",
      "https",
      "client",
      "session",
      "request",
      "superagent",
      "got",
      "ky",
      "supertest",
      "fetch",
      "Requests",
      "apiClient",
      "ApiClient",
      "http_client",
      "authSession",
      "this.client",
      "self.session",
    ];
    for (const receiver of clients) {
      expect(billingFrom(`${receiver}.get("/api/x")\n${receiver}.post("/y")`)).toBeUndefined();
    }
    expect(billingFrom('requests.get("/x")')).toBeUndefined();
    expect(billingFrom('axios.get("/api/x")')).toBeUndefined();
    expect(billingFrom('apiClient.post("/y")')).toBeUndefined();
    expect(billingFrom('router.get("/x")')).toEqual(["/x"]);
    expect(billingFrom('@bp.route("/x")')).toEqual(["/x"]);
    expect(billingFrom('clients.get("/z")\nsessions.get("/w")')).toEqual(["/w", "/z"]);
  });

  it("skips test files", () => {
    const line = 'x = os.getenv("TEST_ONLY_VAR")';
    for (const path of [
      "tests/billing.py",
      "src/tests/billing.py",
      "src/__tests__/billing.ts",
      "src/billing.test.ts",
      "src/billing.spec.js",
      "src/test_billing.py",
      "src/billing_test.py",
      "src/conftest.py",
      "conftest.py",
      "src/tests.py",
      "src/fixtures/billing.py",
      "src/__fixtures__/billing.ts",
    ]) {
      expect(billingAt(path, line)).toBeUndefined();
    }
    expect(billingAt("src/contest.py", line)).toEqual(["TEST_ONLY_VAR"]);
    expect(billingAt("src/latest_billing.py", line)).toEqual(["TEST_ONLY_VAR"]);
    expect(billingAt("src/my_conftest.py", line)).toEqual(["TEST_ONLY_VAR"]);
    expect(billingAt("src/fixtures_loader.py", line)).toEqual(["TEST_ONLY_VAR"]);
  });

  it("returns the same list for an already-amended manifest, so re-linking adds nothing", () => {
    const many = Array.from(
      { length: 25 },
      (_, i) => `os.getenv("VAR_${String(i).padStart(2, "0")}")`,
    );
    const files = new Map([["src/billing/invoice.py", many.join("\n")]]);
    const first = codeAliases(linkManifest(), files);
    const amended: Manifest = {
      ...linkManifest(),
      features: linkManifest().features.map((feature) => ({
        ...feature,
        aliases: [...feature.aliases, ...(first[feature.id] ?? [])],
      })),
    };
    expect(codeAliases(amended, files)).toEqual(first);
    expect(first.billing).toHaveLength(MAX_CODE_ALIASES);
  });

  it("still leaves out an identifier another feature already has as an alias", () => {
    const other: Manifest = {
      ...linkManifest(),
      features: linkManifest().features.map((f) =>
        f.id === "deliverables" ? { ...f, aliases: [...f.aliases, "STRIPE_KEY"] } : f,
      ),
    };
    expect(codeAliases(other, sources).billing).toEqual(["VITE_API_URL"]);
  });

  it("compares lowercased and slugified forms with feature ids, titles and aliases", () => {
    const manifest = linkManifest();
    const named: Manifest = {
      ...manifest,
      features: manifest.features.map((f) =>
        f.id === "deliverables" ? { ...f, aliases: [...f.aliases, "scores-table"] } : f,
      ),
    };
    const files = new Map([
      [
        "src/signals/ingest.py",
        [
          '@router.get("/billing")', // slug "billing" = billing's id
          '@router.get("/Signal-Ingestion")', // slug of signals' title
          '__tablename__ = "scores_table"', // slug "scores-table" = deliverables' alias
          '__tablename__ = "kept_table"',
          '@router.get("/kept-table")', // same slug as kept_table, same feature
          '@router.get("/*")', // slug is empty
        ].join("\n"),
      ],
    ]);
    expect(codeAliases(named, files)).toEqual({ signals: ["/kept-table"] });
  });

  it("treats names two features share, in different slug spellings, as shared", () => {
    const files = new Map([
      ["src/billing/invoice.py", '__tablename__ = "shared_table"'],
      ["src/deliverables/crud.py", '@router.get("/shared-table")'],
    ]);
    expect(codeAliases(linkManifest(), files)).toEqual({});
  });

  it("never gives a feature a table named after another feature's subject", () => {
    const manifest = makeManifest({
      features: [
        makeFeature({ id: "signal-sources", title: "Signal sources", aliases: [] }),
        makeFeature({ id: "deliverables-management", title: "Deliverables management" }),
        makeFeature({ id: "ai-agents", title: "AI agents", aliases: [] }),
        makeFeature({ id: "planning", title: "Milestone tracking", aliases: [] }),
      ],
      membership: { "app/models.py": { featureId: "signal-sources", weight: 1 } },
    });
    // The shared models file belongs to one feature, but most of its tables name the others.
    const models = ["deliverables", "agents", "milestones", "signal_rows"]
      .map((table) => `    __tablename__ = "${table}"`)
      .join("\n");
    const found = codeAliases(manifest, new Map([["app/models.py", models]]));
    expect(found).toEqual({ "signal-sources": ["signal_rows"] });
  });

  it("gives a feature a table only when the name shares a word with the feature's own names", () => {
    const manifest = makeManifest({
      features: [
        makeFeature({ id: "signal-sources", title: "Signal sources", aliases: ["feeds"] }),
        makeFeature({ id: "planning", title: "Milestone tracking", aliases: [] }),
      ],
      membership: { "app/models.py": { featureId: "signal-sources", weight: 1 } },
    });
    const models = [
      '__tablename__ = "project_members"',
      '__tablename__ = "feed_items"',
      "CREATE TABLE source_runs (id int)",
      'op.create_table("audit_log")',
      'URL = os.getenv("PROJECT_MEMBERS_URL")',
    ].join("\n");
    // Tables of a shared models file name other subjects unless they share a word (feeds, sources).
    expect(codeAliases(manifest, new Map([["app/models.py", models]]))).toEqual({
      "signal-sources": ["PROJECT_MEMBERS_URL", "feed_items", "source_runs"],
    });
  });

  it("matches a Greek -sis name with its -ses plural, both ways", () => {
    const manifest = makeManifest({
      features: [
        makeFeature({ id: "signal-analysis", title: "Signal analysis", aliases: [] }),
        makeFeature({ id: "crisis-desk", title: "Crisis desk", aliases: [] }),
        makeFeature({ id: "planning", title: "Planning", aliases: [] }),
      ],
      membership: { "app/models.py": { featureId: "signal-analysis", weight: 1 } },
    });
    const models = ['__tablename__ = "analyses"', '__tablename__ = "crises"'].join("\n");
    // "analyses" is the feature's own word; "crises" names another feature's subject.
    expect(codeAliases(manifest, new Map([["app/models.py", models]]))).toEqual({
      "signal-analysis": ["analyses"],
    });
  });

  it("keeps an identifier that only shares a word with another feature, or names its own", () => {
    const manifest = makeManifest({
      features: [
        makeFeature({ id: "signal-sources", title: "Signal sources", aliases: [] }),
        makeFeature({ id: "ai-agents", title: "AI agents", aliases: [] }),
      ],
      membership: { "app/sources.py": { featureId: "signal-sources", weight: 1 } },
    });
    const text = [
      '__tablename__ = "source_agent_runs"',
      '__tablename__ = "sources"',
      'URL = os.getenv("AI_AGENTS_URL")',
    ].join("\n");
    expect(codeAliases(manifest, new Map([["app/sources.py", text]]))).toEqual({
      "signal-sources": ["AI_AGENTS_URL", "source_agent_runs", "sources"],
    });
  });

  it("lets only active features own identifiers", () => {
    const manifest = withMembers({
      "src/signals/ingest.py": "signals",
      "src/legacy/old.py": "legacy-signals",
    });
    const files = new Map([
      ["src/signals/ingest.py", 'os.getenv("SHARED_NAME_X")'],
      ["src/legacy/old.py", 'os.getenv("SHARED_NAME_X")'],
    ]);
    expect(codeAliases(manifest, files)).toEqual({ signals: ["SHARED_NAME_X"] });
  });
});
