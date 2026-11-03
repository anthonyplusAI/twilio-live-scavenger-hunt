# Live Scavenger Hunt runbook

This guide covers a local rehearsal and the setup still needed for a public expo. The app stores each event's configuration, heat state, players, ballots, metrics, and requested leads in SQLite. Twilio credentials and production deployment are deliberately left for the event owner.

## 1. Install and sign in

From the repository root, use Node.js 26 or newer:

```sh
npm ci
npm run build
cp .env.example .env
npm start
```

The first start creates `app/data/live-scavenger-hunt.sqlite` and prints a generated `admin` password **once** in that server terminal. An existing `app/data/signal-stadium.sqlite` is reused so earlier settings, leads, and metrics remain available; its original seeded event is renamed in place. Save the password in your secret manager. Sign in at `/login` or the event's `/operator` URL. The server reloads `.env` only when it starts; restart after changing secrets. `npm run check` builds the Video browser bundle and runs the test suite.

To create another admin or a limited booth operator, stop the service and run:

```sh
node scripts/create-user.mjs --username booth-operator --role operator
```

The command prints a one-time generated password. Use `--role admin` for someone who may edit events and view leads. Add `--password-stdin` to supply a password without putting it in a shell argument. If you set `LIVE_SCAVENGER_HUNT_DB`, export the same value in the shell before running this CLI; the CLI does not load `.env` by itself. The earlier `SIGNAL_STADIUM_DB` setting remains supported for existing installs.

## 2. Rehearse without external credentials

Leave `REHEARSAL_MODE` blank or set it to `on`. Without complete Twilio Video credentials, the server uses rehearsal mode automatically. Open the seeded event at:

| Purpose | Path |
| --- | --- |
| Arena wall | `/e/live-scavenger-hunt/arena` |
| Player | `/e/live-scavenger-hunt/play` |
| Spectator vote | `/e/live-scavenger-hunt/vote` |
| Operator and event settings | `/e/live-scavenger-hunt/operator` |
| Admin-only metrics and leads | `/e/live-scavenger-hunt/metrics` |

Rehearsal mode sends small JPEG snapshots over the local app connection. It proves the join, arena, clock, judging, vote, lead, and reporting flow; it is lower frame rate than a Twilio Video Room. Camera access requires a secure browser context. `http://localhost` and `http://127.0.0.1` work for a camera on the same computer; phones scanning the live arena's play, vote, or tracked GitHub QR need a reachable **HTTPS** URL. Set `PUBLIC_BASE_URL` to that exact public origin so all QR targets and signed callbacks use the correct address.

## 3. Prepare each event

An admin creates an event in the control room. Each event has an immutable slug and separate player queue, prompt deck, voting settings, leads, and metrics. Set its name, venue and IANA time zone, player capacity (two to six), round/join/result timers, start mode, judging policy, auto-advance, lead retention, and optional form and vote settings. Save changes; the revision number increases. A stale tab gets a conflict response and must reload before saving.

| Start mode | Automatic start |
| --- | --- |
| Flexible | The configured maximum is ready, or the join window expires with the minimum ready. |
| At capacity | The configured maximum is ready. |
| After wait | The join window expires with the minimum ready. |
| Operator | Only a booth operator starts the heat. |

An operator may start a heat once the configured minimum is ready, regardless of the automatic rule. The clue is selected and sealed when the roster locks. The countdown does **not** expose it to the public API or pages; it appears at GO. The selected prompt and game rules are snapshotted for that heat, so later edits apply to later heats. Reducing capacity during a lobby moves excess slots into the next-heat queue. A joining visitor after lock also waits in that queue. The operator can pause/resume, queue an approved prompt, accept or replace a referee proposal, award one or multiple winners, choose no match, and advance or reset a heat. Recent completed heats remain available for winner, tie, or no-match corrections.

The seeded library has 50 challenge ideas; a smaller pilot set starts enabled. Test props, lighting, legibility, and accessibility for the venue before enabling more. The fast detector is limited to simple color clues such as “SHOW SOMETHING RED” and checks repeated frames; a clue that names a specific object needs AI-assisted or operator judging. Object, printed word, shape, and combination prompts can use AI vision when configured; an operator can always judge or correct the result. Creative prompts use an audience ballot after the timer.

For the live wall in either rehearsal or Twilio Video mode, sign in to the control room **in the same browser profile** that opens the arena. The wall's Video subscriber token and transient camera frames require an operator session. The public arena page still shows the roster, timing, and results, but its camera cards connect only for signed-in booth displays. The display keeps only the Twilio identity and heat status visible at the top. In the footer, the large QR switches between play and vote; a smaller persistent **Star on GitHub** card shows a second repo QR on booth-sized displays and stays clickable on compact screens. Move the pointer, touch the screen, or press Tab to reveal Operator, theme, media status, and preview replay controls; they hide after five seconds of inactivity, and Escape hides them immediately.

