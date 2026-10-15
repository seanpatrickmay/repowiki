import { describe, expect, it } from "vitest";
import {
  detectTechnologies,
  imageCandidates,
  importName,
  MAX_TECHNOLOGIES,
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
    expect(importName("src/lib.rs", "serde_json::Value")).toEqual({
      ecosystem: "crates",
      name: "serde_json",
    });
    expect(importName("src/lib.rs", "crate::engine")).toBeNull();
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
      { "package.json": pkg({ react: "18", "react-dom": "18", axios: "1" }) },
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
    // Axios is declared but no TypeScript file imports it.
    expect(ids(d)).not.toContain("axios");
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
    // With no counts, kinds decide (web frameworks first), then names.
    expect(all.technologies.slice(0, 2).map((t) => t.id)).toEqual(["astro", "express"]);
    for (const t of all.technologies) expect(TechnologyUse.safeParse(t).success).toBe(true);
  });
});
