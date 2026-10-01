import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { type Action, type ExistingIssue, planSeed, Seed } from "./plan.ts";

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8" }).trim();
}

const ISSUES_QUERY = `query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $endCursor, states: [OPEN, CLOSED]) {
      nodes { number title state parent { number } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

interface IssueNode {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  parent: { number: number } | null;
}

/** Reads every issue with its state and sub-issue parent, so the plan reflects real GitHub state. */
function fetchExisting(repo: string): ExistingIssue[] {
  const [owner = "", name = ""] = repo.split("/");
  const out = gh([
    "api",
    "graphql",
    "--paginate",
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-f",
    `query=${ISSUES_QUERY}`,
    "--jq",
    ".data.repository.issues.nodes[]",
  ]);
  return out
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const node = JSON.parse(line) as IssueNode;
      return {
        number: node.number,
        title: node.title,
        state: node.state,
        parentNumber: node.parent?.number ?? null,
      };
    });
}

function describe(action: Action): string {
  switch (action.kind) {
    case "upsert-label":
      return `label   ${action.label.name}`;
    case "create-issue":
      return `create  ${action.issue.title}`;
    case "link-parent":
      return `link    ${action.childKey} -> ${action.parentKey}`;
    case "close-issue":
      return `close   ${action.key}`;
  }
}

function main(argv: readonly string[]): void {
  const dryRun = argv.includes("--dry-run");
  const projectFlag = argv.indexOf("--project");
  const project = projectFlag === -1 ? null : (argv[projectFlag + 1] ?? null);

  const seed = Seed.parse(
    JSON.parse(readFileSync(new URL("./seed.json", import.meta.url), "utf8")),
  );
  const repo = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const existing = fetchExisting(repo);
  const actions = planSeed(seed, existing);

  for (const action of actions) console.log(describe(action));
  if (dryRun) return;

  const numbers = new Map<string, number>();
  for (const issue of seed.issues) {
    const match = existing.find((e) => e.title === issue.title);
    if (match) numbers.set(issue.key, match.number);
  }
  const numberOf = (key: string): number => {
    const n = numbers.get(key);
    if (n === undefined) throw new Error(`no issue number known for ${key}`);
    return n;
  };

  for (const action of actions) {
    switch (action.kind) {
      case "upsert-label": {
        const { name, color, description } = action.label;
        gh([
          "label",
          "create",
          name,
          "--repo",
          repo,
          "--color",
          color,
          "--description",
          description,
          "--force",
        ]);
        break;
      }
      case "create-issue": {
        const { key, title, body, labels } = action.issue;
        const url = gh([
          "issue",
          "create",
          "--repo",
          repo,
          "--title",
          title,
          "--body",
          body,
          "--label",
          labels.join(","),
        ]);
        numbers.set(key, Number(url.split("/").pop()));
        break;
      }
      case "link-parent": {
        const childId = gh([
          "api",
          `repos/${repo}/issues/${numberOf(action.childKey)}`,
          "--jq",
          ".id",
        ]);
        gh([
          "api",
          "-X",
          "POST",
          `repos/${repo}/issues/${numberOf(action.parentKey)}/sub_issues`,
          "-F",
          `sub_issue_id=${childId}`,
        ]);
        break;
      }
      case "close-issue":
        gh([
          "issue",
          "close",
          String(numberOf(action.key)),
          "--repo",
          repo,
          "--reason",
          "completed",
        ]);
        break;
    }
  }

  if (project !== null) {
    const owner = repo.split("/")[0] ?? "";
    for (const n of numbers.values()) {
      gh([
        "project",
        "item-add",
        project,
        "--owner",
        owner,
        "--url",
        `https://github.com/${repo}/issues/${n}`,
      ]);
    }
  }
}

main(process.argv.slice(2));
