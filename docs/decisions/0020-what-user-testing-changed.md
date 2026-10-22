# 0020. What user testing changed

- Status: accepted
- Date: 2026-10-22
- Amends: ADR-0012 (the generated label), ADR-0013 (the infobox), ADR-0014 (categories)

## Context

Seven user-testing personas (`.claude/agents/persona-*.md`) used a running copy of RepoWiki in
two rounds:
- a first-internship student;
- a co-op student with a team capstone;
- a university recruiter;
- an interviewing engineer;
- a career-services director;
- a privacy skeptic;
- an international student.

Each one wrote a report. Most findings were bugs or wording; this record holds the rulings that
change what an earlier record decided, plus the wording rules later changes follow. Findings that
are the owner's to decide are listed at the end, not ruled on.

## Decision

- **The generated label.** Ruling: "Written by an AI model from the git history at <sha7>, not by
  <name>", and once published ", who reviewed it and published it on <date>". The app's project
  page says "not by you". — "Not written by the author" read to every persona as the student
  disowning their own code, and "the author" meant two people on one page. Publishing requires
  the review declaration, so the date says a person stood behind the page. — Cost if wrong: one
  template.
- **Main projects.** Ruling: the infobox row ADR-0013 named "Known for" is "Main projects"; what it
  lists is unchanged. — A student no one has heard of is not known for anything, and the page
  promises not to praise. — Cost if wrong: one label.
- **Categories.** Ruling: "Software developers" and one "<Language> programmers" per language
  with at least 10% of lines; ADR-0014's "<Library> developers" categories are dropped. — A
  library listed in a dependency file is not a skill, and the persona checking for overstatement
  flagged "FastAPI developers" first. The Technical profile still lists libraries, cited to the
  file. — Cost if wrong: one list.
- **Contribution words.** Ruling: the facts paragraph says the student "made" commits and "was
  the last to change" a share of the code, not that they "wrote" it. — Squash merges and pairing
  credit whoever's name is on the commit; the words say only what git records. — Cost if wrong:
  one sentence.
- **Page footers.** Ruling: a wiki page's footer says an AI model wrote it from the code as of a
  date, at a commit, and that RepoWiki checked its citations point at that code. — "Last edited"
  implied a person. The claim is exactly what the verifier checks: lines resolve and hashes match,
  not that they support the sentence. — Cost if wrong: one template.
- **Public copy.** Ruling: the public pages claim only what RepoWiki checks. No "every sentence
  links" (a lead carries no citation), no "a recruiter can trust it". The pages name both cookies,
  and they say when Pro renews and charges, what deletion keeps, and how long a preview link
  works. — Each overstatement was quoted back by a persona who then distrusted the rest. — Cost if
  wrong: copy.
- **Words a student uses.** Ruling: the app shows a job's steps, states and buttons in plain
  words ("Checking the citations", "Not published yet", "Publish what the preview shows"), and an
  article's infobox shows code names as code in a "Names in the code" row instead of beside the
  names a reader says. — Pipeline words read as a developer tool to the first-time student. —
  Cost if wrong: copy.

## The owner's decisions (not ruled here)

- A way for a student to correct or annotate what a page says. This was the most common
  complaint in both rounds, and it conflicts with "nothing on the page came from you".
- Crediting squash-merged and co-authored work, for example by GitHub pull-request author or
  `Co-authored-by`.
- An example with a team project.
- A coursework confirmation before the first build.
- The refund rule's "no build since upgrading" condition, and a renewal reminder.
