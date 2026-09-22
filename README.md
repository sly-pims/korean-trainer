# 🇰🇷 Korean Daily Trainer

A personal, mobile-first daily Korean trainer: **reading + vocabulary + writing +
listening + speaking**, served as a PWA from a single Raspberry Pi.

- **Server** — Fastify 5 + built-in `node:sqlite` (sync, zero native builds) + zod.
  Serves both the JSON API and the built PWA. One-process deploy.
- **Web** — Vite + React 19 + TypeScript (strict). Installable PWA with offline
  shell, Web Speech synthesis for Korean TTS, SpeechRecognition for read-aloud,
  MediaRecorder for free-response speaking.
- **LLM (optional)** — Gemini for writing/speaking feedback and adaptive
  passage generation. Without a key, writing/speaking grading is *queued* and
  level stays put.
- **SRS** — SM-2 spaced repetition for tapped vocabulary (`again/hard/good/easy`),
  daily warm-up, streak tracking.

## Layout

```
seed/            static passage JSON (offline, until LLM generation is enabled)
server/          Fastify API (routes, services, llm, tests)
web/             React PWA (screens, hooks, components, theme)
data/            runtime: korean.db + recordings (gitignored)
deploy/          systemd unit, Caddyfile, DuckDNS + backup scripts, Pi guide
implementation-plan.md
```

## Quick start (dev)

```bash
npm ci
cp .env.example .env         # set AUTH_PASSWORD, SESSION_SECRET a real value
npm run dev                  # server :8787 + web :5173 with proxies
```

Open http://localhost:5173 (default dev login: `korean` — change it!).

Create a fresh database + seed later with:

```bash
npm run build
node server/dist/index.js    # serves API + web/dist at :8787
```

## Scripts

| Command            | What it does                                    |
| ------------------ | ----------------------------------------------- |
| `npm run dev`      | server (`tsx watch`) + web (Vite) together      |
| `npm run build`    | compile server (`tsc`) + bundle web (`vite`)    |
| `npm start`        | run the compiled server (serves `web/dist`)     |
| `npm test`         | server unit tests (vitest)                      |
| `npm run typecheck`| typecheck server + web                          |

## API at a glance

Auth is a signed cookie on everything except `/api/login` and `/api/health`.
Key routes: `home`, `session/start|today|step|complete`, `words`,
`srs/review`, `session/:id/{warmup,read,writing,listening,speaking,word-tap}`,
`practice/*`, `progress`, `settings`, `llm/status`, `level`.

## Config

Everything is environment variables (see `.env.example`): `AUTH_PASSWORD`,
`SESSION_SECRET`, `COOKIE_SECURE` (set `1` behind HTTPS), `TZ`, `DATA_DIR`,
`DB_PATH`, `SEED_PATH`, `WEB_DIST`, `LLM_PROVIDER`, `GEMINI_API_KEY`,
`GEMINI_MODEL`, `LLM_DAILY_CAP`, `FFMPEG_PATH`.

## Deploy to a Pi

See [`deploy/PI.md`](deploy/PI.md): Node ≥ 20 + ffmpeg + Caddy + DuckDNS,
systemd unit, nightly backups.

## Tests

`npm test` runs the server suite (streak, SRS, diff, seed/glossary and the
LLM `CallManager` with a fake provider). No database or network required.