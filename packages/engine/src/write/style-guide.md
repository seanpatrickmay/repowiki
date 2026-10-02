# RepoWiki style guide

RepoWiki pages read like Wikipedia articles about a codebase. This guide distills the parts of
Wikipedia's Manual of Style that apply to them. It is part of every page's prompt.

The examples below are illustrative: they are never claims about the repository being documented.
Never reuse their names, numbers or citations.

## Neutral point of view

- Describe what the code does and how it is built. Never judge it: no praise, no criticism, no
  advice, no predictions.
- Banned words: "simply", "just", "robust", "powerful", "clearly", "obviously", "seamless",
  "seamlessly", "elegant", "easy", "easily", "leverage", "cutting-edge", "best-in-class".
- No "we", "you", "our", "us" or "I". Write about the code in the third person.
- A known limitation is stated as a fact with its evidence ("A TODO comment notes that long
  chunks are truncated rather than paged"), never as a complaint.

## Verifiability and no original research

- Every sentence of the body states something the cited lines or commits show. If the context
  pack does not show it, do not write it.
- Intent ("why") is stated only in the History section, only when a commit subject says so, and
  that commit is cited in the claim's cite array: "The retry was added to survive rate limits."
  Never guess at motives.
- Do not describe code that is not in the context pack, even if its name suggests what it does.
- Prefer one precise claim over two vague ones.

## Tense and mood

- Present tense for what the code does: "The scheduler runs every five minutes."
- Past tense only in the History section: "Signal scoring was added on 3 March 2026."
- Plain declarative sentences. No questions, no exclamations, no rhetorical flourishes.

## The lead

- The first sentence defines the subject, with the page title in bold, and says what kind of
  thing it is and where it sits in the repository:
  "**Signal ingestion** is the subsystem of next-chief-of-staff that turns uploaded documents
  into scored signals."
- The lead is 2 to 4 sentences. It stands on its own: a reader who reads only the lead (it is
  also the hover preview) learns what the feature is, what it does and what it connects to.
- The lead summarizes the body; it adds nothing the body does not say. Each lead claim lists,
  in its supports field, the ids of the body claims it summarizes.
- Do not start the lead with "This page", "This feature" or "This section".

## Sections

- Overview: purpose and main parts, at the level a newcomer needs first.
- How it works: the mechanism, step by step, naming the functions, classes and files.
- Data flow: inputs, transformations, storage and outputs, in the order data moves.
- History: when and how the feature changed, from commit subjects, oldest first.
- Known limitations: only what a TODO, FIXME, XXX or HACK comment, a skipped test or a reverting
  commit shows.
- Sections are left out rather than padded. A short, accurate page beats a long one.

## Naming code

- Name functions, classes, files, routes, tables and environment variables in code style:
  `ingest_chunk()`, `SignalRow`, `src/signals/ingest.py`, `GET /api/signals`, `signals`,
  `DATABASE_URL`.
- Add "()" to function and method names; omit it for classes, modules and variables.
- Use the name as the code spells it. Do not translate `cos_api` into "the COS API module".
- Explain a name the first time it appears when its meaning is not obvious from the name.

## Numbers, dates and units

- Write numbers as the code has them: "at most 50 signals", "every 300 seconds".
- Dates are written "3 February 2026" and come only from commit dates in the pack.
- Do not round or convert units the code states.

## Links

- Link another feature of the wiki on its first mention on the page with [[feature-id]] or
  [[feature-id|words]]. Link each feature once; later mentions are plain words.
- Link a general concept on its first mention with [[wp:Article title]] when it is an
  established topic with a Wikipedia article: [[wp:Message queue]], [[wp:Cron]],
  [[wp:Retrieval-augmented generation]], [[wp:Exponential backoff]]. Do not link ordinary words,
  product names or anything specific to this repository.
- Never link the page's own feature.

## Claims

- A claim is one or two sentences that state one checkable thing.
- The text of a claim is one paragraph with no line breaks, at most 1,000 characters.
- Citations go only in the claim's cite array, never in its text: no parenthesised commit
  references, no "cite:" and no file and line references written into the sentences.
- A commit reference is "commit:" and at least 7 hex digits.
- Keep body claims independent: a reader should be able to verify each one from its citations
  alone. Lead claims carry no citations; they list the body claims they summarize in supports.
- Cite the narrowest lines that show the claim, at most 120 lines. A function's signature and
  the lines that do the work are better than the whole file.
- Hooks ("Did you know…") are surprising, self-contained facts, such as an unusual limit or a
  notable design choice the code makes. At most two per page.

## Examples

Good lead:

> **Deliverables management** is the part of next-chief-of-staff that stores the documents a
> project owes its client and tracks their status. It exposes CRUD routes under
> `/api/deliverables` and cancels the open signals of a deliverable when it is marked completed.

Bad lead (judges the code, addresses the reader, says nothing checkable):

> This robust feature lets you easily manage deliverables in a seamless way.

Good body claim:

> `ingest_chunk()` creates one signal per non-empty sentence and stops after `MAX_SIGNALS`
> (50) signals.

with the cite array `["src/signals/ingest.py:10-24"]`.

Bad body claim (guesses at intent, cites nothing):

> The limit was probably added for performance reasons.

Good history claim:

> Scoring moved from a nightly job to ingestion time on 12 March 2026.

with the cite array `["commit:abc1234"]`.

Good known limitation:

> A TODO comment notes that chunks longer than `MAX_SIGNALS` sentences are truncated rather
> than paged.

with the cite array `["src/signals/ingest.py:18-21"]`.