### Player presence and moderation

A player can tap **Leave** while queued or playing and confirm the choice. Their camera turns off and the server releases their spot. A phone left open in the queue, lobby, a paused heat, or a prolonged operator review asks **Still here?** after three minutes; it releases the spot 30 seconds later unless the player taps **Keep my spot**. An abandoned Leave confirmation also releases after 30 seconds. If a tab closes or stops sending five-second heartbeats, the server sweeps every five seconds and removes waiting/queued players after about 25 seconds without a heartbeat, or players in an active heat after about 60 seconds. The camera stops automatically at the end of the configured result display, with a cap even when the result is paused. A player who leaves after the award remains visible as an illustrated result card until the next heat; their camera is off.

For a disruptive player, open **Manage players** on the operator live desk. Choose a player in the current heat or next-heat queue and confirm **Remove player**. The server clears their slot, invalidates their current player token, removes them from judging and creative ballots, records `player_kicked`, and attempts to disconnect them from the Twilio Video Room. The command response reports `mediaDisconnect.status` as `ok` or `failed`; a failure needs a booth-staff check of the room. Removing a winner during the result corrects the stored award. This is session-level removal: a person can join again with a new browser session, so continue to monitor the wall.

The arena can be reviewed with `?demo=hunt&players=4` or `players=6`, plus `?demo=win|lose|tie|no-match` for results. The phone accepts `?demo=win|lose|tie|no-match|build`. Result previews have a **Replay reveal** control. These fixtures do not join a room, open a heat, judge a player, collect leads, or write metrics. In an arena preview, both the star link and its QR open GitHub directly and remain untracked. Do a separate real heat rehearsal before the event.

The phone product story uses selectable Video, Messaging, and Segment explanations; Video describes the built live-event path, while the other two are optional integrations. Each panel has an **Explore** link that opens an official Twilio product page in a new tab. A **Star on GitHub** link stays in the attendee phone footer from joining through the result, build story, lead form, and thank-you screen. The spectator ballot also offers a small repo link. Preview links still navigate, but preview clicks are not recorded as event activity.

## 4. Connect Twilio Video

