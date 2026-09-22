#!/usr/bin/env bash
# Nightly backup for the Korean Daily Trainer.
# Add to crontab (e.g. 03:17 nightly):
#   17 3 * * * /opt/korean-trainer/deploy/backup.sh >/dev/null 2>&1
set -euo pipefail

APP_DIR="${1:-/opt/korean-trainer}"
DEST="${2:-${APP_DIR}/backups}"
KEEP=${3:-14}

DATA_DIR="${APP_DIR}/data"
STAMP="$(date +%F_%H%M)"
mkdir -p "${DEST}"

# Consistent SQLite snapshot (ignores a few moments of a live writer).
cd "${APP_DIR}"
node "${APP_DIR}/deploy/backup.js" "${DATA_DIR}" "${DEST}/korean-${STAMP}.db"

# Pack recordings + any runtime artefacts alongside the snapshot.
tar -czf "${DEST}/trainer-${STAMP}.tar.gz" \
  -C "${APP_DIR}" --transform "s,^,trainer-${STAMP}/," \
  data/recordings \
  "data/korean.db" \
  "web/dist" 2>/dev/null || true

# Prune old backups.
find "${DEST}" -name 'korean-*.db' -mtime "+${KEEP}" -delete 2>/dev/null || true
find "${DEST}" -name 'trainer-*.tar.gz' -mtime "+${KEEP}" -delete 2>/dev/null || true

echo "backup done -> ${DEST}/trainer-${STAMP}.tar.gz"