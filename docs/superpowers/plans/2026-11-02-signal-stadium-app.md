# Signal Stadium Full App Implementation Plan

> **For agentic workers:** Implement the tasks below in parallel where file ownership is distinct. Verify each task before calling it complete.

**Goal:** Turn Signal Stadium into a persistent, multi-device expo game that can run in rehearsal mode now and use Twilio Video, Messaging, Segment, and SendGrid when configured.

**Architecture:** A Node server owns event profiles, atomic participant slots, clocks, hidden prompts, votes, results, leads, and analytics in SQLite. Browser surfaces subscribe to sanitized state over SSE and send validated actions over HTTP. Video uses a bundled Twilio Video client when configured; a clearly labeled low-frame-rate rehearsal camera path permits local testing without credentials.

**Tech Stack:** Node 26+, `node:sqlite`, Node HTTP/SSE, browser JavaScript and CSS, official Twilio Node and Video SDKs, QRCode, jpeg-js, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-02-find-it-first-design.md`

## Global Constraints

- Explicit event slug in each screen URL; no browser-global event switch.
- 2–6 portrait players, one viewport per screen, sealed clue until GO, operator may award one, ties, or no match.
- Joining and voting need no lead form. Postgame fields are per-event and marketing choice is separate.
- No API keys or contact fields in public state, public analytics, or browser bundles.
- Saved gameplay edits affect the next heat; saved lead fields affect new requests immediately. Persist field snapshots on each lead.
- Credential setup and production deployment are the final user-owned setup steps; all code paths must have safe unconfigured states and mocked tests.

## Review Focus

1. Two simultaneous join requests receive distinct slots and cannot exceed capacity.
2. Pre-GO public API/SSE/HTML never includes the next prompt text or its ID.
3. Restart during a countdown or hunt recovers from absolute server deadlines without duplicate results.
4. Vote dedupe works per window and channel; an SMS/WhatsApp sender never becomes a lead.
5. Lead and event exports respect event/date filters and do not leak PII through public metrics or Segment.

---

### Task 1: Runtime scaffold and persistence

**Files:** `package.json`, `app/server/db.mjs`, `app/server/config.mjs`, `app/server/seed.mjs`, `app/server/test/db.test.mjs`.

**Interfaces:** `openDatabase(path)`, `createEvent(name)`, `getEvent(slug)`, `saveEvent(slug,draft,expectedRevision)`, `getRuntime(slug)`, `saveRuntime(slug,runtime)`, `recordMetric(...)`, `saveLead(...)`.

- [ ] Write failing tests for event creation, revisions, restart persistence, and lead snapshots.
- [ ] Implement SQLite schema, seed one event and curated prompt bank, and validate per-event settings.
- [ ] Run `npm test` and confirm the task tests pass.

### Task 2: Authoritative heat engine

**Files:** `app/server/engine.mjs`, `app/server/test/engine.test.mjs`.

**Interfaces:** `join`, `ready`, `leave`, `command`, `tick`, `publicState`, `operatorState` on an engine instance; each mutation persists before broadcast.

- [ ] Write failing tests for atomic slots, start modes, prompt secrecy, countdown, hunt expiry, late queue, restart, awards, ties, and no match.
- [ ] Implement timestamp-based FSM and operator audit with next-heat config snapshots.
- [ ] Run `npm test` and confirm no pre-GO clue escapes.

### Task 3: Authenticated HTTP and live state

**Files:** `app/server/http.mjs`, `app/server/auth.mjs`, `app/server/routes.mjs`, `app/server/test/api.test.mjs`.

**Interfaces:** Routes are fixed in `docs/full-app-api.md`; SSE emits `state` events and heartbeat comments.

- [ ] Write failing API tests for role checks, participant tokens, bad input, SSE sanitization, and CSV filters.
- [ ] Implement same-origin JSON API, operator sessions, public and private streams, real event QR, static files, rate limits, and preflight.
- [ ] Run `npm test` and smoke the server with HTTP clients.

### Task 4: Media and judging

**Files:** `app/server/media.mjs`, `app/server/judge.mjs`, `app/server/openai-vision.mjs`, `app/client/video-entry.js`, `app/server/test/judge.test.mjs`.

**Interfaces:** `GET /api/e/:slug/media-token`, `POST /api/e/:slug/frame`, `GET /api/e/:slug/frame/:playerId`, `POST /api/admin/e/:slug/evidence`; candidate responses enter the engine with server receipt time.

- [ ] Write failing tests for post-GO evidence, stable color matches, near ties, model uncertainty, and operator override.
- [ ] Implement transient JPEG frames, local color referee, optional server-side OpenAI image review, Twilio room-scoped tokens, and client track adapter.
- [ ] Run tests with mocked Twilio/OpenAI responses and no credentials.

### Task 5: Messaging, delivery, and analytics adapters

**Files:** `app/server/integrations.mjs`, `app/server/test/integrations.test.mjs`.

**Interfaces:** Signed Twilio inbound vote and Video callbacks, async Segment Track/Identify mirror, requested SendGrid guide delivery; all adapters report readiness.

- [ ] Write failing tests for signature rejection, MessageSid dedupe, sender/event routing, no-contact vote analytics, and disabled-provider behavior.
- [ ] Implement adapters using server-only env vars and exact public webhook URLs.
- [ ] Run tests without external credentials.

### Task 6: Arena and player screens

**Files:** `app/public/arena.*`, `app/public/player.*`, `app/public/game.css`, `app/public/assets/*`.

**Interfaces:** Consume public `/api/e/:slug`, SSE, join/ready/leave/media/lead routes; never infer or reveal a hidden prompt.

- [ ] Reuse the Signal Stadium art direction, official Twilio bug, dynamic 9:16 media grid, and real QR.
- [ ] Add camera permission, Video connect/reconnect, rehearsal transport, late queue, live timer, result and product CTA.
- [ ] Verify 2–6 players and 320×568/1280×720 with no scroll.

### Task 7: Operator, spectator, and metrics screens

**Files:** `app/public/operator.*`, `app/public/vote.*`, `app/public/metrics.*`, `app/public/login.*`.

**Interfaces:** Consume authenticated admin/operator routes and public vote route; preserve revision-aware saves, winner override, lead builder, and filters.

- [ ] Implement operator run desk, event and prompt editors, voting controls, preflight, and pause.
- [ ] Implement spectator category and creative ballots with closed/open results.
- [ ] Implement private event metrics, paged lead details, and filtered exports; check no-scroll viewports.

### Task 8: Integration and handoff

**Files:** `README.md`, `.env.example`, `docs/runbook.md`, `app/server/test/e2e.test.mjs`.

- [ ] Run end-to-end tests with independent participants, server restart, voting, judging, leads, and CSV.
- [ ] Run browser QA at desktop and mobile sizes, accessibility checks, syntax/build/test gates.
- [ ] Document local rehearsal, event operations, secrets, Twilio sender/Video setup, HTTPS, retention, and deployment checklist.
- [ ] Leave only actual Twilio account configuration and production deployment pending.
