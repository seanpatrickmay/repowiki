import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexRepo } from "./build-index.ts";
import { createTestRepo, type TestRepo } from "./test-repo.ts";

let repo: TestRepo;
beforeEach(() => {
  repo = createTestRepo();
  repo.write("app/__init__.py", "");
  repo.write(
    "app/store.py",
    "def save(x):\n    return x\n\n\nclass Repo:\n    def put(self, x):\n        return self.check(x)\n\n    def check(self, x):\n        return save(x)\n",
  );
  repo.write("app/util.py", "def clean(x):\n    return x\n");
  repo.write(
    "app/api.py",
    "from . import util\nfrom .store import save as persist, Repo\n\n\ndef handle(x):\n    persist(util.clean(x))\n    return Repo().put(x)\n\n\nhandle(1)\nunknown(2)\n",
  );
  repo.write("web/api.ts", "export function fetchJson(url: string) {\n  return url;\n}\n");
  repo.write(
    "web/main.tsx",
    'import * as api from "./api";\nimport Panel from "./Panel";\n\nexport function Main() {\n  api.fetchJson("/x");\n  return <Panel />;\n}\n',
  );
  repo.write("web/Panel.tsx", "export default function Panel() {\n  return <div />;\n}\n");
  repo.commit("calls");
});
afterEach(() => repo.remove());

describe("indexRepo call edges", () => {
  it("resolves calls through imports, module bindings, self, and the file's own symbols", async () => {
    const index = await indexRepo(repo.dir, "HEAD");
    expect(index.calls).toEqual([
      { from: "app/api.py", to: "app/api.py#handle", line: 10 },
      { from: "app/api.py#handle", to: "app/store.py#Repo", line: 7 },
      { from: "app/api.py#handle", to: "app/store.py#save", line: 6 },
      { from: "app/api.py#handle", to: "app/util.py#clean", line: 6 },
      { from: "app/store.py#Repo.check", to: "app/store.py#save", line: 10 },
      { from: "app/store.py#Repo.put", to: "app/store.py#Repo.check", line: 7 },
      { from: "web/main.tsx#Main", to: "web/Panel.tsx#Panel", line: 6 },
      { from: "web/main.tsx#Main", to: "web/api.ts#fetchJson", line: 5 },
    ]);
  });
});

describe("indexRepo call edges: names shared with modules and locals", () => {
  beforeEach(() => {
    repo.write("app/config.py", "class Config:\n    pass\n\n\ndef load():\n    return 1\n");
    repo.write("app/util.py", "def util(x):\n    return x\n");
    repo.write("app/sub.py", "def f():\n    return 1\n");
    repo.write("app/store.py", "def save(x):\n    return x\n");
    repo.write(
      "app/samename.py",
      "from .config import config\nfrom .util import util\nfrom . import sub\nfrom .store import save\n\n\ndef save(x):\n    return x\n\n\ndef run():\n    config.load()\n    util(1)\n    sub.f()\n    save(2)\n",
    );
    repo.commit("samename");
  });

  it("treats from-imports of a same-named symbol as symbols, real submodules as modules, and a later local def as the callee", async () => {
    const index = await indexRepo(repo.dir, "HEAD");
    expect(index.calls.filter((c) => c.from === "app/samename.py#run")).toEqual([
      { from: "app/samename.py#run", to: "app/samename.py#save", line: 15 },
      { from: "app/samename.py#run", to: "app/sub.py#f", line: 14 },
      { from: "app/samename.py#run", to: "app/util.py#util", line: 13 },
    ]);
  });
});
