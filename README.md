<p align="center">
  <img src="app/public/assets/twilio-bug-official.png" width="52" alt="Official Twilio bug mark, also used for the app icon">
</p>

<h1 align="center">Live Scavenger Hunt</h1>

<p align="center"><strong>Find it. Show it. Beat the clock.</strong><br>
A live camera race that turns an expo booth into a moment the whole crowd can watch.</p>

<p align="center">
  <strong>2–6 players per heat</strong> &nbsp;·&nbsp;
  <strong>One shared arena</strong> &nbsp;·&nbsp;
  <strong>Optional audience voting</strong>
</p>

<p align="center"><a href="https://github.com/anthonyplusAI/twilio-live-scavenger-hunt"><strong>★ Star the project on GitHub</strong></a></p>

<p align="center">
  <a href="https://live-scavenger-hunt.delightfulwave-e00d5e3d.centralus.azurecontainerapps.io/e/live-scavenger-hunt/arena?demo=hunt&amp;players=4"><strong>▶ Open the hosted arena preview</strong></a>
  &nbsp;·&nbsp;
  <a href="https://live-scavenger-hunt.delightfulwave-e00d5e3d.centralus.azurecontainerapps.io/e/live-scavenger-hunt/play?demo=build"><strong>Explore the product story</strong></a>
</p>

<p align="center"><em>Read-only visual previews on the hosted app. A live heat uses the media mode shown in Operator → Preflight.</em></p>

![Four-player Live Scavenger Hunt arena preview with a prominent play QR and smaller GitHub star QR](docs/visuals/live-scavenger-hunt-arena-4-players.png)

<p align="center"><em>Illustrated arena preview. In a configured live event, each portrait spot carries that player's phone camera. The smaller star QR opens this repository.</em></p>

<p align="center">
  <a href="#the-experience">The experience</a> ·
  <a href="#see-the-moment">See the moment</a> ·
  <a href="#star-the-build">Star the build</a> ·
  <a href="#twilio-product-story">Twilio product story</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#azure-deployment">Azure deployment</a> ·
  <a href="#production-handoff">Production handoff</a>
</p>

## The experience

A visitor scans the arena's prominent **Scan to play** QR, enters a screen name, agrees to appear on the public display, and checks their camera. **Go live** reserves a spot only after the camera works. If access was denied, the phone shows where to allow it in the browser and a **Try camera again** button. A camera switch changes between front and rear cameras. Lead capture is configurable: the default asks for contact details only after someone voluntarily requests a guide or a Twilio expert; an admin can instead collect the configured fields at join or turn capture off. A visitor can choose **Watch and vote instead** without joining. The arena adjusts its portrait-card layout to the number of players, and the phone requests portrait capture; when a browser returns a landscape track, it makes a portrait stream for the preview and Twilio publishing if canvas capture is supported. The clue stays sealed until the roster locks and the shared countdown reaches **GO**. Every screen uses the official Twilio bug mark for its browser icon.

When all configured player spots are occupied, or a heat has locked, a new visitor enters the next-heat waitlist with their camera off. Their phone shows a private, exact place in line and a capacity-based estimate in heats; the app does not promise a minute countdown because booth pauses and judging can vary. The oldest waiting visitor takes the next open lobby spot when someone leaves, is removed, times out, or an admin increases capacity. New arrivals cannot jump ahead. At the next heat, the oldest queued visitors get the available spots and reconnect their cameras.

Then everyone races to show the requested color, object, shape, printed tech word, or creative find. Simple color prompts can be checked from repeated camera frames. Other prompts can use optional AI vision or a booth operator's judgment. The operator can award one winner, several winners in a tie, or no match. The result lands on the arena **and** each player's phone.

Admins set each clue to **Standard** or **Low** rotation priority in the prompt editor. Simple color-only clues default to Low. Automatic rotation holds Low until every enabled Standard clue has appeared, then allows a Low clue at most once in five automatically selected rounds. It draws among the least-played clues in the chosen priority tier. Category votes and operator-queued clues take precedence over that cadence.

<p align="center"><img src="docs/visuals/live-scavenger-hunt-operator-prompt-priority.png" alt="Local operator visual preview editing a simple color prompt with Low rotation priority" width="880"></p>

<p align="center"><em>Local operator preview of the saved prompt-priority control.</em></p>

