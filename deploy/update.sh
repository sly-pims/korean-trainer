#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

cd "${APP_DIR}"
git pull --ff-only
docker compose up -d --build --force-recreate korean-trainer
docker compose ps korean-trainer