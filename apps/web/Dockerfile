# syntax=docker/dockerfile:1
# Build context must be the repository root:
#   docker build -f apps/web/Dockerfile -t vulnstack-web .
FROM node:22-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1 \
    CI=1
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate

FROM base AS build
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN mkdir -p apps/web/public \
 && pnpm turbo run build --filter=@vulnstack/web...
# Next's file tracing can't see the native `import('@vulnstack/db')`, so the db
# package and its whole production dependency tree (core, p-limit, ...) are
# deployed on their own and replace the incomplete traced copy below.
RUN pnpm --filter @vulnstack/db deploy --prod --legacy /deploy/db

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    VULNSTACK_MIGRATIONS_DIR=/app/packages/db/drizzle
WORKDIR /app
RUN groupadd --system --gid 1001 vulnstack \
 && useradd --system --uid 1001 --gid vulnstack --home-dir /app vulnstack
COPY --from=build --chown=vulnstack:vulnstack /repo/apps/web/.next/standalone ./
COPY --from=build --chown=vulnstack:vulnstack /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=vulnstack:vulnstack /repo/apps/web/public ./apps/web/public
COPY --from=build --chown=vulnstack:vulnstack /repo/packages/db/drizzle ./packages/db/drizzle
COPY --from=build --chown=vulnstack:vulnstack /deploy/db /app/apps/web/node_modules/@vulnstack/db
RUN mkdir -p /app/apps/web/.data && chown vulnstack:vulnstack /app/apps/web/.data
USER vulnstack
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