Spectators can take part through a web ballot without providing player details. With configured senders, SMS or WhatsApp ballots can steer the next challenge category or vote on a creative round. After playing, visitors can follow a visual phone-to-arena product story, open official Twilio pages for each featured product, and **star the source on GitHub** as the default main action. An admin can make the build guide or Twilio expert the main action instead. Players and web spectators can voluntarily request a guide or conversation through the configured contact form. A small **Star on GitHub** card sits beside the arena's larger play or vote QR; booth-sized displays show a second QR in the card. The repo link also stays in the attendee phone footer throughout the journey and appears on the spectator ballot.

| Booth moment | What the app does |
| --- | --- |
| **Draw a crowd** | A large, responsive arena shows 2–6 portrait player spots, a prominent scan-to-play QR, a smaller GitHub star QR on booth displays, a shared clock, and a synchronized result reveal. |
| **Keep the race fair** | The server seals the prompt until GO. In the Flexible and After wait modes, the join timer starts when the configured minimum is ready; more players can join until it expires. The waitlist fills vacated lobby spots in join order. A disconnected live Video player cannot submit a winning find. An operator can start a ready heat manually. |
| **Keep staff in control** | Operators can pause, choose a prompt, judge or correct a result, award ties, and remove a player from the live heat or queue. If AI review fails, the automatic award holds for a manual winner, tie, or no-match decision. |
| **Manage booth access** | An admin can create local operators, change local usernames and passwords, or remove access from the control room. Optional Google sign-in grants verified `@twilio.com` Workspace accounts admin access. |
| **Measure engagement** | Private reports filter by event and date and cover join sessions, distinct browser sessions where available, plays, heats, votes, product and GitHub link clicks, leads, player exits, and removals. |
| **Adapt to the event** | Each event has its own URL, prompt deck, player limits, start rules, voting settings, lead timing and form, and main CTA. Every screen offers light/dark mode; the arena keeps its display controls hidden until staff interact. |

## See the moment

These are **visual previews with illustrated stand-ins**, captured from the running app. The live arena uses camera feeds after Twilio Video setup; local rehearsal uses brief JPEG snapshots.

<table>
  <tr><th>Arena · first find</th><th>Arena · another player wins</th></tr>
  <tr>
    <td><img src="docs/visuals/live-scavenger-hunt-arena-win.png" alt="Arena celebrating Maya as the winner with the smaller GitHub star QR beside the play QR" width="680"></td>
    <td><img src="docs/visuals/live-scavenger-hunt-arena-lose.png" alt="Arena showing another player's win, a nice-try state, and the GitHub star QR" width="680"></td>
  </tr>
  <tr><th>Phone · winner</th><th>Phone · not this round</th></tr>
  <tr>
    <td align="center"><img src="docs/visuals/live-scavenger-hunt-phone-win.png" alt="Winner celebration on a player phone, with a Star on GitHub link in the footer" width="300"></td>
    <td align="center"><img src="docs/visuals/live-scavenger-hunt-phone-lose.png" alt="Phone clearly says not this round, names the winner, and shows the GitHub star link" width="300"></td>
  </tr>
</table>

The motion plays in the browser: the arena spotlights a first find and acknowledges the other players; the winning phone gets a medal and a short confetti burst. The non-winner's phone clearly identifies the outcome and winner. Ties and no-match outcomes have their own result states. Motion reduces automatically when the device requests reduced motion.

The lobby shows how many players are ready and whether it is waiting for the minimum or giving others time to join:

![Local rehearsal arena lobby showing one ready player, the need for one more, and the scan-to-play QR](docs/visuals/live-scavenger-hunt-arena-lobby.png)

<p align="center"><em>Local visual preview with illustrated player spots; no live camera feed is shown.</em></p>

The wall also rearranges for traffic at the booth:

![Six-player Live Scavenger Hunt arena preview with a secondary GitHub star QR](docs/visuals/live-scavenger-hunt-arena-6-players.png)

