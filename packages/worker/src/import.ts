import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type PeopleSnapshot, WikiExport } from "@repowiki/core";
import { pathLanguageName } from "@repowiki/engine";
import {
  detectTechnologies,
  Facts,
  type JobStep,
  SnapshotTechnology,
  type TechnologyUse,
} from "@repowiki/hosted";
import { z } from "zod";
import { ApiError, type WorkerApi, workerApi } from "./api.ts";
import { authorFacts, type FileFacts, languageShares, pageFeatureIds } from "./facts.ts";
import { AUTHOR_ID } from "./people-file.ts";
import { HEARTBEAT_MS, heartbeater, phase1, phase2 } from "./run.ts";
import { fallbackSuggestions } from "./suggestions.ts";

/**
 * The worker's `import` mode (M14g, local testing only): instead of cloning and building, it
 * uploads the wiki the user already built (`~/.repowiki/<repo>/export.json`), named by the
 * local profile the server serves as its fake GitHub. No model is called.
 */

type Person = PeopleSnapshot["people"][number];
export interface Author {
  login: string;
  name: string | null;
}

/** What import needs of the server's `LocalProfile`. */
export const ImportProfile = z.object({
  user: z.object({ login: z.string().min(1), name: z.string().nullable() }),
  repos: z.array(
    z.object({
      repo: z.object({ full_name: z.string(), description: z.string().nullish() }),
      export: z.string().nullable(),
      /** The snapshot's technology paths and files (ADR-0014); absent from older snapshots. */
      technology: SnapshotTechnology.optional(),
    }),
  ),
});
export type ImportProfile = z.infer<typeof ImportProfile>;

const STEPS: readonly JobStep[] = [
  "fetch",
  "index",
  "manifest",
  "write",
  "people",
  "facts",
  "render",
];

/** `Sean May`, `sean-may` and `SEAN_MAY` all give `sean-may`; empty for a name with no letters. */
const slug = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const keys = (names: readonly string[]) =>
  new Set(names.flatMap((n) => [n.trim().toLowerCase(), slug(n)]).filter((k) => k !== ""));

/**
 * The People snapshot's human whose id, name or other names equal the author's login, or else
 * their display name, ignoring case and spacing. Null when nobody matches or two people do:
 * the author never gets someone else's numbers.
 */
export function matchAuthor(snapshot: PeopleSnapshot, author: Author): Person | null {
  const humans = snapshot.people.filter((p) => p.kind === "human");
  const named = (name: string) => {
    const wanted = keys([name]);
    return humans.filter((p) =>
      [...keys([p.id, p.name, ...p.otherNames])].some((k) => wanted.has(k)),
    );
  };
  for (const name of [author.login, author.name]) {
    if (name === null) continue;
    const found = named(name);
    if (found.length === 1) return found[0] ?? null;
    if (found.length > 1) return null;
  }
  return null;
}

/**
 * Prose and data formats an infobox can list; the languages line is about code, as it is in
 * an engine run, which counts only the languages it parses.
 */
const NOT_CODE = new Set([
  "CSV",
  "INI",
  "JSON",
  "Markdown",
  "reStructuredText",
  "Text",
  "TOML",
  "XML",
  "YAML",
]);

/**
 * A generation's facts from a built export: indexed files and code languages from the page
 * infoboxes (each page's lines split across its code languages by how many of its member files
 * each has, evenly when none can be told; a page with no code language is left out of the
 * shares), the author's share from People. Zeros when People is off or does not name the author.
 */
export function exportFacts(
  exp: WikiExport,
  author: Author,
  technologies: readonly TechnologyUse[] = [],
): Facts {
  const counts = new Map<string, Map<string, number>>();
  for (const [path, { featureId }] of Object.entries(exp.manifest.membership)) {
    const raw = pathLanguageName(path);
    if (raw === undefined) continue;
    const name = raw === "TSX" ? "TypeScript" : raw;
    const page = counts.get(featureId) ?? new Map<string, number>();
    page.set(name, (page.get(name) ?? 0) + 1);
    counts.set(featureId, page);
  }
  const files = exp.pages.flatMap(({ featureId, infobox }): FileFacts[] => {
    const langs = [
      ...new Set(
        infobox.languages
          .filter((l) => !NOT_CODE.has(l))
          .map((l) => (l === "TSX" ? "TypeScript" : l)),
      ),
    ];
    if (langs.length === 0) {
      const skipped = infobox.languages.length > 0 ? "not-code" : null;
      return [{ language: null, loc: infobox.loc, skipped }];
    }
    const members = counts.get(featureId);
    const weights = langs.map((l) => members?.get(l) ?? 0);
    const total = weights.reduce((sum, w) => sum + w, 0);
    return langs.map((language, i) => ({
      language,
      loc: total === 0 ? infobox.loc / langs.length : (infobox.loc * (weights[i] ?? 0)) / total,
      skipped: null,
    }));
  });
  const featureIds = pageFeatureIds(exp);
  const snapshot = exp.people?.snapshot ?? null;
  const person = snapshot === null ? null : matchAuthor(snapshot, author);
  return Facts.parse({
    languages: languageShares(files),
    indexedFiles: exp.pages.reduce((sum, page) => sum + page.infobox.files, 0),
    featureIds,
    author: authorFacts(
      snapshot && { ...snapshot, people: person === null ? [] : [{ ...person, id: AUTHOR_ID }] },
      featureIds,
    ),
    technologies,
  });
}

