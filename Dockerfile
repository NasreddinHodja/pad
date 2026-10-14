# pad's image: the build, run by Bun on a distroless base (no shell, no
# package manager), as the nonroot user, with the database in /data.
#
# The build is JavaScript, the same on every architecture: it runs once, on
# the builder's own platform, and only the last stage is per-architecture.
# SOURCE_DATE_EPOCH (the release's commit time) makes it the same bytes for
# the same commit (vite.config.ts).
#
# Each base image is pinned by its digest, the hash of its contents, with
# the tag for people to read: a tag can be moved to other contents, a
# digest can't, so a release runs the Bun it was tested on. Moving to a new
# Bun means both lines and package.json's packageManager, each with its
# tag's own digest, which covers every architecture:
#   curl -s https://hub.docker.com/v2/repositories/oven/bun/tags/<tag> |
#     bun -e 'console.log((await Bun.stdin.json()).digest)'
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS build
ARG SOURCE_DATE_EPOCH
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# Building loads the server code, which opens a database.
RUN PAD_DB=/tmp/pad.db bun run build && mkdir -m 700 /data
# remove.ts imports the app's name rules: bundled into one file.
RUN bun build scripts/remove.ts --target=bun --outfile=/src/remove.js

FROM oven/bun:1.4.2-distroless@sha256:1a0c31c7c5f9d193aedf60fe1cebdeb76ac8f6e29f24be8dd8cbd6df72df26ec
COPY --from=build /src/build /app
# For `docker exec`: install.org, Backups and Abuse.
COPY --from=build /src/scripts/backup.ts /app/backup.ts
COPY --from=build /src/remove.js /app/remove.js
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
