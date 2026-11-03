# Live Scavenger Hunt runbook

This guide covers local and Azure rehearsals plus the setup needed for a public expo. The app stores each event's configuration, heat state, players, ballots, metrics, voluntary leads, delivery jobs, and follow-up requests in SQLite. The [Azure infrastructure guide](INFRA_SETUP.md) and [deployment guide](DEPLOYMENT.md) cover the hosted service. Video credentials and the webhook Auth Token are app-wide deployment settings; Messaging senders, channels, and voting codes are configured for each event.

## 1. Install and sign in

From the repository root, use Node.js 26 or newer:

```sh
npm ci
npm run build
cp .env.example .env
npm start
```

The first local start creates `app/data/live-scavenger-hunt.sqlite` and prints a generated `admin` password **once** in that server terminal. An existing `app/data/signal-stadium.sqlite` is reused so earlier settings, leads, and metrics remain available; its original seeded event is renamed in place. Save the password in your secret manager. Hosted first boot supplies `BOOTSTRAP_ADMIN_PASSWORD` through a Container App secret, so the password does not enter retained logs. Sign in at `/login` or the event's `/operator` URL. The server reloads `.env` only when it starts; restart after changing secrets. `npm run check` builds the Video browser bundle and runs the test suite.

The first admin username is `admin`. In the control room, **Team → Admin login** edits that existing local admin account. To set a new password while keeping the username, leave `admin` in the username field, enter and confirm the new password, then save. To rename it, change the username; the password can stay unchanged. A verified Twilio Google admin can do this without knowing the old local password. The app revokes the local admin account's active sessions after either change; a Google caller stays signed in. **Add operator** creates a new staff account and cannot overwrite `admin`. Admins can also reset or rename other local operator accounts from Team. Local passwords have no minimum length or character rule; any nonempty value up to 16,384 UTF-8 bytes works. Google account names and passwords are managed by Google Workspace. Operators can run heats but cannot manage accounts, edit event settings, or view leads and reports; **Team** and **Metrics** appear only for admins. Team accounts are global to the app, so the same operator can work across events. Changing `BOOTSTRAP_ADMIN_PASSWORD` after the database has users does **not** change the admin login; use **Admin login** instead. Keep a separate admin account for configuration and reporting.

Optional Google sign-in lets any verified `@twilio.com` Google Workspace account enter as an admin, with no approval list. This includes access to event settings, Team, Metrics, and collected leads. The app checks the signed ID token's `hd=twilio.com` Workspace claim as well as the verified email address. An existing Google operator gains admin access after signing in again; the app does not promote an old session from stored email alone. The login button appears only after both OAuth credentials are present. Configure the client and exact hosted callback through [Azure infrastructure setup](INFRA_SETUP.md#optional-google-sign-in-for-twilio-admins). Google OAuth is independent of Twilio Video, messaging, and local operator passwords.

Removing a person's Workspace access blocks a future Google sign-in, but an
app session already issued to that person remains valid until its 12-hour
expiry. The app does not recheck Google or revoke those sessions immediately.

For a local recovery when the browser account manager is unavailable, stop the
service before using the CLI to create another admin or limited operator:

```sh
node scripts/create-user.mjs --username booth-operator --role operator
```

The command prints a one-time generated password. Use `--role admin` for someone who may edit events and view leads. Add `--password-stdin` to supply a password without putting it in a shell argument. This CLI is a **stopped local database** recovery tool; the hosted container image does not include it. If you set `LIVE_SCAVENGER_HUNT_DB`, export the same value in the shell before running this CLI; the CLI does not load `.env` by itself. The earlier `SIGNAL_STADIUM_DB` setting remains supported for existing installs.

## 2. Rehearse without external credentials

Leave `REHEARSAL_MODE` blank or set it to `on`. Without the complete four-value Video set, including the Auth Token, the server uses rehearsal mode automatically. Open the seeded event at:

