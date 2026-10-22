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

## Consequences

- The Main Page's featured article changes for exports whose About lead names only some pages.
