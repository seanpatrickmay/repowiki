import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRepo, type TestRepo } from "../index/index.ts";
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
    expect(mailmap.skipped).toBe(0);
    const at = (name: string, email: string) => applyMailmap({ name, email }, mailmap);
    expect(at("A", "ada@example.com")).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
      properName: true,
    });
    expect(at("G", "gh@old.example.com")).toEqual({
      name: "G",
      email: "grace@example.com",
      properName: false,
    });
    expect(at("B", "bob@laptop.local")).toEqual({
      name: "Bob Smith",
      email: "bob@example.com",
      properName: true,
    });
    expect(at("Carol", "c@example.com")).toEqual({
      name: "Carol Ng",
      email: "carol@example.com",
      properName: true,
    });
    expect(at("Other", "c@example.com").properName).toBe(false);
  });

  it("skips and counts lines git ignores, a first email left empty included", () => {
    const mailmap = parseMailmap(
      [
        "no email here",
        "<only@example.com>",
        "Name <>",
        "<> <>",
        "Name <> <old@example.com>",
        "Fine <f@example.com>",
      ].join("\n"),
    );
    expect(mailmap.skipped).toBe(5);
    expect(applyMailmap({ name: "O", email: "old@example.com" }, mailmap).name).toBe("O");
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

  it("merges a name-only and an email-only line for one email, in either order, as git does", () => {
    for (const lines of [
      ["Ada Lovelace <ada@example.com>", "<ada.new@x.com> <ada@example.com>"],
      ["<ada.new@x.com> <ada@example.com>", "Ada Lovelace <ada@example.com>"],
    ])
      expect(
        applyMailmap({ name: "A", email: "ada@example.com" }, parseMailmap(lines.join("\n"))),
      ).toEqual({ name: "Ada Lovelace", email: "ada.new@x.com", properName: true });
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

describe("applyMailmap against git check-mailmap (the fix-forward ruling: git is the spec)", () => {
  let repo: TestRepo;
  beforeEach(() => {
    repo = createTestRepo();
  });
  afterEach(() => repo.remove());

  const MAILMAP = [
    "# the team",
    "Ada Lovelace <ada@example.com>",
    "<ada.new@example.com> <ada@example.com>",
    "<grace@example.com> <GH@old.example.com>",
    "Grace Hopper <grace@example.com>",
    "Bob Smith <bob@example.com> <bob@laptop.local> # a comment",
    "Carol Ng <carol@example.com> carol <c@example.com>",
    "Carol N <c@example.com>",
    "<cn@example.com> CAROL <c@example.com>",
    "Old Name <dee@example.com>",
    "Dee Dee <dee@example.com>",
    "Name <> <eve@example.com>",
    "A>B <ab@example.com>",
    "Ada <a<b@example.com>",
    " # Hash <hash@example.com>",
    "  Spaced   Name   <  sp@example.com  >",
    "Trail <trail@example.com> trailing text",
    "<proper@example.com> <>",
    "Proper Kim <kim@example.com> Kim <>",
    "\uFEFFBom <bom@example.com>",
    "Up <UP@Example.COM>",
    "\u00DCni <\u00FCni@example.com>",
    "CRLF Line <crlf@example.com>\r",
    "Fred <fred@example.com> Fr <fr@example.com> extra <x@example.com>",
    "<> <> <>",
    "no brackets at all",
  ].join("\n");

  const CONTACTS = [
    "A <ada@example.com>",
    "A <ADA@EXAMPLE.COM>",
    "X <gh@old.example.com>",
    "Grace <grace@example.com>",
    "B <bob@laptop.local>",
    "carol <c@example.com>",
    "Carol <c@example.com>",
    "Other <c@example.com>",
    "D <dee@example.com>",
    "E <eve@example.com>",
    "X <ab@example.com>",
    "Y <a<b@example.com>",
    "H <hash@example.com>",
    "S <sp@example.com>",
    "S <  sp@example.com  >",
    "T <trail@example.com>",
    "X <>",
    "Kim <>",
    "B? <bom@example.com>",
    "U <up@example.com>",
    "U <\u00DCNI@example.com>",
    "U <\u00FCni@example.com>",
    "C <crlf@example.com>",
    "Fr <fr@example.com>",
    "Nobody <nobody@example.com>",
  ];

  it("gives git's identity for every contact of a mailmap in every form", () => {
    repo.write(".mailmap", `${MAILMAP}\n`);
    const fromGit = repo.git("check-mailmap", ...CONTACTS).split("\n");
    const mailmap = parseMailmap(MAILMAP);
    const ours = CONTACTS.map((contact) => {
      const at = contact.indexOf(" <");
      const mapped = applyMailmap(
        { name: contact.slice(0, at), email: contact.slice(at + 2, -1) },
        mailmap,
      );
      return `${mapped.name} <${mapped.email}>`;
    });
    expect(ours).toEqual(fromGit);
  });
});