| Purpose | Path |
| --- | --- |
| Arena wall | `/e/live-scavenger-hunt/arena` |
| Player | `/e/live-scavenger-hunt/play` |
| Spectator vote | `/e/live-scavenger-hunt/vote` |
| Operator and event settings | `/e/live-scavenger-hunt/operator` |
| Admin-only metrics and leads | `/e/live-scavenger-hunt/metrics` |

Rehearsal mode sends small JPEG snapshots over the local app connection. It proves the join, arena, clock, judging, vote, lead, and reporting flow; it is lower frame rate than a Twilio Video Room. Camera access requires a secure browser context. `http://localhost` and `http://127.0.0.1` work for a camera on the same computer; phones scanning the live arena's play, vote, or tracked GitHub QR need a reachable **HTTPS** URL. Set `PUBLIC_BASE_URL` to that exact public origin so all QR targets and signed callbacks use the correct address.

On a player phone, the join form checks a 2–20 character screen name and consent to appear on the public display and have camera images checked for matches. It explains that OpenAI may review brief images when AI judging is enabled. The visitor checks the camera **before** the phone sends `/join`, so denying camera permission does not reserve a player spot. The phone shows a retry button and browser site-settings guidance when access is blocked; its camera switch can select the rear lens. **Go live** reserves a spot and connects it to the arena. If all spots are full, the visitor joins the waitlist and the phone turns the camera off until a place opens. Admins can optionally collect configured contact fields at join, but the default is to ask only after someone voluntarily requests a guide or expert. Invalid fields produce an inline prompt and arena updates preserve an in-progress form. A visitor can choose **Watch and vote instead** before joining without sharing player details.

For a camera denial at the booth, have the visitor allow Camera in that site's address-bar controls. On iPhone Safari, use the address-bar page menu → **Settings for This Website** → **Camera** → **Allow**; on iPhone Chrome, check Chrome's Camera permission in iPhone Settings. Return to the game and tap **Try camera again**. If the camera stops mid-heat, **Reconnect camera** restores the connection; switching front/rear cameras briefly reconnects Video. Do the permission drill with the browsers and phones expected at the venue.

## 3. Prepare each event

An admin creates an event in the control room. Each event has an immutable slug and separate player queue, prompt deck, voting settings, leads, and metrics. Set its name, venue and IANA time zone, player capacity (two to six), round/join/result timers, start mode, judging policy, auto-advance, lead retention, and optional form and vote settings. New events default to a 45-second hunt, and seeded creative prompts use 60 seconds. The one-time upgrade applies the 45-second event and 60-second seeded creative defaults only to untouched revision-1 legacy events; events already edited by an admin keep their saved timers, including a deliberate 20-second hunt or 30-second creative prompt. Save changes; the revision number increases. A stale tab gets a conflict response and must reload before saving.

| Start mode | Automatic start |
| --- | --- |
| Flexible | The configured maximum is ready, or the join window expires after the minimum becomes ready. |
| At capacity | The configured maximum is ready. |
| After wait | The join window expires after the minimum becomes ready. |
| Operator | Only a booth operator starts the heat. |

For Flexible and After wait, the configured `joinSeconds` timer begins when the **minimum number of players is ready**, not when the first player joins. For example, with 2–6 players and a 30-second window, the second ready player opens 30 more seconds for others to join. If ready players fall below the minimum, that timer clears and starts again when the minimum is met. Reaching the maximum in Flexible mode starts immediately. The arena shows the ready count without a misleading `/6` denominator; its ring fills at the minimum, and the subline states how many more are needed or how long the room remains open. An operator may start a heat once the configured minimum is ready, regardless of the automatic rule. The clue is selected and sealed when the roster locks. The countdown does **not** expose it to the public API or pages; it appears at GO. The selected prompt and game rules are snapshotted for that heat, so later edits apply to later heats. Reducing capacity during a lobby moves excess slots into the next-heat queue. A joining visitor after lock also waits in that queue. The operator can pause/resume, queue an approved prompt, accept or replace a referee proposal, award one or multiple winners, choose no match, and advance or reset a heat. Recent completed heats remain available for winner, tie, or no-match corrections.

