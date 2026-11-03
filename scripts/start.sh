#!/bin/sh
set -eu

: "${LIVE_SCAVENGER_HUNT_DB:=/tmp/live-scavenger-hunt.sqlite}"
LITESTREAM_AZURE_CONTAINER_NAME="${LITESTREAM_AZURE_CONTAINER_NAME-litestream}"
export LIVE_SCAVENGER_HUNT_DB LITESTREAM_AZURE_CONTAINER_NAME

case "${LITESTREAM_ENABLED:-0}" in
  0|1) ;;
  *) echo 'LITESTREAM_ENABLED must be 0 or 1.' >&2; exit 64 ;;
esac
case "${LITESTREAM_REQUIRE_REPLICA:-0}" in
  0|1) ;;
  *) echo 'LITESTREAM_REQUIRE_REPLICA must be 0 or 1.' >&2; exit 64 ;;
esac

if [ "${LITESTREAM_ENABLED:-0}" = 0 ]; then
  if [ "${LITESTREAM_REQUIRE_REPLICA:-0}" = 1 ]; then
    echo 'LITESTREAM_REQUIRE_REPLICA=1 requires LITESTREAM_ENABLED=1.' >&2
    exit 64
  fi
  exec node app/server/index.mjs
fi

if [ -z "${LITESTREAM_AZURE_ACCOUNT_NAME:-}" ] || [ -z "$LITESTREAM_AZURE_CONTAINER_NAME" ]; then
  echo 'Litestream is enabled but its Azure account or container name is missing.' >&2
  exit 64
fi
case "$LIVE_SCAVENGER_HUNT_DB" in
  /*) ;;
  *) echo 'LIVE_SCAVENGER_HUNT_DB must be an absolute path when Litestream is enabled.' >&2; exit 64 ;;
esac

exec node scripts/with-blob-lease.mjs
