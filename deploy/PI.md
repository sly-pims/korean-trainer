# Deploying the Korean Daily Trainer to a Raspberry Pi

One-time setup for a Pi (Raspberry Pi OS Lite, 64-bit) exposing the trainer over
HTTPS via Caddy + DuckDNS.

## 1. OS prerequisites

Only system deps needed: **Node.js ≥ 20** and **ffmpeg**. No native build tools
(sqlite3 is bundled inside Node as `node:sqlite`).

```bash
# Node 20 LTS from NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs ffmpeg caddy
node --version   # >= 20 (this repo targets 20–24)
ffmpeg -version  # yes, for media probes + recorder support
# User to own the app + data
sudo useradd -m -r korean
```

## 2. Get the code & dependencies

```bash
sudo mkdir -p /opt/korean-trainer
sudo chown korean:korean /opt/korean-trainer
sudo -u korean git clone <your-repo> /opt/korean-trainer
cd /opt/korean-trainer
sudo -u korean npm ci
sudo -u korean npm run build
```

Builds produce `server/dist/` (compiled Fastify) and `web/dist/` (PWA) — both are
served by the single Fastify process.

## 3. Configuration

Create `/opt/korean-trainer/deploy/.env` (the systemd unit loads it, and it stays
out of git):

```bash
# Server
HOST=0.0.0.0
PORT=8787
TZ=Pacific/Auckland
DATA_DIR=data
DB_PATH=data/korean.db

# Auth — REQUIRED before exposing the app
AUTH_PASSWORD=<long random password>
SESSION_SECRET=<long random string>
COOKIE_SECURE=1          # behind HTTPS: cookies get the Secure flag

# LLM grading (optional; without a key, writing/speaking grading is queued)
LLM_PROVIDER=gemini
GEMINI_API_KEY=
GEMINI_MODEL=            # empty = provider default model
LLM_DAILY_CAP=30

# FFmpeg (defaults to `ffmpeg`)
FFMPEG_PATH=ffmpeg

# DNS (duckdns cron)
DUCKDNS_DOMAIN=<your-domain>
DUCKDNS_TOKEN=<token>
```

## 4. HTTPS via Caddy + DuckDNS

1. Register `your-domain.duckdns.org` and copy its token.
2. In your router, forward **TCP 80 and 443** to the Pi (Caddy's ACME HTTP-01
   challenge needs port 80; TLS-ALPN uses 443).
3. Edit `deploy/Caddyfile` with your hostname and copy into place:
   ```bash
   sudo cp /opt/korean-trainer/deploy/Caddyfile /etc/caddy/Caddyfile
   sudo systemctl enable --now caddy
   ```
4. Wire the dynamic DNS to your home IP:
   ```bash
   echo "*/5 * * * * /opt/korean-trainer/deploy/duckdns.sh >/dev/null 2>&1" | sudo crontab -
   ```

## 5. Systemd service

```bash
sudo cp /opt/korean-trainer/deploy/korean-trainer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now korean-trainer
journalctl -u korean-trainer -f
curl -s http://127.0.0.1:8787/api/health
```

## 6. Backups

```bash
# Add the nightly backup cron
echo "17 3 * * * /opt/korean-trainer/deploy/backup.sh >/dev/null 2>&1" | sudo -u korean crontab -
```

`backup.sh` takes a consistent SQLite snapshot (`VACUUM INTO`) plus a tarball of
recordings and the built PWA. Sync `/opt/korean-trainer/backups` somewhere
off-box (rsync/borg).

## Updating

The repeatable Docker deployment path is:

```bash
cd /opt/korean-trainer
./deploy/update.sh
```

The script pulls fast-forwardable Git changes, rebuilds the image, recreates the
container, and preserves the bind-mounted `data/` directory.

For a manual update without Docker:

```bash
sudo systemctl stop korean-trainer
cd /opt/korean-trainer && sudo -u korean git pull && sudo -u korean npm ci && sudo -u korean npm run build
sudo systemctl start korean-trainer
```