#!/usr/bin/env bash
# DuckDNS updater for the Korean trainer (Raspberry Pi).
# Put in cron: */5 * * * * /opt/korean-trainer/deploy/duckdns.sh >/dev/null 2>&1
set -euo pipefail

DOMAIN="${DUCKDNS_DOMAIN:?set DUCKDNS_DOMAIN in deploy/.env, e.g. my-trainer}"
TOKEN="${DUCKDNS_TOKEN:?set DUCKDNS_TOKEN (token for my-trainer.duckdns.org)}"

IP="$(curl -fsS https://api.ipify.org)"

curl -fsS "https://www.duckdns.org/update?domains=${DOMAIN}&token=${TOKEN}&ip=${IP}" -o /dev/null