A queued operator choice takes priority; otherwise the server draws randomly among the least-played enabled prompts in the selected priority tier. This avoids repeating a clue in that tier until its peers have caught up. Automatic audience category ballots run after every other completed heat; the intervening heat uses a regular draw so categories outside the ballot can progress. A ballot offers categories eligible under the current priority cadence, and its winning category narrows the draw without bypassing that cadence. An operator can manually select a category or queue a clue to override it. When equally played alternatives exist, the draw avoids immediately repeating the last clue. An operator may intentionally queue a repeat.

If all configured slots are occupied, or the heat is already locked, a new player joins the event's waitlist without turning on a camera. Their phone shows their one-based place in line, the total waiting, and an estimate in heats based on the event's capacity; this is not a minute-level promise. The server orders the queue by join time and insertion order. If a lobby slot opens because someone leaves, is removed, or times out, or if an admin increases capacity, it immediately promotes the oldest queued player before accepting a newer arrival into that spot. The promoted phone asks the visitor to reconnect the camera. At the next heat, the oldest queued players fill up to the configured capacity; if auto-advance is off, an operator opens that heat. Other queued players remain in line. The phone needs to stay open and send heartbeats to hold a place.

The seeded library has 50 challenge ideas; a smaller pilot set starts enabled. New prompts and the seeded deck use AI-assisted judging by default. On the first startup after this change, prompts in untouched revision-1 legacy events switch to AI-assisted judging; customized events keep their saved judge modes. The app increments each changed event revision and records the migration. Active heats keep their locked prompt and judging rules, and later admin selections of Fast detector, Audience vote, or Operator remain in place. Admins can set each prompt's **Rotation priority** to Standard or Low in the prompt editor and save the event revision. Simple color-only clues default to Low. When any Standard clues are enabled, automatic selection holds Low until every enabled Standard clue has appeared, then schedules Low at most once in five automatically selected rounds; an all-Low deck can draw a Low clue every round. Within the selected priority tier, it draws among the least-played eligible clues. Automatic category ballots follow the cadence; operator-selected categories and queued prompts can bypass it.

Test props, lighting, legibility, accessibility, and OpenAI access for the venue before enabling more prompts. Without an OpenAI key, AI-assisted rounds need operator judgment. The optional fast detector is limited to simple color clues such as “SHOW SOMETHING RED” and checks repeated frames; a clue that names a specific object needs AI-assisted or operator judging. If AI is unconfigured or fails during an AI-assisted heat, the operator desk shows a judge notice and the automatic result holds until staff award a winner, tie, or no match. Creative prompts can use an audience ballot after the timer. In live Video mode, a disconnected player cannot submit a winning evidence frame, and the arena clears that camera tile when its track disconnects.

For the live wall in either rehearsal or Twilio Video mode, sign in to the control room **in the same browser profile** that opens the arena. The wall's Video subscriber token and transient camera frames require an operator session. The public arena page still shows the roster, timing, and results, but its camera cards connect only for signed-in booth displays. The display keeps only the Twilio identity and heat status visible at the top. In the footer, the large QR switches between play and vote; a smaller persistent **Star on GitHub** card shows a second repo QR on booth-sized displays and stays clickable on compact screens. Move the pointer, touch the screen, or press Tab to reveal Operator, theme, media status, and preview replay controls; they hide after five seconds of inactivity, and Escape hides them immediately.

### Player presence and moderation

A result screen gives the player **Play next heat**, **Leave game**, and the Twilio product story. Replay keeps the same player session, screen name, and saved contact details, records another entry, and joins the waitlist or an available lobby slot after earlier queued visitors. It does not require the join form again or capture a second lead. The camera turns off between heats; the phone attempts to reconnect when a spot opens and offers a reconnect button if permission or media setup needs attention. A finished player who does not choose replay holds no new slot. A player can tap **Leave** after joining, while queued, playing, or exploring the postgame story. Confirmation ends the session, stops the camera, and releases the spot. The camera check before joining holds no spot. A player who leaves after the award remains visible as an illustrated result card until the next heat; their camera is off.

