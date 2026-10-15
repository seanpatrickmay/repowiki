import { WikiExport } from "@repowiki/core";

/**
 * The export a hosted site is built from (spec 2 S10, S13; ADR-0012): every page stays, since
 * nothing is hidden; People, work in flight, run costs and Wikipedia summaries are dropped.
 */
export function hostedExport(exp: WikiExport): WikiExport {
  return WikiExport.parse({ ...exp, people: null, inflight: null, runs: [], wikipedia: {} });
}
