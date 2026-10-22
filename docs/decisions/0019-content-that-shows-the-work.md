# 0019. Pages that show what was built

- Status: accepted
- Date: 2026-10-22
- Amends: spec §8 (Main Page, F12)

## Context

The owner asked whether the example's AlphaSettler wiki shows everything that went into the
project, reads well, and makes its best part findable. A review against the repository found it
does not: every measured result the project recorded is missing, pages list functions instead of
explaining them, and the Main Page leads with trivia. Its featured article is a rotation over
every article, so it can land on the developer tooling page. "Recently updated" sorts by each
page's `commitDate`, which is the build's commit, so every page has the same date and the list is
alphabetical. "Did you know" accepts history claims, which are a date and a commit subject. The
fixes come in several changes; this record holds their rulings and grows as each lands.

## Decision

- **Featured article.** Ruling: the rotation (still seeded by the head sha) runs over the articles
  the About lead is built on: the pages named by the body claims the lead's claims support. When
  the export has no About article, or its lead names none, it runs over every active article as
  before. — The About lead says what the project is; its pages are the ones to show first. — Cost
  if wrong: one function.
- **Recently updated.** Ruling: sorted and dated by each feature's own last commit
  (`infobox.lastCommitDate`), not the page's `commitDate`. — The list said nothing when every page
  carried the build's date. — Cost if wrong: one sort key.
- **Did you know.** Ruling: claims in a page's History section are never hooks. — A commit date
  with an unexplained subject is not a fact a reader enjoys. — Cost if wrong: one filter.
- **Every article on the Main Page.** Ruling: an "Articles" box lists every active article by
  title, above the feature map. — A reader sees the whole project's shape in one place, without
  finding All articles. — Cost if wrong: a box.
- **A Results section.** Ruling: a feature page gains a "Results" section, after Data flow and
  before History, for what the repository's documents, benchmarks and test outputs measured. The
  verifier refuses a results claim with a number its cited lines (or cited commit's subject) do
  not write as a whole number, so a result is quoted, never computed, converted or rounded.
  Numbers inside code spans are not read. — The review found every measured result missing,
  including ones the model was shown. — Cost if wrong: a section key; old pages have none and
  stay valid.
- **Plain words.** Ruling: "How it works" explains the mechanism in plain words, naming at most
  two functions, classes or files a claim; a named technique is explained in a few words on first
  use; intent may come from a cited design document, README or spec, not only a commit subject;
  hooks are results or design choices, never a date or a commit. — Pages read as lists of
  identifiers. — Cost if wrong: prompt text.
- **No talk about the pack.** Ruling: the verifier refuses a claim that mentions the context pack
  ("the pack shows three specifications in full"). — It is the engine's word, not the reader's. —
  Cost if wrong: one pattern.
- **The definition around a change.** Ruling: a pull request's summary pack shows the line that
  opens the definition a hunk sits in (going up through less-indented lines to one that starts a
  `def`, `class`, `fn`, `function`, `impl` and the like), and every line down to the hunk when that
  is 8 lines or fewer; the prompt says a range ends at a gap and that a named function is cited
  where it is defined or called. — Summaries name the function they describe, and the verifier
  drops a name its cited lines do not write; without the line the model could only guess it. —
  Cost if wrong: a few more lines in each summary pack.
- **Documents in a page's pack.** Ruling: a Markdown or reStructuredText member file too long to
  show in full is shown as an excerpt (its headings, table rows and lines that state a number, at
  most 120), from an allowance of its own: a quarter of the pack's budget on top of it. — Result
  write-ups have no symbols, so they fell straight to "listed" once code had used the budget,
  and the model never saw the numbers. — Cost if wrong: a pack up to a quarter larger, at about
  a cent a build.
- **Results in the About article.** Ruling: the About article gains a "Results" section after
  "Purpose and features", for what the README and project documents record the project achieved;
  each claim cites the lines (a page's lead is not enough) and passes the same numbers rule, and
  the lead states the most telling result when there is one. — The project's headline numbers
  were in its README and appeared nowhere. — Cost if wrong: a section key and prompt text.
- **No page of only tests.** Ruling: the manifest check refuses a feature whose files are all test
  files while other features hold code, and the manifest prompt no longer offers "Developer
  tooling" as an example of a repository-wide feature; a README, lockfiles and `.gitignore` join
  the closest feature as supporting files. — The example had a page about its test suite and one
  for its README and lockfile, each saying nothing about what was built. — Cost if wrong: a
  retried manifest call.
- **The defining sentence first.** Ruling: the lead claim that names its subject in bold opens a
  page's or the About article's lead, whatever order the model returned, and a biography's
  description of a project comes from the About lead's first sentence that opens "<Title> is",
  not only its first sentence. — PokerML's Works row read "Its features cover …" because the
  model put that claim first. — Cost if wrong: one reorder and one search.

## Consequences

- The Main Page's featured article changes for exports whose About lead names only some pages.
