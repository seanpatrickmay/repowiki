export { type ArticleDue, articleDue, articleSkipped } from "./article.ts";
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
/** Test-only: the fixture wiki repository and store (builtWiki), for other modules' tests. */
export { builtWiki, inputAt, STORE_PY } from "./test-wiki-repo.ts";
export {
  breakTies,
  fallbackFeature,
  MAX_TIE_BREAK_FILES,
  provisionalPlacement,
  TIE_BREAK_INSTRUCTIONS,
  type TieBreak,
  TieBreakAnswer,
  type TieBreakInput,
  type TieBreakOptions,
} from "./tiebreak.ts";
export {
  UpdateArticleError,
  type UpdateOptions,
  updateWiki,
  type WikiUpdate,
} from "./update.ts";
