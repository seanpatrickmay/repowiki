import { describe, expect, it } from "vitest";
import { manifestKind, readManifest } from "./manifests.ts";

const names = (path: string, text: string) =>
  readManifest(path, text)?.declared.map((d) => `${d.ecosystem}:${d.name}`);

describe("manifestKind (ADR-0014)", () => {
  it("names the files whose contents detection reads", () => {
    expect(manifestKind("package.json")).toBe("package.json");
    expect(manifestKind("web/package.json")).toBe("package.json");
    expect(manifestKind("api/pyproject.toml")).toBe("pyproject");
    expect(manifestKind("requirements-dev.txt")).toBe("requirements");
    expect(manifestKind("crates/a/Cargo.toml")).toBe("cargo");
    expect(manifestKind("go.mod")).toBe("go.mod");
    expect(manifestKind("Pipfile")).toBe("pipfile");
    expect(manifestKind("docker/docker-compose.prod.yml")).toBe("compose");
    expect(manifestKind("compose.yaml")).toBe("compose");
    expect(manifestKind("src/package.json.bak")).toBeNull();
    expect(manifestKind("notes/requirements.md")).toBeNull();
  });
});

describe("readManifest", () => {
  it("reads package.json's dependencies, devDependencies and peerDependencies", () => {
    const text = JSON.stringify({
      name: "x",
      dependencies: { react: "18", "@scope/pkg": "1" },
      devDependencies: { vitest: "5" },
      peerDependencies: { vue: "3" },
      optionalDependencies: { fsevents: "2" },
      scripts: { build: "vite build" },
    });
    expect(names("package.json", text)).toEqual([
      "npm:react",
      "npm:@scope/pkg",
      "npm:vitest",
      "npm:vue",
    ]);
    expect(names("package.json", '{"dependencies": null}')).toEqual([]);
  });

  it("reads PEP 621, optional, dependency groups, build-system and Poetry", () => {
    const text = `
[build-system]
requires = ["maturin==1.15.0"] # the backend

[project]
name = "demo"
dependencies = [
  "fastapi>=0.110",   # web
  'uvicorn[standard]>=0.27',
  "catanatron @ git+https://example.com/c.git@abc",
  "numpy; python_version >= '3.9'",
]

[project.optional-dependencies]
dev = ["pytest==9.1.1"]
train = ["torch==2.14.1"]

[dependency-groups]
lint = ["ruff", { include-group = "dev" }]

[tool.poetry.dependencies]
python = "^3.11"
sqlalchemy = { version = "^2.0.30", extras = ["asyncio"] }

[tool.poetry.group.dev.dependencies]
moto = {version = "^5.0.0", extras = ["secretsmanager"]}

[tool.poetry.dev-dependencies]
black = "^24.4"
`;
    expect(names("pyproject.toml", text)).toEqual([
      "pypi:maturin",
      "pypi:fastapi",
      "pypi:uvicorn",
      "pypi:catanatron",
      "pypi:numpy",
      "pypi:pytest",
      "pypi:torch",
      "pypi:ruff",
      "pypi:poetry",
      "pypi:sqlalchemy",
      "pypi:moto",
      "pypi:black",
    ]);
  });

  it("reads requirement lines and skips options, URLs and comments", () => {
    const text = [
      "# pinned",
      "fastapi>=0.110,<0.112",
      "uvicorn[standard]>=0.27  # server",
      "-r base.txt",
      "--extra-index-url https://example.com/simple",
      "-e ./local",
      "https://example.com/pkg.whl",
      "./wheels/x.whl",
      "Django ~= 5.0 \\",
      "  --hash=sha256:abc",
      "pkg @ https://example.com/pkg.zip",
      "",
    ].join("\n");
    expect(names("requirements.txt", text)).toEqual([
      "pypi:fastapi",
      "pypi:uvicorn",
      "pypi:Django",
      "pypi:pkg",
    ]);
  });

  it("reads Cargo's sections, workspace, target tables and dotted forms", () => {
    const text = `
[package]
name = "engine"

[dependencies]
serde = { version = "1", features = ["derive"] }
tokio.workspace = true
"quoted-crate" = "1"

[dev-dependencies]
proptest = "=1.5.0"

[build-dependencies]
cc = "1"

[workspace.dependencies]
rayon = "1"

[target.'cfg(target_os = "linux")'.dependencies]
nix = "0.29"

[dependencies.clap]
version = "4"
features = ["derive"]
`;
    expect(names("Cargo.toml", text)).toEqual([
      "crates:serde",
      "crates:tokio",
      "crates:quoted-crate",
      "crates:proptest",
      "crates:cc",
      "crates:rayon",
      "crates:nix",
      "crates:clap",
    ]);
  });

  it("reads Pipfile packages and go.mod requires, skipping indirect ones", () => {
    const pipfile = '[packages]\nflask = "*"\n\n[dev-packages]\npytest = "*"\n';
    expect(names("Pipfile", pipfile)).toEqual(["pypi:flask", "pypi:pytest"]);
    const gomod = [
      "module example.com/app",
      "",
      "go 1.22",
      "",
      "require github.com/spf13/cobra v1.8.0",
      "require (",
      "\tgithub.com/gin-gonic/gin v1.9.1",
      "\tgolang.org/x/sys v0.20.0 // indirect",
      ")",
    ].join("\n");
    expect(names("go.mod", gomod)).toEqual([
      "go:github.com/spf13/cobra",
      "go:github.com/gin-gonic/gin",
    ]);
  });

  it("reads compose service images", () => {
    const text = [
      "services:",
      "  db:",
      "    image: postgres:16-alpine",
      "  cache:",
      '    image: "redis:7" # cache',
      "  app:",
      "    build: .",
      "  - image: 'localstack/localstack:3'",
    ].join("\n");
    expect(readManifest("docker-compose.yml", text)).toEqual({
      declared: [],
      images: ["postgres:16-alpine", "redis:7", "localstack/localstack:3"],
    });
  });

  it("gives null for a file that will not parse", () => {
    expect(readManifest("package.json", "{ not json")).toBeNull();
    expect(readManifest("package.json", "[1, 2]")).toBeNull();
    expect(readManifest("pyproject.toml", '[project]\ndependencies = ["a",')).toBeNull();
    expect(readManifest("Cargo.toml", '[dependencies\nserde = "1"')).toBeNull();
    expect(readManifest("Cargo.toml", 'serde = "1')).toBeNull();
    expect(readManifest("go.mod", "require (\n\tgithub.com/a/b v1\n")).toBeNull();
    expect(readManifest("compose.yml", "services:\n  db:\n    image: 'postgres\n")).toBeNull();
    expect(readManifest("requirements.txt", "fastapi\u0000")).toBeNull();
  });

  it("gives nothing for a path that is not a manifest", () => {
    expect(readManifest("README.md", "# hi")).toEqual({ declared: [], images: [] });
  });
});
