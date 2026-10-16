import { describe, expect, it } from "vitest";
import {
  ECOSYSTEMS,
  isTool,
  KIND_PRIORITY,
  kindLabel,
  normalizedName,
  packageMatches,
  TECHNOLOGIES,
  TECHNOLOGY_KINDS,
  type Technology,
  technologyById,
  technologyForPackage,
} from "./technologies.ts";

const entry = (id: string): Technology => {
  const found = technologyById(id);
  if (found === undefined) throw new Error(`no entry ${id}`);
  return found;
};

describe("the curated table (ADR-0014)", () => {
  it("has about 150 entries with unique kebab-case ids, names and valid kinds", () => {
    expect(TECHNOLOGIES.length).toBeGreaterThanOrEqual(140);
    const ids = TECHNOLOGIES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 40)).toEqual(
      [],
    );
    const names = TECHNOLOGIES.map((t) => t.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const t of TECHNOLOGIES) expect(TECHNOLOGY_KINDS).toContain(t.kind);
    expect([...KIND_PRIORITY].sort()).toEqual([...TECHNOLOGY_KINDS].sort());
  });

  it("gives every entry some evidence to be found by", () => {
    const evidenceless = TECHNOLOGIES.filter(
      (t) =>
        ECOSYSTEMS.every((e) => (t.packages[e] ?? []).length === 0) &&
        (t.images ?? []).length === 0 &&
        (t.paths ?? []).length === 0,
    );
    expect(evidenceless.map((t) => t.id)).toEqual([]);
  });

  it("never lets two entries claim one package, import name or image", () => {
    const claimed = new Map<string, string>();
    const clash: string[] = [];
    const claim = (key: string, id: string) => {
      const other = claimed.get(key);
      if (other !== undefined && other !== id) clash.push(`${key}: ${other} and ${id}`);
      claimed.set(key, id);
    };
    for (const t of TECHNOLOGIES) {
      for (const e of ECOSYSTEMS) for (const p of t.packages[e] ?? []) claim(`${e}:${p}`, t.id);
      for (const e of ECOSYSTEMS)
        for (const i of t.imports?.[e] ?? []) claim(`import ${e}:${i}`, t.id);
      for (const image of t.images ?? []) claim(`image:${image}`, t.id);
    }
    expect(clash).toEqual([]);
  });

  it("resolves every literal package name to its own entry, whatever patterns overlap (review M1)", () => {
    const misresolved = TECHNOLOGIES.flatMap((t) =>
      ECOSYSTEMS.flatMap((e) =>
        (t.packages[e] ?? [])
          .filter((p) => !p.endsWith("*"))
          .flatMap((p) => {
            const got = technologyForPackage(e, normalizedName(e, p))?.id;
            return got === t.id ? [] : [`${e}:${p} -> ${got} (not ${t.id})`];
          }),
      ),
    );
    expect(misresolved).toEqual([]);
    expect(technologyForPackage("pypi", "flask-sqlalchemy")?.id).toBe("sqlalchemy");
    expect(technologyForPackage("pypi", "Flask_Login")?.id).toBe("flask");
  });

  it("gives client libraries a library kind, so their imports gate them (review M2)", () => {
    for (const id of [
      "aws-sdk",
      "google-cloud-storage",
      "firebase",
      "kafka",
      "rabbitmq",
      "minio",
      "prometheus",
    ]) {
      expect(isTool(entry(id)), id).toBe(false);
    }
  });

  it("leaves out small utilities (review M3)", () => {
    const utilities = [
      ["npm", "dotenv"],
      ["pypi", "python-dotenv"],
      ["npm", "axios"],
      ["npm", "lodash"],
      ["npm", "date-fns"],
      ["npm", "dayjs"],
      ["pypi", "tqdm"],
      ["pypi", "loguru"],
      ["pypi", "tenacity"],
      ["pypi", "python-dateutil"],
      ["pypi", "requests"],
      ["pypi", "httpx"],
      ["crates", "reqwest"],
      ["pypi", "cryptography"],
      ["pypi", "pyjwt"],
    ] as const;
    expect(utilities.filter(([e, p]) => technologyForPackage(e, p) !== null)).toEqual([]);
  });

  it("leaves out type packages, compilers, linters, formatters and hook tools", () => {
    const excluded = [
      ["npm", "@types/node"],
      ["npm", "typescript"],
      ["npm", "eslint"],
      ["npm", "prettier"],
      ["npm", "@biomejs/biome"],
      ["npm", "husky"],
      ["pypi", "ruff"],
      ["pypi", "black"],
      ["pypi", "mypy"],
      ["pypi", "isort"],
    ] as const;
    expect(excluded.filter(([e, p]) => technologyForPackage(e, p) !== null)).toEqual([]);
  });

  it("covers the common libraries and tools of each ecosystem", () => {
    const covered = {
      npm: [
        "react",
        "react-dom",
        "next",
        "vue",
        "svelte",
        "express",
        "astro",
        "vite",
        "@vitejs/plugin-react",
        "vitest",
        "jest",
        "@playwright/test",
        "@testing-library/react",
        "jsdom",
        "tailwindcss",
        "styled-components",
        "@tanstack/react-query",
        "react-router-dom",
        "recharts",
        "react-markdown",
        "zod",
        "mermaid",
        "pagefind",
        "better-sqlite3",
        "web-tree-sitter",
        "tree-sitter-python",
        "@anthropic-ai/sdk",
        "openai",
        "@mediapipe/tasks-vision",
        "aws-cdk",
        "@radix-ui/react-dialog",
      ],
      pypi: [
        "fastapi",
        "flask",
        "django",
        "uvicorn",
        "pydantic",
        "pydantic-settings",
        "SQLAlchemy",
        "alembic",
        "asyncpg",
        "psycopg2-binary",
        "aiosqlite",
        "redis",
        "aiohttp",
        "websockets",
        "apscheduler",
        "feedparser",
        "boto3",
        "mangum",
        "aws-cdk-lib",
        "openai",
        "anthropic",
        "mcp",
        "google-cloud-aiplatform",
        "google-cloud-translate",
        "pypdf",
        "garminconnect",
        "numpy",
        "scipy",
        "scikit-learn",
        "pandas",
        "torch",
        "numba",
        "phevaluator",
        "catanatron",
        "maturin",
        "pytest",
        "pytest-asyncio",
        "moto",
        "cython",
      ],
      crates: ["serde", "serde_json", "tokio", "pyo3", "proptest", "criterion", "clap", "axum"],
      go: ["github.com/gin-gonic/gin", "github.com/spf13/cobra"],
    } as const;
    const missing = Object.entries(covered).flatMap(([e, names]) =>
      names.filter((n) => technologyForPackage(e as keyof typeof covered, n) === null),
    );
    expect(missing).toEqual([]);
  });

  it("finds an entry by id, package, normalised name and prefix pattern", () => {
    expect(technologyById("react")?.name).toBe("React");
    expect(technologyById("nope")).toBeUndefined();
    expect(technologyForPackage("npm", "react-dom")?.id).toBe("react");
    expect(technologyForPackage("pypi", "Scikit_Learn")?.id).toBe("scikit-learn");
    expect(technologyForPackage("crates", "serde-json")?.id).toBe("serde");
    expect(technologyForPackage("npm", "@vitejs/plugin-basic-ssl")?.id).toBe("vite");
    expect(technologyForPackage("npm", "left-pad")).toBeNull();
    expect(packageMatches("@radix-ui/*", "@radix-ui/react-dialog")).toBe(true);
    expect(packageMatches("@radix-ui/*", "@radix-ui")).toBe(false);
    expect(packageMatches("react", "react-dom")).toBe(false);
  });

  it("calls testing, build and infrastructure entries tools, and labels kinds", () => {
    expect(isTool(entry("vitest"))).toBe(true);
    expect(isTool(entry("docker"))).toBe(true);
    expect(isTool(entry("tailwind-css"))).toBe(true);
    expect(isTool(entry("react"))).toBe(false);
    expect(kindLabel("web framework")).toBe("Web framework");
    expect(kindLabel("AI API")).toBe("AI API");
  });
});
