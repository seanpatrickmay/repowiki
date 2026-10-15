import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}${path}`, "utf8");
const pkg = JSON.parse(read("package.json")) as { packageManager: string };

describe("the worker entrypoint (spec 2 S9)", () => {
  const script = read("deploy/worker-entrypoint.sh");
  const start = script.indexOf("nft -f");
  const rules = script.slice(start, script.indexOf("\nRULES", start));

  it("is valid sh", () => {
    expect(spawnSync("sh", ["-n", `${ROOT}deploy/worker-entrypoint.sh`]).status).toBe(0);
  });

  it("runs phase 1, then the firewall, then phase 2 as the worker user with no new privileges", () => {
    const phase1 = script.indexOf('"$APP" phase1');
    const phase2 = script.indexOf('"$APP" phase2');
    expect(script).toMatch(/^set -eu$/m);
    expect(phase1).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(phase1);
    expect(phase2).toBeGreaterThan(start);
    expect(script).toMatch(/setpriv[^\n]*--no-new-privs/);
    expect(script).toMatch(/setpriv[^\n]*--reuid=worker/);
    expect(script).toMatch(/setpriv[^\n]*--bounding-set=-all/);
    expect(script).toMatch(/^export REPOWIKI_WORK_DIR=/m);
  });

  it("stops before the firewall and phase 2 when phase 1 fails", () => {
    // Under `set -e` a failing phase 1 ends the script; nothing may swallow its status.
    const line = script.split("\n").find((l) => l.includes('"$APP" phase1')) ?? "";
    expect(line.trim()).toBe('node "$APP" phase1');
  });

  it("drops all output except loopback, replies, and the server's address and port", () => {
    expect(rules.length).toBeGreaterThan(100);
    expect(rules).toContain("flush ruleset");
    expect(rules.match(/policy drop/g)?.length).toBe(2);
    expect(rules).toMatch(/ip6 daddr \$addr tcp dport \$port accept/);
    expect(rules).not.toMatch(/dport 53|udp|daddr 0|::\/0|policy accept/);
    // Loopback, replies and Neighbor Discovery in each chain, plus the server.
    expect(rules.match(/accept/g)?.length).toBe(7);
  });

  it("lets IPv6 Neighbor Discovery through both chains, link-local only", () => {
    // Without it the server's link address expires after an idle gap (EHOSTUNREACH).
    const nd =
      "icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit, nd-router-advert } ip6 hoplimit 255 accept";
    const output = rules.slice(rules.indexOf("chain output"), rules.indexOf("chain input"));
    const input = rules.slice(rules.indexOf("chain input"));
    expect(output).toContain(nd);
    expect(input).toContain(nd);
  });

  it("puts only a checked address and port into the rules", () => {
    const beforeRules = script.slice(0, start);
    expect(beforeRules).toMatch(/\^\[0-9a-fA-F:\]\+\$/);
    expect(beforeRules).toMatch(/\^\[0-9\]\+\$/);
  });
});

describe("the image and the Fly configs (spec 2 §2)", () => {
  const docker = read("deploy/Dockerfile");

  it("pins the Node and pnpm versions the repo uses", () => {
    expect(docker).toMatch(/FROM node:24\.\d+\.\d+-bookworm-slim AS base/);
    expect(docker).toContain(pkg.packageManager);
    expect(docker).toMatch(/FROM base AS server/);
    expect(docker).toMatch(/FROM base AS worker/);
    expect(docker).toContain("nftables");
    expect(docker).toContain("--frozen-lockfile");
  });

  it("lets the server's site builds write their caches before dropping to the node user (A1)", () => {
    const server = docker.slice(
      docker.indexOf("FROM base AS server"),
      docker.indexOf("FROM base AS worker"),
    );
    const writable = server.indexOf(
      "chown -R node:node packages/site/.astro packages/site/node_modules/.vite",
    );
    expect(writable).toBeGreaterThan(0);
    expect(server.indexOf("USER node")).toBeGreaterThan(writable);
    expect(server).toContain("REPOWIKI_MODE=production");
  });

  it("exposes only the public port on the server and no service on the worker app", () => {
    const server = read("deploy/fly.server.toml");
    expect(server).toContain("internal_port = 8787");
    expect(server).not.toContain("internal_port = 8788");
    expect(server).toMatch(/path = "\/"/);
    expect(read("deploy/fly.worker.toml")).not.toContain("[[services]]");
    expect(read("deploy/fly.worker.toml")).not.toContain("[http_service]");
  });

  it("keeps secrets out of the image and the configs", () => {
    for (const path of ["deploy/Dockerfile", "deploy/fly.server.toml", "deploy/fly.worker.toml"]) {
      expect(read(path)).not.toMatch(
        /sk-ant|TOKEN_KEY\s*=|SECRET\s*=|_KEY_ID\s*=|API_TOKEN\s*=|DATABASE_URL\s*=|ANTHROPIC_API_KEY\s*=/,
      );
    }
    expect(read(".dockerignore")).toMatch(/^\.env$/m);
    expect(read(".dockerignore")).toMatch(/^\.env\.\*$/m);
  });
});
