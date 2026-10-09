import { fileURLToPath } from "node:url";

export {
  extendedWiki,
  SAMPLE_FILES,
  type SampleWiki,
  sampleWiki,
} from "@repowiki/query/test-wiki";

/**
 * The committed smoke questions: three questions about the sample fixture that check the harness
 * end to end. They are never the author's eval set (spec §9), which never lives in this repository.
 */
export const SMOKE_QUESTIONS = fileURLToPath(
  new URL("./__fixtures__/smoke-questions.json", import.meta.url),
);
