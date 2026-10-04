export {
  coverageGaps,
  type Gap,
  nextMembership,
  type Placement,
  placeNewFiles,
  renamesOf,
} from "./membership.ts";
export { type LineRange, remapRange } from "./remap.ts";
export {
  type CitationFate,
  type RemapContext,
  type RemappedClaim,
  remapCitation,
  remapClaims,
} from "./stale.ts";
export {
  breakTies,
  MAX_TIE_BREAK_FILES,
  TIE_BREAK_INSTRUCTIONS,
  type TieBreak,
  TieBreakAnswer,
  type TieBreakInput,
  type TieBreakOptions,
} from "./tiebreak.ts";
