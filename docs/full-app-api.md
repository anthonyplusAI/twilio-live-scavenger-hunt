# Live Scavenger Hunt app API contract

This is the contract for `app/`. All times are UTC ISO strings or epoch milliseconds from the server. Every route is event-scoped by immutable slug. All JSON errors have `{ "error": "...", "code": "..." }` and an appropriate HTTP status. A stale event revision returns `409` with the latest revision.

## Browser routes

`/e/:slug/arena`, `/e/:slug/play`, `/e/:slug/vote`, `/e/:slug/operator`, `/e/:slug/metrics`, and `/login`. The operator and metrics pages may load publicly, but their data and actions require an authenticated session. `/` redirects to the seeded event arena. Arena and player pages accept `?demo=win|lose|tie|no-match` for local, read-only visual previews; they do not join a heat, connect media, judge, or write activity.

## Public state

`GET /api/e/:slug` returns `{ event, state, serverTime }`. `GET /api/e/:slug/stream` sends initial and changed payloads in SSE `state` events, with keepalive comments. `event` contains public event name, player range, timing, lead form and voting settings, and media mode; it never contains the prompt deck or secrets.

`state` has `{ eventId, phase, heat, version, paused, roster, queuedCount, readyCount, lockedCount, readyDeadline, countdownEndsAt, roundEndsAt, resultEndsAt, prompt, winners, vote }`. Each current-heat roster item is `{ id, alias, slot, status, mediaConnected }`; queued players appear only in the operator state `queue`, while public state exposes their count. A removed player is excluded from the roster and queue. `prompt` is omitted before GO, then `{ id, text, category, seconds, judgeMode }`. `winners` is an array of player IDs. `vote` is absent unless a vote window exists; when present it has `{ id, type, status, closesAt, options, tallies, result }` and never reveals phone numbers. Wall and player clients compute countdowns from server deadlines and `serverTime`.

`GET /api/e/:slug/qr.svg?target=play|vote` returns a real SVG QR for the event's absolute HTTPS/public URL (local development may use localhost). `/api/e/:slug/frame/:playerId` requires an authenticated operator session and serves only the latest transient rehearsal/evidence JPEG for a visible player; no frames are saved to the database.

## Player and spectator actions

| Route | Input | Response |
| --- | --- | --- |
| `POST /api/e/:slug/join` | `{alias,displayConsent:true}` | `{player:{id,alias,slot,status,heat},token,state}`. A non-lobby join queues for the next heat. |
| `GET /api/e/:slug/me` | `Authorization: Bearer <player token>` | `{player,state}`. |
| `POST /api/e/:slug/ready` | Player bearer token | `{player,state}`; requires media ready or explicit rehearsal mode. |
| `POST /api/e/:slug/heartbeat` | Player bearer token | `{player,state}`. The player page sends this about every five seconds while open. |
| `POST /api/e/:slug/leave` | Player bearer token | `{state}`; marks the session left and releases the slot. The player page also stops its local camera. |
| `GET /api/e/:slug/media-token` | Player bearer token | `{mode,token?,roomName?,identity?}`. Twilio tokens are room-scoped. |
| `POST /api/e/:slug/frame` | Player bearer token, `image/jpeg` body, max 150 KB | `{ok:true}`; rehearsal frames and evidence only, rate-limited. |
| `POST /api/e/:slug/votes` | `{windowId,choice}`; anonymous voter cookie | `{accepted:true,vote}` or `409` duplicate/closed. A vote never creates a lead. |
| `POST /api/e/:slug/leads` | Player bearer token, `{intent:"guide"|"expert",fieldValues,marketingOptIn}` | `{leadId,deliveryStatus}`; validates event's current form and stores its field snapshot. |
| `POST /api/e/:slug/activity` | `{type}` from an allowlist | `{ok:true}`. Contact fields are rejected. |

After an operator removes a player, that token receives HTTP `403` with `code: "player_kicked"` on authenticated player routes. The phone turns off its camera and shows a removal screen. Missing, left, or expired player tokens receive `401`. The server also marks stale sessions left when heartbeats stop: about 25 seconds for waiting/queued players and 60 seconds during a heat.

## Authentication and operator actions

`POST /api/auth/login` takes `{username,password}` and sets an HttpOnly SameSite session cookie. `GET /api/auth/session` returns `{user:{id,username,role},csrfToken}`. Admin/operator mutations require `X-CSRF-Token`; `POST /api/auth/logout` ends the session. Admin can configure events and view leads; operator can run heats and review candidates. `scripts/create-user.mjs` bootstraps users; a first run with no users prints a generated one-time admin password to the server terminal.

| Route | Role | Input / output |
| --- | --- | --- |
| `GET /api/admin/events` | operator | `{events:[{id,slug,name,revision}]}` |
| `POST /api/admin/events` | admin | `{name,slug?}` → `{event}` |
| `GET /api/admin/e/:slug` | operator | `{event,state,serverTime}`; full prompt deck and operator details. |
| `GET /api/admin/e/:slug/stream` | operator | SSE `state` events with full operator payload. |
| `PUT /api/admin/e/:slug` | admin | `{event,expectedRevision}` → `{event}`; revisioned save. Reducing lobby capacity moves excess players to the next-heat queue. |
| `POST /api/admin/e/:slug/command` | operator | `{type,payload}` → `{state}`. Types: `start`, `pause`, `resume`, `queuePrompt`, `kickPlayer`, `proposeWinner`, `award`, `noMatch`, `correctHeat`, `nextHeat`, `reset`, `openVote`, `closeVote`, `selectCategory`. Awards include an array of player IDs and a reason. `correctHeat` takes `{heatId,winners,reason}` for a completed heat; an empty array records no match. |
| `GET /api/admin/e/:slug/media-token?role=wall` | operator | Twilio subscriber token or rehearsal mode. |
| `POST /api/admin/e/:slug/evidence` | operator | `{playerId,imageBase64}` → `{candidate}`; server stamps receipt before judging. |
| `GET /api/admin/e/:slug/preflight` | operator | `{checks:[{name,status,detail}]}` for Video, AI, messaging, Segment, SendGrid, HTTPS. |
| `GET /api/admin/report?event=all|:slug&from=YYYY-MM-DD&to=YYYY-MM-DD` | admin | `{summary,activity,leads,events}`; private lead data. |
| `GET /api/admin/export?kind=leads|events&event=all|:slug&from=...&to=...` | admin | UTF-8 CSV. |
| `DELETE /api/admin/leads/:id` | admin | `{ok:true}`; deletes an individual lead. |

The operator state also includes a five-heat `recentHeats` list with prompt, player IDs, and winners so an operator can correct a completed result after advancing the arena.

`kickPlayer` takes `payload: {playerId}` for a current-heat or queued player. It clears the slot, invalidates the token, records `player_kicked`, and removes that player from candidates and creative ballots. If the player had already won the displayed result, the stored winner list is corrected. Its response adds `mediaDisconnect: {status:"ok",mode,disconnected}` on a successful Twilio disconnect attempt or `{status:"failed"}` if the media operation fails; the player is removed from the game in either case.

The private report summary includes `kickedPlayers`, `timedOutPlayers`, and `playerLeaves` alongside joins, plays, heats, votes, CTA activity, and leads. These are distinct activity counts within the requested event/date filter.

Twilio signed webhooks live at `/webhooks/twilio/messaging` and `/webhooks/twilio/video`. They validate the exact public URL and `X-Twilio-Signature`, then deduplicate message/event IDs before changing state or metrics.
