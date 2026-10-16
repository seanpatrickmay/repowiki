import { describe, expect, it } from "vitest";
import {
  detectTechnologies,
  imageCandidates,
  importName,
  MAX_TECHNOLOGIES,
  SnapshotTechnology,
  snapshotPaths,
  sourcePaths,
  TechnologyUse,
  technologyPaths,
} from "./detect.ts";
import { TECHNOLOGIES, technologyForPackage } from "./technologies.ts";

const pkg = (deps: Record<string, string>, dev: Record<string, string> = {}) =>
  JSON.stringify({ dependencies: deps, devDependencies: dev });

const detect = (
  files: Record<string, string>,
  imports: [string, string][] | null,
  extra: string[] = [],
) =>
  detectTechnologies({
    paths: [...Object.keys(files), ...extra],
    sources: new Map(Object.entries(files)),
    imports: imports === null ? null : imports.map(([from, specifier]) => ({ from, specifier })),
  });
const ids = (d: ReturnType<typeof detect>) => d.technologies.map((t) => t.id);
const use = (d: ReturnType<typeof detect>, id: string) => d.technologies.find((t) => t.id === id);

describe("importName (ADR-0014)", () => {
  it("names the npm package root, the Python module path and the Rust crate", () => {
    expect(importName("web/a.tsx", "@tanstack/react-query/devtools?x")).toEqual({
      ecosystem: "npm",
      name: "@tanstack/react-query",
    });
    expect(importName("a.ts", "React-DOM/client")).toEqual({ ecosystem: "npm", name: "react-dom" });
    expect(importName("a.ts", "node:fs")).toBeNull();
    expect(importName("a.ts", "./local")).toBeNull();
    expect(importName("a.ts", "https://example.com/x.js")).toBeNull();
    expect(importName("a.py", "google.cloud.aiplatform")).toEqual({
      ecosystem: "pypi",
      name: "google.cloud.aiplatform",
    });
    expect(importName("a.py", ".sibling")).toBeNull();
    // Rust crates are used through paths as often as through `use`: never counted (review M4).
    expect(importName("src/lib.rs", "serde_json::Value")).toBeNull();
    expect(importName("main.js", "react")).toBeNull();
  });
});

describe("paths detection reads", () => {
  it("keeps manifests and infrastructure files outside skipped directories", () => {
    const paths = [
      "package.json",
      "node_modules/react/package.json",
      "web/dist/package.json",
      ".github/workflows/ci.yml",
      "infra/main.tf",
      "src/app.ts",
      "vendor/x/go.mod",
      "Dockerfile",
    ];
    expect(technologyPaths(paths)).toEqual([
      "package.json",
      ".github/workflows/ci.yml",
      "infra/main.tf",
      "Dockerfile",
    ]);
  });

  it("keeps the first path of every rule when a snapshot cuts the list at 500 (review M7)", () => {
    const paths = [
      ...Array.from({ length: 600 }, (_, i) => `tf/${i}.tf`),
      "deploy/Dockerfile",
      ".github/workflows/ci.yml",
    ];
    const kept = snapshotPaths(paths);
    expect(kept).toHaveLength(500);
    expect(kept).toEqual(expect.arrayContaining(["deploy/Dockerfile", ".github/workflows/ci.yml"]));
    expect(kept[0]).toBe("tf/0.tf");
  });

  it("bounds a snapshot's technology files wherever it is read (review M8)", () => {
    const ok = { paths: ["package.json"], files: [{ path: "package.json", text: "{}" }] };
    expect(SnapshotTechnology.safeParse(ok).success).toBe(true);
    const many = { ...ok, paths: Array.from({ length: 501 }, (_, i) => `${i}.tf`) };
    expect(SnapshotTechnology.safeParse(many).success).toBe(false);
    const big = { ...ok, files: [{ path: "package.json", text: "x".repeat(64 * 1024 + 1) }] };
    expect(SnapshotTechnology.safeParse(big).success).toBe(false);
  });

  it("lists the files whose contents it needs, shallowest first, up to a limit", () => {
    const paths = ["b/c/package.json", "pyproject.toml", "a/Cargo.toml", "Dockerfile", "a/b.ts"];
    expect(sourcePaths(paths, 2)).toEqual(["pyproject.toml", "a/Cargo.toml"]);
  });

  it("matches compose images by repository name without registry or tag", () => {
    expect(imageCandidates("postgres:16-alpine")).toEqual(["postgres"]);
    expect(imageCandidates("docker.io/library/postgres@sha256:abc")).toEqual(["postgres"]);
    expect(imageCandidates("docker.elastic.co/elasticsearch/elasticsearch:8")).toEqual([
      "elasticsearch/elasticsearch",
      "elasticsearch",
    ]);
  });
});