A phone left open in the queue, lobby, a paused heat, or a prolonged operator review asks after three minutes; it releases the spot 30 seconds later unless the player taps **Keep my spot**. An abandoned Leave confirmation also releases after 30 seconds. If the tab closes or stops sending five-second heartbeats, the server sweeps every five seconds and removes waiting/queued players after about 25 seconds without a heartbeat, or players in an active heat after about 60 seconds. The camera stops automatically at the end of the configured result display, with a cap even when the result is paused.

For a disruptive player, open **Manage players** on the operator live desk. Choose a player in the current heat or next-heat queue and confirm **Remove player**. The server clears their slot, invalidates their current player token, removes them from judging and creative ballots, records `player_kicked`, and attempts to disconnect them from the Twilio Video Room. The command response reports `mediaDisconnect.status` as `ok` or `failed`; a failure needs a booth-staff check of the room. Removing a winner during the result corrects the stored award. This is session-level removal: a person can join again with a new browser session, so continue to monitor the wall.

The arena can be reviewed with `?demo=hunt&players=4` or `players=6`, plus `?demo=win|lose|tie|no-match` for results. The phone accepts `?demo=win|lose|tie|no-match|build`. Result previews have a **Replay reveal** control. These fixtures do not join a room, open a heat, judge a player, collect leads, or write metrics. In an arena preview, both the star link and its QR open GitHub directly and remain untracked. Do a separate real heat rehearsal before the event.

The phone product story uses selectable Video, Messaging, and Segment explanations; Video describes the built live-event path, while the other two are optional integrations. Each panel has an **Explore** link that opens an official Twilio product page in a new tab. **Star this game on GitHub** is the default main post-heat action, with smaller guide and expert choices; an admin can make one of those follow-ups primary instead. A repo link stays in the attendee phone footer throughout the journey. With default after-play capture, guide or expert opens the configured voluntary contact form. After one successful request, **More ways to connect** returns to the product story, and a compatible second request reuses the saved contact without another form. If a guide still needs an email, the phone opens a prefilled form. At-join capture reuses saved details. Web spectators can request a follow-up without joining. Preview links still navigate, but preview clicks are not recorded as event activity.

## 4. Connect Twilio Video

