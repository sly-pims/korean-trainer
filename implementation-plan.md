# Implementation Plan: Korean Daily Trainer

## Decisions locked in
- **Prereqs:** install Node LTS (20+, currently 24.19.0 via winget) + ffmpeg via winget (step 0)
- **Frontend:** Vite + React + TypeScript + `vite-plugin-pwa`
- **Auth:** in-app login + signed cookie guarding all `/api` routes (works standalone + behind Caddy)
- **Seed:** I author 5 passages/level for levels 1–3 (matching §8.1), full loader + validator per §9

## Repo layout (single repo, npm workspaces)
```
C:\data\Korean_Learning\
├─ package.json                  # workspaces: server, web; shared scripts
├─ .env.example / .env           # GEMINI_API_KEY, LLM_*, AUTH_PASSWORD, SESSION_SECRET, TZ
├─ seed/passages.json            # §9 seed bank
├─ server/                       # Node + TS + Fastify + node:sqlite (built-in) + zod
│  ├─ src/
│  │  ├─ index.ts / app.ts       # Fastify bootstrap, auth middleware
│  │  ├─ config.ts               # zod-validated env (+ .env via process.loadEnvFile, REPO_ROOT-relative paths)
│  │  ├─ db.ts                   # node:sqlite DatabaseSync, WAL, schema, row types
│  │  ├─ llm/                    # provider.ts (interface), gemini.ts, callManager.ts (cap/backoff/retry), errors.ts
│  │  ├─ services/               # content (pack gen+prefetch+fallback), review (writing+speaking grading), srs (SM-2), streak, diff, glossaryValidate, audio (ffmpeg WAV)
│  │  ├─ routes.ts               # auth, session, words, speaking, settings, progress, llmStatus
│  │  ├─ prompts/                # versioned templates: contentPack.ts, writingGrade.ts, speakingFeedback.ts
│  │  └─ schema/                 # zod schemas for §8.1/8.2/8.3 (shared with tests)
│  └─ test/                      # vitest: srs, streak, diffs, glossary valid, schema+retry fixtures (429, malformed JSON)
├─ web/                          # Vite React
│  ├─ src/                       # api client, screens (Home, Session stepper, SpeakingPractice, Words, Progress, Settings), audio hooks (tts, speechRec, mediaRecorder)
│  ├─ pwa / manifest + SW
└─ deploy/                       # systemd unit, Caddyfile snippet, backup script, README.md
```
`data/` (gitignored): `korean.db`, `recordings/`, `backups/`.

## Execution order (mirrors M0–M6, each runnable/verifiable)

**Step 0 — Tooling:** `winget install` Node 20 LTS + ffmpeg; `git init`; scaffold workspaces; `.env.example` + gitignore.

**M0 — Scaffold + seed session, no LLM**
- Migrations for all §5 tables (write them all now so later milestones only add logic, not schema churn).
- Seed loader validates `seed/passages.json` against the §8.1 schema at startup, logs failures, imports `source="seed"` if not present. I author 15 passages.
- API: session start/resume, read step (passage + glossary + 3 MC questions with explanations), step completion, wrap-up.
- Frontend: mobile-first CSS (≥20px Korean, large tap targets), session stepper w/ progress bar + time estimate, Home screen. Vite dev proxies `/api` to Fastify.
- ✅ *Full session finishing on a phone-sized viewport from seed data.*

**M1 — Vocab + SRS**
- Tap-to-gloss (surface→lemma→meaning, `words` + `srs_cards`), warm-up step w/ rating Again/Hard/Good/Easy, SM-2 (`ease 2.5`, interval growth — unit-tested).

**M2 — LLM generation**
- `LLMProvider` interface + `GeminiProvider` (REST, JSON output mode, audio-capable). Env: `LLM_PROVIDER`, `GEMINI_API_KEY`, `GEMINI_MODEL` (default = current flash-lite, never hard-coded).
- `callManager`: `llm_usage` daily cap (default 30), exponential backoff+jitter on 429/5xx (max 3), one retry on invalid JSON, seed fallback on failure — tests w/ 429 + malformed fixtures.
- Prefetch tomorrow's pack after session end / on first open if none; never duplicate.
- Settings screen shows LLM status (provider, calls today, last error).
- Grammar for §8.1: glossary surfaces regex-verified against passage, drop non-matching entries, not whole pack.

**M3 — Writing exercise**
- Write step: prompt tied to topic, Korean textarea (safe for IME composition). Save `writing_entries` immediately; grade via §8.2; feedback UI: corrected text w/ highlighted changes, per-issue English explanations, "more natural" line, 1–5 score.
- Offline retry: ungraded entries retried on next app open.

