# Hosted RepoWiki (spec 2 §2): one image, two targets. Build from the repository root:
#   docker build -f deploy/Dockerfile --target server -t repowiki-server .
#   docker build -f deploy/Dockerfile --target worker -t repowiki-worker .
# No secret is ever built in: the server reads them from Fly secrets at start-up, and a worker
# Machine gets only its job's single-use token from the server.
FROM node:24.11.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true ASTRO_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate
WORKDIR /app
# The whole repository (minus .dockerignore): sources run directly via type stripping, and the
# server's SQL migrations live under packages/server/src/db/migrations.
COPY . .
RUN pnpm install --frozen-lockfile && rm -rf /root/.cache /root/.npm

FROM base AS server
ENV REPOWIKI_MODE=production NODE_ENV=production
# Preview builds run Astro in a child: it writes packages/site/.astro and Vite's and Astro's
# caches under packages/site/node_modules, so those are the only app paths the node user owns.
RUN mkdir -p packages/site/.astro packages/site/node_modules/.vite packages/site/node_modules/.astro \
  && chown -R node:node packages/site/.astro packages/site/node_modules/.vite packages/site/node_modules/.astro
USER node
# 8787 is public (fly.server.toml's only service); 8788 is the worker listener, reached only over
# Fly's private network.
EXPOSE 8787 8788
CMD ["node", "packages/server/src/main.ts"]

FROM base AS worker
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates nftables procps util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --create-home --shell /usr/sbin/nologin worker
COPY deploy/worker-entrypoint.sh /usr/local/bin/worker-entrypoint
RUN chmod 0755 /usr/local/bin/worker-entrypoint
ENTRYPOINT ["/usr/local/bin/worker-entrypoint"]