Set a public HTTPS `PUBLIC_BASE_URL`, then add `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, and `TWILIO_AUTH_TOKEN` in the server environment. Use a US1 Standard API Key from the same Twilio account as the Account SID; its secret is distinct from the account Auth Token. Locally, leave `REHEARSAL_MODE` blank or set it to `off`. For the hosted app, store the four values as GitHub Actions secrets, set `TWILIO_VIDEO_MODE=live`, and dispatch the [controlled deploy workflow](INFRA_SETUP.md#activate-twilio-video) between heats. The rollout validates the complete set before stopping the old writer and sets `REHEARSAL_MODE=off` only on the candidate. To return the hosted app to snapshots, set `TWILIO_VIDEO_MODE=rehearsal` and dispatch the same workflow; an unset mode preserves the existing setting.

The server creates one unrecorded **Group Room** per event heat, issues room-scoped player and wall tokens, and configures the Room callback at `PUBLIC_BASE_URL/webhooks/twilio/video`. No account-wide Video webhook needs manual setup. `TWILIO_AUTH_TOKEN` validates the callback signature. Video tracks are not recorded by this app; evidence JPEGs are kept in memory briefly and never written to SQLite.

Run the operator **Preflight** view and test with at least two real phones and the intended arena display. The Video Room and JavaScript client follow [Twilio's Rooms API](https://www.twilio.com/docs/video/api/rooms-resource), [access token guide](https://www.twilio.com/docs/video/tutorials/user-identity-access-tokens), and [status callback guide](https://www.twilio.com/docs/video/api/status-callbacks).

## 5. Add SMS or WhatsApp audience ballots

Web voting needs no Twilio sender. To enable messaging ballots, provision a sender for the event in the Twilio account whose Auth Token is deployed, then configure inbound HTTP **POST** messages to `PUBLIC_BASE_URL/webhooks/twilio/messaging` in Twilio's number, Messaging Service, or WhatsApp sender configuration as applicable. The app supports one account-wide signing token. Set the event's SMS sender or WhatsApp sender, event code, and corresponding channel in the admin voting settings. The booth screen shows each ballot option's numeric code; with an event code of `HUNT`, a voter sends `HUNT 2` to the displayed sender. Every inbound ballot must contain the event code and one displayed option number. The admin save rejects duplicate effective codes when events share a sender.

The endpoint validates `X-Twilio-Signature` using the exact public URL and account Auth Token, deduplicates `MessageSid`, and counts one ballot per sender per window. It returns a TwiML acknowledgment or correction that Twilio sends as an SMS/WhatsApp reply from the configured sender. There is no separate outbound Messaging REST call. A messaging sender is hashed for voting and is **never** inserted as a lead. A vote or acknowledgment is not consent for later marketing. Complete the sender registration and regional messaging requirements that apply to both inbound ballots and automated replies before enabling the channel. If replies go from a US local 10DLC number to US recipients, [register its A2P 10DLC brand and campaign](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/quickstart) before use. See [incoming message webhooks](https://www.twilio.com/docs/messaging/guides/webhook-request), [webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security), and [Twilio's messaging policy](https://www.twilio.com/en-us/legal/messaging-policy).

The [WhatsApp Sandbox](https://www.twilio.com/docs/whatsapp/sandbox) works for a staff test, but each test phone must send its join code before voting. Register a [WhatsApp Business sender](https://www.twilio.com/docs/whatsapp/self-sign-up) for walk-up expo attendees.

When voting is enabled and at least two eligible categories exist, an automatic category ballot opens after every other completed heat. The winning category steers the next approved clue but never reveals its text. The operator can also open a category ballot between heats, close a ballot, or choose a different available category. Creative audience voting opens after a creative hunt and can award ties; the operator can still correct the result.

Changing an event's voting settings while its ballot is open closes that ballot immediately. For a creative ballot, the votes already received determine its result; the operator can correct the award afterward.

## 6. Optional AI, Segment, and SendGrid

| Service | Server settings | Behavior |
| --- | --- | --- |
| OpenAI vision | `OPENAI_API_KEY`, optional `OPENAI_VISION_MODEL` | Reviews JPEG evidence for AI-assisted prompts with a structured verdict. The request uses `store:false`. If AI fails, the automatic result holds for an operator decision. |
| Segment | `SEGMENT_WRITE_KEY` | Mirrors a limited, contact-free activity stream under an anonymous browser session ID. Local metrics work without it; lead identities are not sent to Segment. |
| SendGrid | `SENDGRID_API_KEY`, verified `SENDGRID_FROM_EMAIL`, optional `SENDGRID_REGION=eu` | Submits requested build guides through Mail Send. Without configuration, requests remain saved as `pending-configuration`. A saved job can retry a definite 429 temporary failure; HTTP 503 requires staff review. HTTP `202` means accepted, not delivered. |
| SendGrid Event Webhook | `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` | Verifies signed callbacks and records processed, deferred, delivered, bounced, or dropped delivery state. Without this, accepted guides remain unconfirmed. |

For Azure, put `OPENAI_API_KEY`, `SEGMENT_WRITE_KEY`, `SENDGRID_API_KEY`, and
`SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` in GitHub Actions **secrets**. Put `OPENAI_VISION_MODEL`,
`SENDGRID_FROM_EMAIL` and `SENDGRID_REGION` in Actions **variables** only
when you want to set them. The SendGrid key and verified sender address must
be supplied together. `SENDGRID_REGION=eu` uses
the EU API; leave it unset for the default global API, or set `global` to
switch an existing EU deployment back.
Dispatch the [controlled deployment](INFRA_SETUP.md#activate-optional-ai-segment-and-guide-email)
between heats. Blank values preserve the active ACA setting, so deleting a
GitHub secret alone does not disable a previously configured integration.
Credential updates use new ACA secret names per rollout, leaving older
revisions' references intact for pre-cutover rollback. Remove old secret
versions only when those revisions are no longer needed.

For guide delivery confirmation, create an Event Webhook in SendGrid at
**Settings → Mail Settings → Event Webhooks**. Set its POST URL to
`PUBLIC_BASE_URL/webhooks/sendgrid/events`, enable processed, deferred,
delivered, bounce, and dropped events, and enable **Signed Event Webhook** under
Security features. Save the webhook **before** copying its public verification
key from the edit dialog. Put that key in the
`SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` secret and deploy. Do not put a private key
or SendGrid API key in that setting. SendGrid may retry a callback; the app
deduplicates events by `sg_event_id`. The [SendGrid signed webhook guide](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features)
shows the current Console flow.

Guide requests are saved before an email attempt. Definite temporary SendGrid
429 rejections are retried with backoff; HTTP 503 and uncertain network outcomes are flagged
for staff review with no automatic retry to avoid a possible duplicate send. The Metrics lead roster
shows accepted, delivered, bounced, dropped, and other delivery states. A guide
request for the same event and email within 24 hours is recorded as a recent
request without sending another email, even from a different phone or browser.
The visitor sees that status and can ask staff if the guide did not arrive. Expert
requests enter the admin-only follow-up queue, where staff can mark them
contacted; the app does not send an expert notification or place a call.

Keep all keys on the server. Never place them in browser JavaScript or commit `.env`. The optional vision request includes the camera image, so ensure the on-screen consent and event privacy notice describe automated judging. AI can misread a booth scene; the operator's award/override remains available. See [OpenAI vision](https://developers.openai.com/api/docs/guides/images-vision), [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Segment Node](https://www.twilio.com/docs/segment/connections/sources/catalog/libraries/server/node), and [SendGrid's Mail Send API](https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send).

After cutover, test one AI-assisted prompt, check that a safe game event appears
in the intended Segment Source under a browser session ID, and request a guide
with a staff email address. Confirm **accepted** first, then **delivered** after
the signed webhook arrives. A guide stuck at accepted needs webhook checks;
`bounced`, `dropped`, `failed`, or `needs-review` needs staff attention. The
operator Preflight view checks configuration presence; these real actions
confirm account access and delivery.

## 7. Metrics, leads, and data care

The private Metrics screen filters by event and date. A single-event range uses that event's IANA time zone; an all-events range uses UTC. It reports join sessions and repeat entries, distinct browser sessions where session IDs exist, distinct player IDs, heats, results, votes, funnel activity, voluntary leads, guide and expert requests, player leaves, timed-out sessions, operator removals, and outbound Twilio page and GitHub repo clicks. A browser session is **not** a unique person: devices can be shared and cookies can be reset. Legacy joins without a session ID are reported separately. The report summary exposes `joinSessions`, `totalParticipants`, `uniquePlayers`, `uniqueVisitorSessions`, `unattributedJoinSessions`, `playerLeaves`, `timedOutPlayers`, `kickedPlayers`, `twilioProductLinkClicksByProduct: {video,messaging,segment}`, and `githubRepoClicksBySource: {phone,spectator,arenaQr,arenaLink}`. The arena's live star link and QR pass through a fixed repository redirect. These counts reflect outbound actions in real sessions, not confirmed GitHub stars. Event and lead CSV exports are filtered and escaped against spreadsheet formula execution.

Admins see leads; operators may run heats but cannot open private reports. Lead capture can be disabled per event. When enabled, an admin chooses **After play** or **At join**, a primary CTA, and up to eight fields with required flags. The default is after play with GitHub starring as the main action. The form requires at least one email or phone field, and a guide requires a required email field. At-join capture saves the player and lead atomically, but the phone still checks the camera first. After-play capture collects details only when a player requests a guide or expert. A web spectator may vote without sharing details, then voluntarily request a follow-up through the same configured form. Every lead saves the field definition the visitor saw, so later edits do not rewrite it. New requests cannot claim marketing opt-in; historical opt-ins remain in older records and CSV exports.

The phone preserves in-progress join and follow-up fields while live arena updates arrive and groups larger forms into short pages on compact screens. With at-join capture, later guide or expert taps mark requests on that saved lead. With after-play capture, the voluntary form creates the lead when submitted. If timing changes during a heat, a player missing saved contact details is offered the follow-up form. A guide needs an email; if SendGrid is not configured, the request and delivery job remain saved for later processing. An expert request appears in the private follow-up queue and does not place a call or send a staff alert. Metrics count leads by capture date and guide or expert requests by their request dates. The lead roster and lead CSV filter by capture date, including when staff view the pending expert queue across all dates; the event activity export includes later request actions. The admin can mark an expert request contacted and reopen it if needed.

Locally, SQLite lives in `app/data/`. In Azure, it runs on fast local container storage and Litestream replicates it to a private Azure Blob container; a replacement revision restores the backup before Node starts. A renewable Blob lease ensures that an extra Container Apps replica waits instead of opening a second game database.

Lead retention defaults to **90 days** and can be set per event; the server prunes expired leads hourly. Activity records are retained until the database is deliberately archived or deleted. The anonymous vote secret is generated and stored in SQLite unless `VOTE_HMAC_SECRET` is set. Keep it stable across restores. Restrict database and export access to staff who need it, and delete individual leads through the admin API when required.

Litestream attempts to sync every second when Blob is healthy, but an outage can make backup lag much longer. Verify a current backup and restore before each event. Deploy between heats: the controlled rollout stops the old revision before starting the next one, with a short service interruption. Startup schema changes must stay compatible with the previous image for automatic pre-cutover rollback. For a local file-copy backup, stop the app first so SQLite and its WAL form a consistent snapshot.

## 8. Production handoff checklist

- [ ] Verify the Azure Container App serves HTTPS with the exact `PUBLIC_BASE_URL`, one running replica, a healthy `/health` response, and a current Litestream backup; complete a restore drill before opening doors.
- [ ] Sign in as admin, create and test named local operator accounts in **Team**, optionally rename the initial admin username, rotate the initial admin password, and remove accounts that no longer need access. If Google sign-in is enabled, complete a verified Twilio Workspace login on the stable public hostname, confirm **Team** and **Metrics** appear, and confirm a non-Twilio account is denied.
- [ ] Add the four app-wide Twilio secrets, deploy with `TWILIO_VIDEO_MODE=live`, then check a live Group Room, player publishing, wall subscription, and signed callbacks.
- [ ] Register and configure any SMS/WhatsApp senders for inbound ballots and TwiML acknowledgment replies; check the exact inbound webhook URL, event codes, and event-specific channel toggles.
- [ ] Configure optional OpenAI, Segment, and SendGrid only for the services the activation will use. If sending guides, verify the sender, deploy the signed Event Webhook key, and confirm a staff test address reaches **delivered** rather than only **accepted**.
- [ ] Check event settings including lead timing and primary CTA, approved prompts and Low-priority cadence, props, lighting, Android portrait camera publishing on the phone and wall, denied camera recovery and front/rear switch, both arena QR codes, AI failure hold, tie/no-match override, pause/resume, replay into the next heat, player leave, idle cleanup, and operator removal on the actual booth network.
- [ ] Submit a voluntary player or spectator guide/expert request with a staff address, verify the expert follow-up queue and 24-hour same-event recipient cooldown, and check anonymous Segment events if enabled.
- [ ] Run `npm run check`, review the operator Preflight view, and test a complete 2–6 player heat and a filtered lead export before opening doors.

The [API contract](full-app-api.md) lists all routes and payloads. The [challenge library](concepts/find-it-first-challenge-library.md) is a prompt planning aid, not an automatically approved live deck.