**M4 — Listening (dictation)**
- `speechSynthesis` ko-KR normal/slow; 3 sentences; user types what they hear; character-level diff after NFC normalize, ignoring spaces+punctuation (pure function, unit-tested).

**M5 — Speaking**
- Part A read-aloud: `SpeechRecognition` `ko-KR`, feature-detected, syllable diff + % match + mismatch-is-recognizer-not-you note; up to 3 sentences.
- Part B free response: `MediaRecorder` ≤60s → upload → ffmpeg → 16 kHz mono WAV → `generateJSONFromAudio` (§8.3): verbatim transcript, corrected diff, issues w/ confidence-labelled pronunciation notes, fluency note, 1–5 score. "Play my recording", "play corrected (TTS)", "record again", "shadow-corrected".
- Retry queue for failed audio grading; recording retention via `keep_recordings_days`; privacy notice before first mic use.
- Standalone **Speaking practice** screen (extra drills + prompts, counted against cap).

**M6 — Progress, PWA, deploy**
- Streak (timezone-aware, local TZ configurable), streak calendar, level history, per-skill score trends; level suggestion (avg last 3: ≥80 up / <50 down, user confirms on wrap-up).
- Auth: login + signed cookie, middleware on all `/api`, `SESSION_SECRET`/`AUTH_PASSWORD`. `.env.example`.
- PWA manifest + service worker (installable, works over HTTPS).
- `deploy/`: systemd unit, DuckDNS+HTTPS Caddyfile w/ basicauth note, nightly SQLite backup (keep 7), README.
- `deploy/README.md` Pi prerequisites and first-run sequence:
  1. `sudo apt update && sudo apt install -y ffmpeg curl` — ffmpeg is the only system dependency now (speaking feature converts recordings to 16 kHz mono WAV). Node 20+ ships a built-in `node:sqlite` module, so **no compilation toolchain is required**.
  2. Verify: `node -e "require('node:sqlite')"`, `ffmpeg -version`.
  3. `npm install` (pure-JS deps; fast on the Pi).
  4. `sudo apt install -y caddy` + DuckDNS setup, then start the systemd service.

## Notes / risks
- **API key absent locally:** M2 is fully testable with a mocked provider; real-key check happens at the end, plus seed-fallback path. The server disables the LLM (and all LLM calls) when `GEMINI_API_KEY` is missing.
- **No Gemini key in repo** — only in `.env` (gitignored).
- **`node:sqlite` (built-in) replaces `better-sqlite3`:** it is synchronous like better-sqlite3 (`prepare`/`run`/`get`/`all`, returns `{ changes, lastInsertRowid }`) and works on Windows and ARM Raspberry Pi with zero native deps — fully removes the `build-essential`/node-gyp prerequisite from the Pi deploy README (see M6).
- **Gemini model:** default is `gemini-3.5-flash-lite` (the earlier `gemini-2.0-flash-lite` returns 404 in 2026). LLM calls are only attempted when an API key is configured.
- **ffmpeg on the Pi:** speaking (Part B) requires it for WAV conversion. Installed on the dev machine via winget (step 0); on the Pi it must be installed separately with `sudo apt install -y ffmpeg` before the service is used. Documented in deploy README (see M6). Server health-checks `ffmpeg` at startup and logs a clear warning if missing.
- **Pi deployment** happens on your network later; I ship the config + README with the Pi prerequisites above.

## Status (Sep 2026)

Everything in M0–M6 is implemented and green:

- **Server:** all routes, services, LLM cap/backoff, seed loader working; `npm run typecheck -w server` clean;
  `npm test -w server` → 32 tests across 6 files (SRS/SM-2, streak, diff, seed/glossary, CallManager with a fake provider).
- **Smoke:** full API flow verified against a running instance on a fresh DB (auth-cookie login, session
  start → warmup → read → writing (queued, no LLM key) → listening → read-aloud → free-response → complete → progress).
- **Web:** typecheck + `vite build` green; PWA service worker + manifest generated; app compiled with 58 modules.
  Dev proxy (`/api`, `/recording` → :8787) verified; login/home/session-data round-trip verified through the proxy.
  In-browser mic/TTS steps still need a human on a phone/browser (Web Speech + MediaRecorder require HTTPS/grant).
- **Deploy:** `deploy/` contains `korean-trainer.service`, `Caddyfile`, `duckdns.sh`, `backup.js`+`backup.sh`,
  and `PI.md` (Node-only prereq: `node:sqlite` is built in; ffmpeg via apt; no build toolchain).