The arena stays in show mode: only the Twilio identity and heat status remain at the top. Its play or vote QR remains the dominant footer action; a smaller star card lets visitors scan through to the [source repository](https://github.com/anthonyplusAI/twilio-live-scavenger-hunt) on booth-sized displays and remains a clickable link on compact screens. Moving a pointer, touching the screen, or pressing Tab reveals Operator, theme, and media controls for staff; the strip hides again after five seconds of inactivity.

After starting the app, open the read-only [four-player hunt](http://127.0.0.1:65111/e/live-scavenger-hunt/arena?demo=hunt&players=4), [arena win](http://127.0.0.1:65111/e/live-scavenger-hunt/arena?demo=win), [arena loss](http://127.0.0.1:65111/e/live-scavenger-hunt/arena?demo=lose), [phone win](http://127.0.0.1:65111/e/live-scavenger-hunt/play?demo=win), [phone loss](http://127.0.0.1:65111/e/live-scavenger-hunt/play?demo=lose), or [product story](http://127.0.0.1:65111/e/live-scavenger-hunt/play?demo=build) preview. Use **Replay reveal** on a result screen to watch the animation again. Preview URLs do not start a heat, connect a camera, judge a player, collect leads, or write metrics; their outbound links still open the linked sites.

## Star the build

The arena keeps the game QR large and gives the [source repository](https://github.com/anthonyplusAI/twilio-live-scavenger-hunt) a smaller star card with its own QR on booth displays. The player phone and spectator ballot keep **Star on GitHub** visible in their compact footers. Admin reports attribute GitHub referrals to the phone, ballot, wall QR, or wall link; they count outbound taps and scans, not confirmed visits or stars.

<table>
  <tr><th>Player phone · before joining</th><th>Player phone · join details</th><th>Spectator phone · between ballots</th></tr>
  <tr>
    <td align="center"><img src="docs/visuals/live-scavenger-hunt-phone-join.png" alt="Local rehearsal player landing screen with an illustrated phone camera spot and GitHub star footer" width="300"></td>
    <td align="center"><img src="docs/visuals/live-scavenger-hunt-phone-consent.png" alt="Default player join form asks for a screen name and public-display consent before checking the camera" width="300"></td>
    <td align="center"><img src="docs/visuals/live-scavenger-hunt-vote.png" alt="Spectator ballot preview waiting for the next vote, with a Star on GitHub footer link" width="300"></td>
  </tr>
</table>

<p align="center"><em>Local visual previews. The player portrait is an illustration, not a live camera feed. The join form shown uses the default after-play contact setting.</em></p>

<table>
  <tr><th>Camera access · recover and retry</th><th>Spectator · voluntary follow-up</th></tr>
  <tr>
    <td align="center"><img src="docs/visuals/live-scavenger-hunt-phone-camera-blocked.png" alt="Player camera check showing a blocked camera, site permission instructions, and a Try camera again button" width="300"></td>
    <td align="center"><img src="docs/visuals/live-scavenger-hunt-spectator-lead.png" alt="Spectator opens an optional build-guide contact form from the ballot while waiting for the next vote, without joining a heat" width="300"></td>
  </tr>
</table>

<p align="center"><em>Local interface previews of recovery and optional follow-up; no live camera feed appears.</em></p>

<p align="center"><img src="docs/visuals/live-scavenger-hunt-phone-waitlist.png" alt="Local rehearsal phone waitlist preview showing the player's private first place in line and an expected next-heat estimate" width="300"></p>
<p align="center"><em>Local visual preview of the waitlist. The card shows a queue rank and an estimate in heats, not a live camera feed or a guaranteed time.</em></p>

## Twilio product story

The post-heat CTA opens a one-screen visual explanation: a phone camera reaches the arena through **Twilio Video** in a configured live event. Visitors can tap **Messaging** to see how SMS or WhatsApp ballots work, or **Segment** to see how game activity becomes engagement data. The screen keeps optional integrations distinct from the core Video path. Its main action is **Star this game on GitHub** by default; an admin can select **Build guide** or **Twilio expert** instead.

Each product panel links to its official Twilio page: [Video](https://www.twilio.com/en-us/video), [Programmable Messaging](https://www.twilio.com/en-us/messaging/apis/programmable-messaging-api), or [Segment](https://www.twilio.com/en-us/segment). The phone's **Star on GitHub** link is visible from joining through the result and product story. With the default after-play setting, a guide or expert tap opens the short configured contact form. The confirmation screen links back to the product story, where a compatible second request reuses saved contact details. If the admin chose at-join capture, a request uses the details already saved at join.

<table>
  <tr><th>Dark display</th><th>Light display</th></tr>
  <tr>
    <td align="center"><img src="docs/visuals/live-scavenger-hunt-phone-product-story.png" alt="Dark phone product story with a camera-to-arena diagram, Twilio Video learn-more link, and prominent GitHub star action" width="300"></td>
    <td align="center"><img src="docs/visuals/live-scavenger-hunt-phone-product-story-light.png" alt="Light phone product story with Twilio Video explanation and a prominent GitHub star action" width="300"></td>
  </tr>
</table>

<p align="center"><em>Read-only visual previews. Contact collection happens only when someone takes a configured follow-up action, unless the admin selects at-join capture.</em></p>

| Product | Role in the activation | Setup state |
| --- | --- | --- |
| **Twilio Video** | Phone cameras publish into an unrecorded room; the booth wall subscribes to the players' video. | Built in; needs the Account SID, API Key SID and secret, Auth Token, and a public HTTPS origin for a live event. |
| **Twilio Messaging** | Spectators send SMS or WhatsApp ballots and receive an automated TwiML acknowledgment reply. A web ballot is available without a sender. | Optional; needs event senders, inbound webhook setup, and registration that covers the replies. |
| **Twilio Segment** | Can mirror a limited, contact-free activity stream using an anonymous browser session ID. The local report works without Segment. | Optional Write Key. An opted-in lead's identity can be linked to that session only with separate marketing opt-in and explicit configuration. |
| **Twilio SendGrid** | Can email a requested build guide. Accepted sends are tracked separately from confirmed delivery; an admin can follow expert requests in a private queue. | Optional API key, verified sender, and signed Event Webhook for delivery confirmation. |

Optional **OpenAI vision** can assess camera evidence for prompts that cannot be handled by the built-in color rule. The booth operator can always review or override a decision. The expert CTA records a request; it does **not** place a Voice call or launch Agent Connect.

## Player safety and booth control

Players can leave a reserved spot, queue, or active heat from the phone. The camera check happens before joining, so a denied permission cannot hold a tile; the phone offers a retry and browser settings guidance. After joining, **Leave** releases the spot and turns off the camera. A phone left idle in the queue, lobby, paused heat, or operator review asks after three minutes and releases the spot after another 30 seconds. An abandoned Leave confirmation also releases after 30 seconds. If the tab closes or stops sending heartbeats, the server clears waiting players after about 25 seconds and in-progress players after about 60 seconds. The camera stops at the end of the configured result display, with a time limit even if the result is paused.

Staff can open **Manage players** in the operator view, choose a current or queued player, and confirm removal. Removal clears the slot, requests a Twilio Video disconnect when configured, invalidates that player session, and records a removal metric. The command reports whether the Video disconnect succeeded. This is session-level moderation: a person with a new browser session can scan again, so booth staff should monitor the arena.

## Quick start

Requires **Node.js 26+**. No Twilio credentials are needed for a local rehearsal.

```sh
npm ci
npm start
```

`npm start` builds the browser Video client before starting the server. On a new local database, the terminal prints a generated admin username and one-time password. Save the password, then open:

| Screen | Local URL |
| --- | --- |
| Arena wall | [Open arena](http://127.0.0.1:65111/e/live-scavenger-hunt/arena) |
| Player phone | [Open player](http://127.0.0.1:65111/e/live-scavenger-hunt/play) |
| Spectator ballot | [Open vote](http://127.0.0.1:65111/e/live-scavenger-hunt/vote) |
| Operator and event settings | [Open control room](http://127.0.0.1:65111/e/live-scavenger-hunt/operator) |
| Private metrics and leads | [Open metrics](http://127.0.0.1:65111/e/live-scavenger-hunt/metrics) |

The default server address is `127.0.0.1:65111`; adjust it with [.env.example](.env.example). Local rehearsal sends short-lived JPEG camera frames through the app at a lower frame rate than Twilio Video. Camera access on real phones requires a reachable **HTTPS** origin. Sign in as an operator in the same browser profile used for the arena wall to see player cameras there.

Hosted deployments can provide `BOOTSTRAP_ADMIN_PASSWORD` as a platform secret on first boot. The app then seeds the admin without printing the credential in retained server logs. Changing that secret after the first boot does not change the saved password; use **Team → Admin login** to update the existing account.

### Booth staff sign-in

The first local admin account is `admin`. In **Team → Admin login**, an admin can edit that existing account: leave the username as `admin` and enter a new password to reset it, change the username, or do both. A Google admin does not need the old local password. This updates the saved account and signs out its existing sessions. **Add operator** creates a separate staff account and cannot reuse `admin`. Team also lets admins create and manage local operators. Local passwords have no minimum length or character rule; any nonempty value up to a 16 KB request-safety ceiling works. Google account names and passwords remain managed by Google. Operators can run heats but cannot edit event settings, see leads or metrics, or manage other accounts. **Team** and **Metrics** appear only for admins. Local accounts work without Google or Twilio credentials.

Google sign-in is optional and appears when an OAuth client ID and secret are configured. Any Google identity with a verified `@twilio.com` address **and** the `twilio.com` Workspace claim receives admin access, including **Team**, **Metrics**, and leads. The server checks the signed ID token and tracks the stable Google subject rather than trusting the address alone. An existing Google operator gains admin access on their next verified sign-in. The [Azure setup guide](docs/INFRA_SETUP.md#optional-google-sign-in-for-twilio-admins) shows the exact callback URL and secret setup.

<table>
  <tr><th>Staff sign-in</th><th>Admin · Team</th></tr>
  <tr>
    <td><img src="docs/visuals/live-scavenger-hunt-login-google.png" alt="Local visual preview of the control-room sign-in screen with username, password, and Google admin sign-in" width="680"></td>
    <td><img src="docs/visuals/live-scavenger-hunt-team.png" alt="Local Team preview showing the existing admin login editor, Google sign-in status, and operator roster" width="680"></td>
  </tr>
</table>

<p align="center"><em>Local visual previews. The Google button appears when OAuth credentials are configured.</em></p>

Run `npm run check` for the browser build, server tests, and README link check. The [runbook](docs/runbook.md) covers event setup, accounts, preflight, messaging registration, data care, and a full booth rehearsal.

## Metrics and leads

The admin-only Metrics view filters by event and date range, shows the engagement funnel and outbound **Twilio page** and **GitHub repo** click counts, and exports filtered event or lead CSV. Twilio clicks are broken down by Video, Messaging, and Segment; GitHub referrals are attributed to the player phone, spectator ballot, arena QR, or arena link. These are outbound actions, not confirmed page loads or GitHub stars. Join sessions are counted separately from distinct browser sessions; the latter is a browser-level measure, not a count of unique people, and older joins without a session ID are identified as unattributed. Local reports persist in SQLite even when Segment is not configured.

Lead capture can be turned off per event. When enabled, an admin chooses whether to ask at join or after play, the main post-heat action, and up to eight contact fields. **After play** and **Star on GitHub** are the defaults. Guide or expert requests open a voluntary form after play; a second request can reuse compatible contact details from the first. Web spectators can request either without joining a heat. At-join capture remains available for events that need it, and its saved details can be reused for later requests. Every lead keeps a snapshot of the fields shown. Metrics separate leads, guide requests, accepted and delivered guide email, delivery failures, and an expert follow-up queue that staff can mark contacted. Guide and expert counts use their request dates in the selected range; the lead roster and CSV use capture date. Marketing updates require a separate, unchecked choice. A guide requested for the same event and email within 24 hours is recorded without sending another email. SendGrid Mail Send acceptance means the request reached SendGrid; a configured signed Event Webhook confirms delivery or reports a bounce/drop.

<table>
  <tr><th>Admin · lead timing and main action</th><th>Admin · configurable contact fields</th></tr>
  <tr>
    <td><img src="docs/visuals/live-scavenger-hunt-operator-lead-capture.png" alt="Local operator visual preview choosing after-play contact capture and GitHub as the main action" width="680"></td>
    <td><img src="docs/visuals/live-scavenger-hunt-operator-lead-fields.png" alt="Local operator visual preview editing contact form field order and required flags" width="680"></td>
  </tr>
  <tr><th>Admin · engagement overview</th><th>Admin · captured leads</th></tr>
  <tr>
    <td><img src="docs/visuals/live-scavenger-hunt-metrics-overview.png" alt="Local metrics visual preview showing event activity and engagement across the selected date range" width="680"></td>
    <td><img src="docs/visuals/live-scavenger-hunt-metrics-leads.png" alt="Local metrics visual preview showing leads and separate guide and expert request counts" width="680"></td>
  </tr>
</table>

<p align="center"><em>Local visual previews with synthetic test contacts. They do not show live attendee data.</em></p>

The app stores event configuration, heat history, votes, metrics, and captured leads and follow-up requests in SQLite. Video is not recorded by this app, and camera evidence JPEGs are kept briefly in memory rather than saved to the database. Lead retention is configurable per event.

## Architecture

```mermaid
flowchart LR
    P[Player phones] -->|join, heartbeat, evidence| A[App server]
    P -->|live camera when configured| V[Twilio Video]
    V -->|player tracks| W[Arena wall]
    A -->|state and result| W
    S[Spectator phones] -->|web ballot| A
    S -. SMS or WhatsApp ballot .-> M[Twilio Messaging]
    M -->|signed webhook| A
    O[Booth operator and admin] <-->|settings, judging, reports| A
    G[Google Workspace] -. optional verified admin sign-in .-> A
    A <--> D[(SQLite)]
    D -. hosted backup via Litestream .-> B[(Azure Blob)]
    A -. optional judging .-> AI[OpenAI]
    A -. optional events .-> SG[Segment]
    A -. requested guide .-> E[SendGrid]
    E -. signed delivery events .-> A
```

The server owns the round clock, sealed clue, slot assignment, winner decision, operator permissions, and event-scoped reports. The [API contract](docs/full-app-api.md) lists routes and payloads; the [challenge library](docs/concepts/find-it-first-challenge-library.md) helps plan an event prompt deck.

## Azure deployment

The [hosted arena](https://live-scavenger-hunt.delightfulwave-e00d5e3d.centralus.azurecontainerapps.io/e/live-scavenger-hunt/arena) runs on Azure Container Apps. Provisioning starts it in rehearsal mode; the operator **Preflight** view reports the current media configuration and optional integrations. Its public HTTPS URL supports phone camera permissions, and the four Twilio Video and Auth Token settings enable live Rooms. Local passwords work without Google; Google sign-in appears when its OAuth client credentials are deployed.

The Azure setup follows the Birdies & Eagles pattern: a dedicated resource group in `centralus`, private Container Registry, Container Apps environment, Log Analytics, and GitHub OIDC deploys. The app keeps SQLite on fast local container storage and uses Litestream to restore and replicate it to a private Azure Blob container. An Azure Blob lease allows only one replica to open the database, including during platform maintenance. A controlled rollout stops the previous game process before the replacement starts, so a release includes a brief planned pause. The Container App serves a public HTTPS URL and is configured for one replica.

Start with [one-time infrastructure setup](docs/INFRA_SETUP.md), then use the [deployment guide](docs/DEPLOYMENT.md) for releases, backup checks, and recovery. [CI details](docs/CICD.md) describe the `Validate` gate that runs before an image can deploy. GitHub Actions can activate live Video through the controlled rollout with four Twilio secrets and `TWILIO_VIDEO_MODE=live`; `rehearsal` switches back to snapshots, and an unset mode preserves the current setting. The same safe rollout accepts optional OpenAI, Segment, and SendGrid keys. A verified SendGrid sender is needed for guide sends; a signed Event Webhook and its public verification key are needed to confirm delivery. Segment lead identification stays off unless explicitly enabled for visitors who separately opt in. Litestream attempts to sync every second when Blob is healthy; backup lag can grow during a storage outage. Verify a current backup and restore before an event.

## Production handoff

**The Azure deployment path is included and starts in rehearsal mode.** Before opening a public booth, add the Account SID, US1 Standard API Key SID and secret, and account Auth Token as GitHub Actions secrets; set `TWILIO_VIDEO_MODE=live` and deploy between heats. Verify the Blob backup and restore, then test the wall with real phones on the venue network, including a denied camera and a front/rear switch. SMS/WhatsApp ballots are optional and need an inbound sender webhook plus registration for automated acknowledgment replies. AI vision, Segment, and SendGrid are optional integrations with [separate setup](docs/INFRA_SETUP.md#activate-optional-ai-segment-and-guide-email). For SendGrid, confirm both API acceptance and a signed delivery event; without the webhook, requests remain accepted but delivery is unconfirmed. Follow the [Twilio activation steps](docs/INFRA_SETUP.md#activate-twilio-video) and [runbook's handoff checklist](docs/runbook.md#8-production-handoff-checklist).

When changing app behavior, screens, settings, or integrations, update this README and the relevant runbook/API sections in the same change. [Project guidance](AGENTS.md) records that maintenance rule.
