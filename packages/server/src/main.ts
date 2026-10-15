import { ConfigError, loadConfig } from "./config.ts";
import { startServer } from "./wiring.ts";

/**
 * `pnpm hosted:serve` (production, configured by the environment), `hosted:dev` and
 * `hosted:demo` (spec 2 §2). A configuration error names the variable, never its value.
 */
try {
  const config = loadConfig(process.env);
  const server = await startServer(config);
  process.stdout.write(`${JSON.stringify({ started: config.mode, urls: server.urls })}\n`);
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
  const message =
    error instanceof ConfigError
      ? error.message
      : `The server failed to start (${error instanceof Error ? error.name : "unknown"}).`;
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