Set a public HTTPS `PUBLIC_BASE_URL`, then add `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, and `TWILIO_AUTH_TOKEN` in the server environment. Leave `REHEARSAL_MODE` blank or set it to `off`. The server creates one unrecorded **Group Room** per event heat, issues room-scoped player and wall tokens, and configures the Room callback at `PUBLIC_BASE_URL/webhooks/twilio/video`. `TWILIO_AUTH_TOKEN` is needed to validate the callback signature. Video tracks are not recorded by this app; evidence JPEGs are kept in memory briefly and never written to SQLite.

Run the operator **Preflight** view and test with at least two real phones and the intended arena display. The Video Room and JavaScript client follow [Twilio's Rooms API](https://www.twilio.com/docs/video/api/rooms-resource), [access token guide](https://www.twilio.com/docs/video/tutorials/user-identity-access-tokens), and [status callback guide](https://www.twilio.com/docs/video/api/status-callbacks).

## 5. Add SMS or WhatsApp audience ballots

Web voting needs no Twilio sender. To enable messaging ballots, provision a sender for the event and configure inbound HTTP **POST** messages to `PUBLIC_BASE_URL/webhooks/twilio/messaging`. Set the event's SMS sender or WhatsApp sender, event code, and corresponding channel in the admin voting settings. The booth screen shows each ballot option's numeric code; with an event code of `HUNT`, a voter sends `HUNT 2` to the displayed sender. Every inbound ballot must contain the event code and one displayed option number. The admin save rejects duplicate effective codes when events share a sender.

The endpoint validates `X-Twilio-Signature` using the exact public URL and account Auth Token, deduplicates `MessageSid`, and counts one ballot per sender per window. A messaging sender is hashed for voting and is **never** inserted as a lead. A vote or acknowledgement is not consent for later marketing. Complete the sender registration and regional messaging requirements that apply to the event before enabling the channel. See [incoming message webhooks](https://www.twilio.com/docs/messaging/guides/webhook-request), [webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security), and [Twilio's messaging policy](https://www.twilio.com/en-us/legal/messaging-policy).

Category voting opens between heats when enabled and enough approved categories exist; the winning category steers the next approved clue but never reveals its text. The operator can close the vote or choose a different available category. Creative audience voting opens after a creative hunt and can award ties; the operator can still correct the result.

Changing an event's voting settings while its ballot is open closes that ballot immediately. For a creative ballot, the votes already received determine its result; the operator can correct the award afterward.

## 6. Optional AI, Segment, and SendGrid

| Service | Server settings | Behavior |
| --- | --- | --- |
| OpenAI vision | `OPENAI_API_KEY`, optional `OPENAI_VISION_MODEL` | Reviews JPEG evidence for AI-assisted prompts with a structured verdict. The request uses `store:false`. Without it, the operator judges these prompts. |
| Segment | `SEGMENT_WRITE_KEY` | Mirrors a safe, contact-free subset of local activity. Local metrics work without it. `SEGMENT_IDENTIFY_LEADS=1` additionally sends name/email/company **only** for leads that checked the separate marketing opt-in. |
| SendGrid | `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`, optional `SENDGRID_REGION=eu` | Emails the requested build guide through the Mail Send API from a verified sender. Without configuration, guide requests remain saved with `pending-configuration`; expert requests remain for operator follow-up. |

Keep all keys on the server. Never place them in browser JavaScript or commit `.env`. The optional vision request includes the camera image, so ensure the on-screen consent and event privacy notice describe automated judging. AI can misread a booth scene; the operator's award/override remains available. See [OpenAI vision](https://developers.openai.com/api/docs/guides/images-vision), [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Segment Node](https://www.twilio.com/docs/segment/connections/sources/catalog/libraries/server/node), and [SendGrid's Mail Send API](https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send).

## 7. Metrics, leads, and data care

The private Metrics screen filters by event and date. A single-event range uses that event's IANA time zone; an all-events range uses UTC. It reports joins, heats, results, votes, funnel activity, lead requests, player leaves, timed-out sessions, operator removals, and outbound Twilio page and GitHub repo clicks; it can export filtered event or lead CSV. The report summary exposes `playerLeaves`, `timedOutPlayers`, `kickedPlayers`, `twilioProductLinkClicks`, `twilioProductLinkClicksByProduct: {video,messaging,segment}`, `githubRepoClicks`, and `githubRepoClicksBySource: {phone,spectator,arenaQr,arenaLink}` separately. The standard Metrics Overview shows the GitHub sources; compact screens keep the total, with source details in the report and event export. Historical source-less GitHub clicks count under phone. The arena's live star link and QR pass through a fixed repository redirect that records their source. These counts reflect outbound actions in real sessions, not confirmed GitHub stars. CSV cells are escaped against spreadsheet formula execution.

Admins see leads; operators may run heats but cannot open private reports. Lead capture can be disabled per event; when enabled, an admin chooses up to eight fields and their required flags. The build-guide option requires a required email field; an expert request may use email or phone. Every submission saves the field definition that visitor saw, so later form edits do not rewrite earlier leads. Joining and voting never require the lead form. The expert CTA saves a requested follow-up; it does not place a call.

The app keeps SQLite in `app/data/` by default. Lead retention defaults to **90 days** and can be set per event; the server prunes expired leads hourly. Activity records are retained until the database is deliberately archived or deleted. The anonymous vote secret is generated and stored in SQLite unless `VOTE_HMAC_SECRET` is set. Keep the secret stable across restores. Back up the database to encrypted storage and test a restore before the event; for a simple file copy, stop the app first so the SQLite/WAL files form a consistent snapshot. Restrict database and export access to staff who need it, and delete individual leads through the admin API when required.

## 8. Production handoff checklist

- [ ] Deploy the Node process behind trusted HTTPS with a reachable `PUBLIC_BASE_URL`; keep the process and SQLite storage persistent and back them up.
- [ ] Add Video credentials and the Auth Token, then check a live Group Room, player publishing, wall subscription, and signed callbacks.
- [ ] Register and configure any SMS/WhatsApp senders, exact inbound webhook URL, event codes, and event-specific channel toggles.
- [ ] Configure optional OpenAI, Segment, and SendGrid only for the services the activation will use.
- [ ] Check event settings, lead fields and consent copy, approved prompts, props, lighting, camera permission, both arena QR codes, tie/no-match override, pause/resume, player leave, idle cleanup, and operator removal on the actual booth network.
- [ ] Run `npm run check`, review the operator Preflight view, and test a complete 2–6 player heat and a filtered lead export before opening doors.

The [API contract](full-app-api.md) lists all routes and payloads. The [challenge library](concepts/find-it-first-challenge-library.md) is a prompt planning aid, not an automatically approved live deck.