/**
 * The technologies the snapshot's files show, detected as production detects them but with no
 * import data, so every declared library in the table counts (ADR-0014); none without files.
 */
export function snapshotTechnologies(
  technology: ImportProfile["repos"][number]["technology"],
  log: (line: object) => void = () => {},
): TechnologyUse[] {
  if (technology === undefined) return [];
  const found = detectTechnologies({
    paths: technology.paths,
    sources: new Map(technology.files.map((f) => [f.path, f.text])),
    imports: null,
  });
  if (found.unparsed.length > 0) log({ import: "unparsed manifests", paths: found.unparsed });
  return found.technologies;
}

/** Why an import cannot go on; the message is the whole log line (no secret is in it). */
class Refused extends Error {}

const entryFor = (profile: ImportProfile, fullName: string) =>
  profile.repos.find((r) => r.repo.full_name.toLowerCase() === fullName.toLowerCase());

function localWiki(profile: ImportProfile, fullName: string, sha: string): WikiExport {
  const entry = entryFor(profile, fullName);
  const missing = `no local wiki for ${fullName}; build it with pnpm wiki:build`;
  if (entry?.export == null) throw new Refused(missing);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(entry.export, "utf8"));
  } catch {
    throw new Refused(missing);
  }
  const parsed = WikiExport.safeParse(raw);
  if (!parsed.success) throw new Refused(`the local wiki for ${fullName} does not parse`);
  if (parsed.data.head !== sha) {
    throw new Refused(`the local wiki for ${fullName} changed; take the profile snapshot again`);
  }
  return parsed.data;
}

/** A 401 or 409: the token is spent or the lease is gone, so there is no job left to fail. */
const leaseLost = (error: unknown) =>
  error instanceof ApiError && (error.status === 401 || error.status === 409);

/** Leases the job, then uploads the repository's local wiki as its generation. */
export async function runImport(
  api: WorkerApi,
  profile: ImportProfile,
  options: {
    stepMs?: number;
    heartbeatMs?: number;
    log?: (line: object) => void;
    /** Runs a correction job as production does: it has no local wiki to upload (ADR-0023). */
    engine?: () => Promise<boolean>;
  } = {},
): Promise<boolean> {
  const log = options.log ?? (() => {});
  const beats = heartbeater(api, options.heartbeatMs ?? HEARTBEAT_MS, log);
  try {
    const spec = await api.lease();
    if (spec.kind === "correct") {
      if (options.engine !== undefined) return await options.engine();
      throw new Refused("a correction needs the engine");
    }
    const exp = localWiki(profile, spec.repo.fullName, spec.commitSha);
    const technology = entryFor(profile, spec.repo.fullName)?.technology;
    const facts = exportFacts(exp, profile.user, snapshotTechnologies(technology, log));
    for (const step of STEPS) {
      await beats.step(step);
      if (step === "index" && (await api.indexed(facts.indexedFiles)) === "too-large") return false;
      if ((options.stepMs ?? 150) > 0) await sleep(options.stepMs ?? 150);
    }
    await api.putExport(new TextEncoder().encode(JSON.stringify(exp)));
    await api.succeed({
      suggestions: fallbackSuggestions(
        exp,
        facts,
        entryFor(profile, spec.repo.fullName)?.repo.description ?? null,
      ),
      facts,
      engineVersion: "import",
      models: ["none"],
    });
    return true;
  } catch (error) {
    log(
      error instanceof Refused
        ? { import: error.message }
        : { import: "failed", error: errorName(error) },
    );
    if (!leaseLost(error)) await api.fail("job-failed").catch(() => {});
    return false;
  } finally {
    beats.stop();
  }
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

const ImportEnv = z.object({
  REPOWIKI_API_URL: z.string().regex(/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/),
  REPOWIKI_JOB_TOKEN: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  REPOWIKI_PROFILE: z.string().min(1),
});

/**
 * `REPOWIKI_WORKER_MODE=import`: reads its own environment (a loopback server, the token and the
 * profile) and deletes the token and URL from it, like the other modes.
 */
export async function importMain(log: (line: object) => void): Promise<boolean> {
  const parsed = ImportEnv.safeParse(process.env);
  delete process.env.REPOWIKI_JOB_TOKEN;
  delete process.env.REPOWIKI_API_URL;
  if (!parsed.success) {
    log({ worker: "bad environment", fields: parsed.error.issues.map((i) => i.path.join(".")) });
    return false;
  }
  const env = parsed.data;
  const api = workerApi(env.REPOWIKI_API_URL, env.REPOWIKI_JOB_TOKEN);
  let profile: ImportProfile;
  try {
    profile = ImportProfile.parse(JSON.parse(readFileSync(env.REPOWIKI_PROFILE, "utf8")));
  } catch {
    log({ import: "REPOWIKI_PROFILE does not name a profile snapshot" });
    await api.fail("job-failed").catch(() => {});
    return false;
  }
  // A correction clones the repository from GitHub and runs wiki:correct through the server's
  // LLM proxy, as a production job does.
  const engine = async () => {
    const workDir = mkdtempSync(join(tmpdir(), "repowiki-job-"));
    const deps = { api, token: env.REPOWIKI_JOB_TOKEN, workDir, engineVersion: "import", log };
    try {
      return (await phase1(deps)) && (await phase2(deps));
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  };
  return runImport(api, profile, { log, engine });
}
