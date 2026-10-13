# pad's image: the build, run by Bun on a distroless base (no shell, no
# package manager), as the nonroot user, with the database in /data.
#
# The build is JavaScript, the same on every architecture: it runs once, on
# the builder's own platform, and only the last stage is per-architecture.
# SOURCE_DATE_EPOCH (the release's commit time) makes it the same bytes for
# the same commit (vite.config.ts).
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2-slim AS build
ARG SOURCE_DATE_EPOCH
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# Building loads the server code, which opens a database.
RUN PAD_DB=/tmp/pad.db bun run build && mkdir -m 700 /data

FROM oven/bun:1.4.2-distroless
COPY --from=build /src/build /app
# For `docker exec`: install.org, Backups.
COPY --from=build /src/scripts/backup.ts /app/backup.ts
COPY --from=build --chown=65532:65532 /data /data
ENV HOST=0.0.0.0 \
    PORT=5512 \
    PAD_DB=/data/pad.db \
    BODY_SIZE_LIMIT=1M
VOLUME /data
EXPOSE 5512
USER 65532:65532
HEALTHCHECK --interval=30s --timeout=5s \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:5512/_/limits').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["bun", "/app/index.js"]
