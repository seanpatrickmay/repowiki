import { describe, expect, it } from "vitest";
import { applyMailmap, parseMailmap } from "./mailmap.ts";

describe("parseMailmap (spec v2 #6 §6.1)", () => {
  it("reads git's four forms, skipping comments and blank lines", () => {
    const mailmap = parseMailmap(
      [
        "# the team",
        "",
        "Ada Lovelace <ada@example.com>",
        "<grace@example.com> <GH@old.example.com>",
        "Bob Smith <bob@example.com> <bob@laptop.local> # a comment",
        "Carol Ng <carol@example.com> carol <c@example.com>",
      ].join("\r\n"),
    );
    expect(mailmap).toEqual({
      skipped: 0,
      rules: [
        {
          matchEmail: "ada@example.com",
          matchName: null,
          properName: "Ada Lovelace",
          properEmail: null,
        },
        {
          matchEmail: "gh@old.example.com",
          matchName: null,
          properName: null,
          properEmail: "grace@example.com",
        },
        {
          matchEmail: "bob@laptop.local",
          matchName: null,
          properName: "Bob Smith",
          properEmail: "bob@example.com",
        },
        {
          matchEmail: "c@example.com",
          matchName: "carol",
          properName: "Carol Ng",
          properEmail: "carol@example.com",
        },
      ],
    });
  });

  it("skips and counts malformed lines", () => {
    const mailmap = parseMailmap(
      ["no email here", "<only@example.com>", "Name <>", "<> <>", "Fine <f@example.com>"].join(
        "\n",
      ),
    );
    expect(mailmap.skipped).toBe(4);
    expect(mailmap.rules).toHaveLength(1);
  });
});

describe("applyMailmap", () => {
  const mailmap = parseMailmap(
    [
      "Old Name <ada@example.com>",
      "Ada Lovelace <ada@example.com>",
      "Ada (work) <ada@work.example.com> ada <ada@example.com>",
    ].join("\n"),
  );

  it("matches emails and names case-insensitively, the last rule for an email winning", () => {
    expect(applyMailmap({ name: "A. L.", email: "ADA@example.com" }, mailmap)).toEqual({
      name: "Ada Lovelace",
      email: "ADA@example.com",
      properName: true,
    });
  });

  it("prefers a rule that names the commit's name too", () => {
    expect(applyMailmap({ name: "ADA", email: "ada@example.com" }, mailmap)).toEqual({
      name: "Ada (work)",
      email: "ada@work.example.com",
      properName: true,
    });
  });

  it("leaves an identity no rule matches as it is", () => {
    expect(applyMailmap({ name: "Bob", email: "bob@example.com" }, mailmap)).toEqual({
      name: "Bob",
      email: "bob@example.com",
      properName: false,
    });
  });

  it("keeps hostile proper names as data for the identity step to clean", () => {
    const hostile = parseMailmap("Evil\u202E [[x]] **y** <e@example.com>\n");
    expect(applyMailmap({ name: "e", email: "e@example.com" }, hostile).name).toBe(
      "Evil\u202E [[x]] **y**",
    );
  });
});
