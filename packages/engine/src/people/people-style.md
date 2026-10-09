# RepoWiki people style guide

A person page reads like a short, sober Wikipedia biography of someone's work on one repository:
dated annals of what they changed, nothing about who they are. It is part of every person
narrative's prompt.

The examples below are illustrative: they are never claims about the repository being documented.
Never reuse their names, dates or commits.

## Voice

- Past tense, plain declarative sentences, in the third person. No questions, no exclamations.
- Say what changed, in terms of the features and the commit subjects the pack shows. Do not
  describe code the pack does not name.
- Never evaluate the person or their work: no praise, no criticism, no "important", "key" or
  "significant".
- Never compare them with anyone, and never name another person, even one a commit subject names.
- Never state a motive unless a cited commit subject states it.
- Never give statistics: no counts of commits, lines, files or pull requests, and no percentages.
  The page's infobox has them.
- No martial or heroic metaphor: nothing is fought, conquered, battled or won.
- Banned words: "prolific", "tireless", "heroic", "hero", "brilliant", "genius", "legendary",
  "valiant", "battle", "war", "fought", "conquered", "crusade", "single-handedly", "lazy",
  "sloppy", "best", "worst", "rockstar", "ninja", and the feature pages' list: "simply", "just",
  "robust", "powerful", "clearly", "obviously", "seamless", "seamlessly", "elegant", "easy",
  "easily", "leverage", "cutting-edge", "best-in-class".

## The lead

- 2 to 3 sentences. The first opens with the person's name in bold, exactly as the pack's first
  line gives it, and says when they contributed, as a dated range in the past tense, and to which
  features, linked: "**Ada Example** contributed to the repository between January and March
  2026, mostly to [[signals|signal ingestion]]."
- The lead summarizes the chronicle and the areas; it adds nothing they do not say. Each lead
  claim lists, in its supports field, the ids of the body claims it summarizes, and cites nothing.

## The chronicle

- One claim per heading of the pack's work, oldest first.
- Each claim opens with its date, at the granularity its commits support: "On 14 March 2026, …"
  for one day, "In March 2026, …" for one month, "Between January and February 2026, …" for a
  range. Every date stated lies within the cited commits' author dates.
- Each claim cites the commits under the heading it describes ("commit:<sha>"), and only commits
  the pack shows.

## Areas of work

- One claim per main feature, at most 6, in the order the pack's feature list gives.
- Each claim starts with the feature's link and says what the person's commits in it did:
  "[[deliverables|Deliverables]]: the commits added paging to the list endpoint."
- Each claim links exactly one feature and cites commits that touch it.

## Dates and names

- Dates are written "14 March 2026", "March 2026" or "2026"; never "3/14" or "last spring".
- Feature names are linked on first mention with [[feature-id]] or [[feature-id|words]], using
  only ids from the feature directory.
