import type { Deps } from "../app.ts";

/** A preview build the project page reports: still running, or ended without a preview. */
export type PreviewBuildState =
  | { kind: "building"; revision: number }
  | { kind: "failed"; revision: number; message: string };

/**
 * Per app, each project's preview build in progress or its last failure. In memory: the server
 * runs one machine, and a restart loses only a build the author can start again.
 */
const states = new WeakMap<Deps, Map<string, PreviewBuildState>>();

/** The app's map of project ids to their preview build state, made on first use. */
export function previewBuildStates(deps: Deps): Map<string, PreviewBuildState> {
  const known = states.get(deps);
  if (known !== undefined) return known;
  const fresh = new Map<string, PreviewBuildState>();
  states.set(deps, fresh);
  return fresh;
}

/** The project's preview build in progress or its last failure, if any. */
export const previewBuildState = (deps: Deps, projectId: string): PreviewBuildState | null =>
  previewBuildStates(deps).get(projectId) ?? null;
