#!/usr/bin/env bash
# Nightly backup for the trainer.
#
# The Pi host runs Node 20, which has no node:sqlite, so the snapshot is taken
# inside a throwaway node:24 container (the same base image the app is built
# from) rather than on the host.
#
# Install with:
#   17 3 * * * /root/stacks/korean-trainer/deploy/backup.sh >/var/log/trainer-backup.log 2>&1
set -euo pipefail

APP_DIR="${1:-/root/stacks/korean-trainer}"
DEST="${2:-${APP_DIR}/data/backups}"
KEEP="${3:-14}"
NODE_IMAGE="${NODE_IMAGE:-node:24-bookworm-slim}"

DATA_DIR="${APP_DIR}/data"
STAMP="$(date -u +%F_%H%M%S)"
DB_SNAPSHOT="${DEST}/korean-${STAMP}.db"
REC_TAR="${DEST}/recordings-${STAMP}.tar.gz"

mkdir -p "${DEST}"

# 1. Consistent SQLite snapshot via VACUUM INTO. This is the important one:
#    the live database is in WAL mode, so a plain file copy of korean.db would
#    silently lose everything still sitting in korean.db-wal.
# DEST is mounted at the identical path inside the container so that the
# snapshot lands exactly where the caller asked, even when DEST is outside DATA_DIR.
# VACUUM INTO refuses to overwrite an existing file, hence the second-granularity
# stamp above; without it a re-run inside the same minute aborts.
docker run --rm \
  -v "${DATA_DIR}:/data" \
  -v "${DEST}:${DEST}" \
  -v "${APP_DIR}/deploy:/deploy:ro" \
  "${NODE_IMAGE}" \
  node /deploy/backup.js /data "${DB_SNAPSHOT}" \
  || { echo "FATAL: snapshot step failed (node image present? ${NODE_IMAGE})" >&2; exit 1; }

# 2. Recordings alongside it. The raw database is deliberately NOT tarred: it
#    is WAL-mode, so a bare copy of korean.db without its -wal is incomplete.
#    The VACUUM INTO snapshot above is the authoritative database copy.
if [ -d "${DATA_DIR}/recordings" ]; then
  tar -czf "${REC_TAR}" -C "${DATA_DIR}" recordings
fi

# 3. Fail loudly if the snapshot is missing or suspiciously small.
if [ ! -s "${DB_SNAPSHOT}" ]; then
  echo "FATAL: snapshot missing or empty: ${DB_SNAPSHOT}" >&2
  exit 1
fi

# 4. Prune old backups.
find "${DEST}" -name 'korean-*.db'        -mtime "+${KEEP}" -delete
find "${DEST}" -name 'recordings-*.tar.gz' -mtime "+${KEEP}" -delete

echo "$(date -u +%FT%TZ) backup ok -> ${DB_SNAPSHOT} ($(stat -c%s "${DB_SNAPSHOT}") bytes)"
