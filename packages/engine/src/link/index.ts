export { codeAliases, IDENTIFIER_PATTERNS, MAX_CODE_ALIASES } from "./aliases.ts";
export {
  createPageLinker,
  createTargetResolver,
  LINK_TOKEN,
  normalizeWikipediaTitle,
  unlinkText,
  wikipediaTitlesIn,
} from "./links.ts";
export { featureNeighbours, SEE_ALSO_LIMIT, seeAlsoFor } from "./see-also.ts";
export { linkViolations } from "./violations.ts";
export {
  checkWikipediaTitles,
  WIKIPEDIA_USER_AGENT,
  type WikipediaCache,
  type WikipediaCheck,
  type WikipediaOptions,
} from "./wikipedia.ts";
