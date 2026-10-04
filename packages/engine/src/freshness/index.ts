export { DEFAULT_DRIFT_THRESHOLD, driftedFeatures, featureChurn } from "./drift.ts";
export {
  DRIFT_INSTRUCTIONS,
  DRIFT_REQUEST,
  type DriftInput,
  type DriftOptions,
  type DriftOutcome,
  driftSystemPrompt,
  reviseManifest,
} from "./drift-call.ts";
export {
  coverageGaps,
  type Gap,
  nextMembership,
  type Placement,
  placeNewFiles,
  renamesOf,
} from "./membership.ts";
export {
  type AppliedOperations,
  applyOperations,
  ManifestOperation,
  ManifestOperations,
} from "./ops.ts";
export {
  knownFeature,
  measureDrift,
  type PagePlan,
  planPages,
  planUpdate,
  UpdateError,
  type UpdateInput,
  type UpdatePlan,
} from "./plan.ts";
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
export { type UpdateOptions, updateWiki, type WikiUpdate } from "./update.ts";
