# 0008. People pages are sober dated chronicles, not war stories (F14)

- Status: accepted
- Date: 2026-10-06
- Features: F14

## Context

F14 asked for people pages "writing about when and where they contributed as if documenting a
war". The pages describe real colleagues. Martial metaphor invites drama and judgement about
them, which conflicts with the wiki's neutral point of view (v1 §7.1) and with verifiability: a
claim that someone "fought" or "conquered" a module cannot be checked against a commit. Commit
trailers such as `Co-authored-by` are free text, and in the owner's repositories most of them
name AI models.

## Decision

F14's voice is reshaped to a chronicle, or annals, voice (spec v2 #6 R16): dated, in
chronological order, past tense and sober. A narrative never evaluates the person, compares them
with anyone, names another person, states a motive that no cited commit subject states, gives
statistics, or uses martial or heroic metaphor. `people-style.md` holds the voice, and verify
enforces a banned-word list (`PEOPLE_BANNED_WORDS`) with the other mechanical checks (R18).
Narratives are off by default: only the owner, and people the people file marks
`narrative: true`, get one. Every other person page has the computed facts and a one-sentence
computed lead. A commit belongs to its author; `Co-authored-by` trailers earn no credit in v2
(R5).

## Consequences

The pages keep the dated, episodic structure the owner asked for, with a flatter read. A bolder
voice is a style-guide and banned-word change plus a cassette re-record. Pair-programmed work is
credited to the commit's author only.
