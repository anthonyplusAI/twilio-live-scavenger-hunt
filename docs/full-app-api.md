# Live Scavenger Hunt app API contract

This is the contract for `app/`. All times are UTC ISO strings or epoch milliseconds from the server. Every route is event-scoped by immutable slug. All JSON errors have `{ "error": "...", "code": "..." }` and an appropriate HTTP status. A stale event revision returns `409` with the latest revision.

## Browser routes

`/e/:slug/arena`, `/e/:slug/play`, `/e/:slug/vote`, `/e/:slug/operator`, `/e/:slug/metrics`, and `/login`. The operator and metrics pages may load publicly, but their data and actions require an authenticated session. `/` redirects to the seeded event arena. `GET /favicon.ico` serves the official Twilio bug icon. `GET /e/:slug/github?source=arena_qr|arena_link` records a source-tagged repository click and returns a no-store `302` to the fixed GitHub project URL; an unknown source is rejected. The arena accepts `?demo=hunt` with an optional `players` value from 2 to 6, plus `?demo=win|lose|tie|no-match`; the phone accepts `?demo=win|lose|tie|no-match|build`. These local visual previews do not join a heat, connect media, judge, collect leads, or write activity. Their outbound product and GitHub links still navigate; the arena's preview star link bypasses the tracked redirect.

## Public state

`GET /api/e/:slug` returns `{ event, state, serverTime }`. `GET /api/e/:slug/stream` sends initial and changed payloads in SSE `state` events, with keepalive comments. `event` contains public event name, player range, timing, lead form and voting settings, and media mode; it never contains the prompt deck or secrets.

`state` has `{ eventId, phase, heat, version, paused, roster, queuedCount, readyCount, lockedCount, readyDeadline, countdownEndsAt, roundEndsAt, resultEndsAt, prompt, winners, vote }`. Each current-heat roster item is `{ id, alias, slot, status, mediaConnected }`; queued players appear only in the operator state `queue`, while public state exposes their count. A removed player is excluded from the roster and queue. `prompt` is omitted before GO, then `{ id, text, category, seconds, judgeMode }`. `winners` is an array of player IDs. `vote` is absent unless a vote window exists; when present it has `{ id, type, status, closesAt, options, tallies, result }` and never reveals phone numbers. Wall and player clients compute countdowns from server deadlines and `serverTime`.

`GET /api/e/:slug/qr.svg?target=play|vote|github` returns a real SVG QR. Play and vote targets encode the event's absolute HTTPS/public URL (local development may use localhost). The live GitHub target encodes the event-scoped tracked redirect with `source=arena_qr`; `target=github&preview=1` encodes the fixed GitHub repository directly so a visual preview does not write activity. `/api/e/:slug/frame/:playerId` requires an authenticated operator session and serves only the latest transient rehearsal/evidence JPEG for a visible player; no frames are saved to the database.

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
| `POST /api/e/:slug/activity` | `{type}` from an allowlist. `twilio_product_link_opened` also requires `product:"video"|"messaging"|"segment"`; `github_cta_opened` may include `source:"phone"|"spectator"`. The arena referral route sets its own source. | `{ok:true}`. Contact fields are rejected. |

After an operator removes a player, that token receives HTTP `403` with `code: "player_kicked"` on authenticated player routes. The phone turns off its camera and shows a removal screen. Missing, left, or expired player tokens receive `401`. The server also marks stale sessions left when heartbeats stop: about 25 seconds for waiting/queued players and 60 seconds during a heat.

## Authentication and operator actions

`POST /api/auth/login` takes `{username,password}` and sets an HttpOnly SameSite session cookie. `GET /api/auth/session` returns `{user:{id,username,role,authProvider},csrfToken}`. Admin/operator mutations require `X-CSRF-Token`; `POST /api/auth/logout` ends the session. Admin can configure events and view leads; operator can run heats and review candidates. A first run with no users prints a generated one-time admin password to the server terminal, unless `BOOTSTRAP_ADMIN_PASSWORD` was supplied. That bootstrap setting does not reset existing accounts.

