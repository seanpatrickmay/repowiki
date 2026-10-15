import { loadConfig } from "./config.ts";
import { loadProfile } from "./github/profile.ts";
import { startServer, startupFailure } from "./wiring.ts";

/**
 * `pnpm hosted:serve` (production, configured by the environment), `hosted:dev`, `hosted:local`
 * (development as a snapshot's GitHub user, M14g) and `hosted:demo` (spec 2 §2). A
 * configuration error names the variable, never its value; any other start-up error prints only
 * its name and code.
 */
try {
  const config = loadConfig(process.env);
  const server = await startServer(config);
  process.stdout.write(`${JSON.stringify({ started: config.mode, urls: server.urls })}\n`);
  if (config.localProfile !== null) {
    const { login } = loadProfile(config.localProfile).user;
    process.stdout.write(`RepoWiki local: open ${config.origin}/ and sign in as ${login}.\n`);
  }
  if (config.mode === "demo") {
    process.stdout.write(
      `RepoWiki demo: open ${config.origin}/ and sign in (no GitHub account needed).\n`,
    );
  }
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} catch (error) {
  process.stderr.write(`${startupFailure(error)}\n`);
  process.exit(1);
}
