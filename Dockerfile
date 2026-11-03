# syntax=docker/dockerfile:1

FROM node:26-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY app/client ./app/client
COPY app/public ./app/public
RUN npm run build

FROM debian:bookworm-slim AS litestream
ARG TARGETARCH=amd64
ARG LITESTREAM_VERSION=0.5.17
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) archive_arch=x86_64; checksum=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d ;; \
      arm64) archive_arch=arm64; checksum=f8ca4a050095c1efbda2c4365172e61bf9d955ea0d9ac42f448b52e51819baa5 ;; \
      *) echo "Unsupported Litestream architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    curl --fail --location --silent --show-error \
      "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-${archive_arch}.tar.gz" \
      --output /tmp/litestream.tar.gz; \
    printf '%s  %s\n' "$checksum" /tmp/litestream.tar.gz | sha256sum --check; \
    mkdir -p /tmp/litestream; \
    tar -xzf /tmp/litestream.tar.gz -C /tmp/litestream; \
    install -m 0755 /tmp/litestream/litestream /usr/local/bin/litestream

FROM node:26-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    LIVE_SCAVENGER_HUNT_DB=/tmp/live-scavenger-hunt.sqlite \
    LITESTREAM_AZURE_CONTAINER_NAME=litestream
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY app/server ./app/server
COPY --from=build /app/app/public ./app/public
COPY docs/concepts/find-it-first-challenge-library.md ./docs/concepts/find-it-first-challenge-library.md
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY litestream.yml /etc/litestream.yml
COPY scripts/start.sh scripts/with-blob-lease.mjs ./scripts/

# Litestream watches a fast local SQLite database and replicates it to Blob.
RUN mkdir -p /app/app/data /app/scripts && chown -R node:node /app/app/data /app/scripts
USER node

EXPOSE 8080
CMD ["sh", "scripts/start.sh"]