describe("detectTechnologies", () => {
  it("shows a declared library its files import, with the importing count", () => {
    const d = detect(
      { "package.json": pkg({ react: "18", "react-dom": "18", zod: "4" }) },
      [
        ["src/a.tsx", "react"],
        ["src/a.tsx", "react-dom/client"],
        ["src/b.tsx", "react"],
      ],
      ["src/a.tsx", "src/b.tsx"],
    );
    expect(use(d, "react")).toEqual({
      id: "react",
      evidence: { path: "package.json" },
      importingFiles: 2,
    });
    // Zod is declared but no TypeScript file imports it.
    expect(ids(d)).not.toContain("zod");
  });

  it("shows declared libraries with a null count when their ecosystem has no import data", () => {
    const local = detect({ "requirements.txt": "fastapi\nnumpy\n" }, null, ["app.py"]);
    expect(local.technologies).toEqual([
      { id: "fastapi", evidence: { path: "requirements.txt" }, importingFiles: null },
      { id: "numpy", evidence: { path: "requirements.txt" }, importingFiles: null },
    ]);
    // A JavaScript-only project: the engine parses no .js file, so npm has no import data.
    const js = detect({ "package.json": pkg({ express: "4" }) }, [], ["server.js"]);
    expect(use(js, "express")?.importingFiles).toBeNull();
  });

  it("shows a declared tool with no import, and an undeclared imported library", () => {
    const d = detect(
      {
        "package.json": pkg({}, { vite: "5", vitest: "1", tailwindcss: "4" }),
        "tools/requirements.txt": "",
      },
      [
        ["tools/plot.py", "matplotlib.pyplot"],
        ["tools/fit.py", "sklearn.linear_model"],
        ["tools/a.py", "os"],
      ],
      ["src/main.ts", "tools/plot.py", "tools/fit.py", "tools/a.py"],
    );
    expect(use(d, "vite")).toEqual({
      id: "vite",
      evidence: { path: "package.json" },
      importingFiles: 0,
    });
    expect(ids(d)).toEqual(expect.arrayContaining(["vitest", "tailwind-css"]));
    expect(use(d, "scikit-learn")).toEqual({
      id: "scikit-learn",
      evidence: { path: "tools/fit.py" },
      importingFiles: 1,
    });
    expect(use(d, "matplotlib")?.evidence.path).toBe("tools/plot.py");
  });

  it("finds infrastructure from paths and compose images", () => {
    const d = detect(
      {
        "docker/compose.yml":
          "services:\n  db:\n    image: postgres:16\n  q:\n    image: rabbitmq:3\n",
      },
      null,
      [
        "backend/Dockerfile.lambda",
        ".github/workflows/ci.yml",
        "fly.toml",
        "infra/main.tf",
        "native/core.pyx",
        "web/vercel.json",
        "pnpm-lock.yaml",
      ],
    );
    expect(Object.fromEntries(d.technologies.map((t) => [t.id, t.evidence.path]))).toEqual({
      docker: "backend/Dockerfile.lambda",
      postgresql: "docker/compose.yml",
      rabbitmq: "docker/compose.yml",
      "github-actions": ".github/workflows/ci.yml",
      "fly-io": "fly.toml",
      terraform: "infra/main.tf",
      cython: "native/core.pyx",
      vercel: "web/vercel.json",
      pnpm: "pnpm-lock.yaml",
    });
    expect(d.technologies.every((t) => t.importingFiles === null)).toBe(true);
  });

  it("cites the shallowest declaring manifest, ignoring skipped directories", () => {
    const d = detect(
      {
        "web/package.json": pkg({ react: "18" }),
        "package.json": pkg({ react: "18" }),
        "node_modules/x/package.json": pkg({ vue: "3" }),
      },
      null,
      ["node_modules/x/.github/workflows/ci.yml"],
    );
    expect(d.technologies).toEqual([
      { id: "react", evidence: { path: "package.json" }, importingFiles: null },
    ]);
  });

  it("logs the paths it could not parse and goes on", () => {
    const d = detect(
      { "package.json": "{oops", "Cargo.toml": '[dependencies]\nserde = "1"\n' },
      null,
    );
    expect(d.unparsed).toEqual(["package.json"]);
    expect(ids(d)).toEqual(["serde"]);
  });

  it("ranks by importing files, then frameworks before tools, and keeps at most 60", () => {
    const d = detect(
      { "package.json": pkg({ vite: "5", react: "18", zod: "4", next: "14" }) },
      [
        ["a.ts", "zod"],
        ["b.ts", "zod"],
        ["a.ts", "react"],
      ],
      ["a.ts", "b.ts"],
    );
    expect(ids(d)).toEqual(["zod", "react", "vite"]);
    const every = TECHNOLOGIES.flatMap((t) =>
      (t.packages.npm ?? []).filter((n) => !n.endsWith("*")),
    );
    const all = detect(
      { "package.json": pkg(Object.fromEntries(every.map((n) => [n, "1"]))) },
      null,
    );
    expect(new Set(every.map((n) => technologyForPackage("npm", n)?.id)).size).toBeGreaterThan(60);
    expect(all.technologies).toHaveLength(MAX_TECHNOLOGIES);
    // With no counts, kinds decide (machine learning first), then names.
    expect(all.technologies.slice(0, 2).map((t) => t.id)).toEqual(["transformers", "onnx-runtime"]);
    for (const t of all.technologies) expect(TechnologyUse.safeParse(t).success).toBe(true);
  });

  it("never stores an evidence path the facts would refuse, falling back to the next (review I3)", () => {
    const vitest = JSON.stringify({ devDependencies: { vitest: "1" } });
    const backslash = detect({ "we\\ird/package.json": vitest }, null);
    expect(backslash.technologies).toEqual([]);
    const long = detect({ [`${"a/".repeat(500)}package.json`]: vitest }, null);
    expect(long.technologies).toEqual([]);
    const fallback = detect({ "we\\ird/package.json": vitest, "web/package.json": vitest }, null);
    expect(fallback.technologies).toEqual([
      { id: "vitest", evidence: { path: "web/package.json" }, importingFiles: null },
    ]);
  });

  it("gates each library on the ecosystems that declared or imported it (review I5)", () => {
    const d = detect(
      {
        "backend/requirements.txt": "fastapi\n",
        "frontend/package.json": pkg({ openai: "4", stripe: "14" }),
      },
      [["backend/app.py", "fastapi"]],
      ["backend/app.py", "frontend/src/index.js"],
    );
    expect(use(d, "openai")).toEqual({
      id: "openai",
      evidence: { path: "frontend/package.json" },
      importingFiles: null,
    });
    expect(use(d, "stripe")?.importingFiles).toBeNull();
    expect(use(d, "fastapi")?.importingFiles).toBe(1);
  });

  it("counts a namespace import of a declared library's module path (review I4)", () => {
    const d = detect(
      {
        "requirements.txt": "google-genai\ngoogle-cloud-aiplatform\ngoogle-cloud-translate\n",
      },
      [
        ["app.py", "google"],
        ["ai.py", "google.cloud"],
        ["x.py", "goo"],
      ],
      ["app.py", "ai.py", "x.py"],
    );
    expect(Object.fromEntries(d.technologies.map((t) => [t.id, t.importingFiles]))).toEqual({
      gemini: 1,
      "vertex-ai": 2,
      "cloud-translation": 2,
    });
    // Undeclared, a bare namespace names nothing.
    expect(detect({}, [["app.py", "google"]], ["app.py"]).technologies).toEqual([]);
  });

  it("shows declared crates on their declaration: Rust has no import data (review M4)", () => {
    const d = detect(
      { "Cargo.toml": '[dependencies]\ntokio = "1"\nserde_json = "1"\n' },
      [["src/main.rs", "serde_json::Value"]],
      ["src/main.rs"],
    );
    expect(d.technologies).toEqual([
      { id: "serde", evidence: { path: "Cargo.toml" }, importingFiles: null },
      { id: "tokio", evidence: { path: "Cargo.toml" }, importingFiles: null },
    ]);
  });

  it("takes no npm import data from declaration or config files (review M5)", () => {
    const d = detect(
      { "package.json": pkg({ zod: "4" }) },
      [],
      ["src/types.d.ts", "vite.config.ts", "src/app.js"],
    );
    expect(use(d, "zod")?.importingFiles).toBeNull();
  });
});