`GET /api/auth/providers` is public and returns `{google:{enabled:boolean}}`. Google is enabled only when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are both present with the canonical `PUBLIC_BASE_URL`. `GET /api/auth/google/start?next=...` begins an authorization-code flow with PKCE, nonce, and one-time state; it redirects to Google when configured. `GET /api/auth/google/callback` validates that state and Google's signed ID token, sets the same staff session cookie, then redirects to a safe same-origin `next` path. A failed sign-in returns to `/login` with a short error code. The server requires a verified `@twilio.com` email and `hd=twilio.com` in the token. It keys identity by Google's stable `sub` and grants **admin** access on verified sign-in, including Team, Metrics, and leads. An existing Google operator is upgraded only on a new verified sign-in; stored email alone does not grant access. The `hd` authorization parameter is a hint, not the access check.

`POST /api/auth/password` takes `{currentPassword,newPassword}` for the signed-in local-password user and requires CSRF. It ends every session for that account, clears the current cookie, and requires a fresh sign-in. `POST /api/auth/username` takes `{currentPassword,username}` for a signed-in local-password user and also requires CSRF. It normalizes the new username to lowercase, returns `{user}`, revokes every session, clears the cookie, and requires sign-in with the new name. Usernames must start with a letter and contain 3–80 letters, numbers, dots, dashes, or underscores. Duplicate names return HTTP `409`; an incorrect current password returns `403`. Google names remain managed by Google. An admin can edit the existing primary local admin account or manage separate operator accounts through these global routes:

| Route | Role | Input / output |
| --- | --- | --- |
| `GET /api/admin/local-admin` | admin | `{admin:{id,username,role,authProvider}}`; returns the oldest local password admin account, which remains the same row after a rename. |
| `POST /api/admin/local-admin` | admin + CSRF | `{username,password?,expectedUsername?}` → `{admin,usernameChanged,passwordChanged,signedOut}`; updates that existing account atomically. Keep `username` unchanged and send a new `password` to reset it; omit `password` for a rename only. The Team editor sends `expectedUsername` from its last loaded record; if another admin renamed the account, the request returns `409` with `code: "admin_changed"` before changing it. Revokes that account's sessions; a local caller editing itself is signed out, while a Google admin caller stays signed in. No password is returned or audited. Duplicate usernames return `409`; a request with no change returns `400`. |
| `GET /api/admin/operators` | admin | `{operators:[{id,username,role,authProvider,email,createdAt}]}`; returns role=`operator` accounts. Legacy Google operators may appear until their next verified sign-in; Google admins are not listed. |
| `POST /api/admin/operators` | admin + CSRF | `{username,password}` → `{operator}` with HTTP `201`; creates an `operator` only. |
| `POST /api/admin/operators/:id/password` | admin + CSRF | `{password}` → `{operator}`; resets a local operator's password and revokes their sessions. |
| `POST /api/admin/operators/:id/username` | admin + CSRF | `{username}` → `{operator}`; renames a local operator and revokes their sessions. Admin IDs return `404`; legacy Google operator IDs return `409`. |
| `DELETE /api/admin/operators/:id` | admin + CSRF | HTTP `204`; removes a local operator and revokes their sessions. |

Local usernames are normalized to lowercase and must be 3–80 characters using letters, digits, dots, dashes, or underscores, starting with a letter. Local passwords have no minimum length or character rule; the only size ceiling is 16,384 UTF-8 bytes so even two heavily escaped passwords fit within the 240 KB auth JSON request limit. These account routes reject role elevation and Google-account password operations. `scripts/create-user.mjs` remains available for a stopped local database; the hosted container does not include that recovery script.

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

The private report summary includes `kickedPlayers`, `timedOutPlayers`, `playerLeaves`, `twilioProductLinkClicks`, `twilioProductLinkClicksByProduct: {video,messaging,segment}`, `githubRepoClicks`, and `githubRepoClicksBySource: {phone,spectator,arenaQr,arenaLink}` alongside joins, plays, heats, votes, CTA activity, and leads. These are distinct activity counts within the requested event/date filter. Historical GitHub clicks without a source count as `phone`. Outbound fields count clicks or scans through the redirect, not verified destination page loads or GitHub stars; corresponding activity events appear in the filtered event log and export.

Twilio signed webhooks live at `/webhooks/twilio/messaging` and `/webhooks/twilio/video`. They validate the exact public URL and `X-Twilio-Signature`, then deduplicate message/event IDs before changing state or metrics.
