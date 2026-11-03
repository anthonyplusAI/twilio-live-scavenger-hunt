# Signal Stadium — Find It First

**Historical design draft, 2026-11-02.** This describes an early browser mockup with illustrative camera tiles and browser-local storage. See the [README](../../../README.md) and [runbook](../../runbook.md) for shipped behavior and service setup.

## The show

Two to six visitors join a live camera arena. Once the roster locks, a sealed countdown builds anticipation. At **GO**, everyone sees the same previously hidden challenge. The first verified match wins, or an operator awards co-winners. A result celebration then resets the arena for the next heat.

A passerby should understand **scan, play, find it first** in a glance. Product education belongs on the player's phone after play: **“See how this was built with Twilio”**, with optional build-guide or booth-expert follow-up. It never interrupts a hunt.

## Four surfaces

| Surface | Role | Screen rule |
| --- | --- | --- |
| Arena wall | Live phone-portrait feeds, join QR, sealed countdown, clue and clock during play, winner celebration. Next-category voting appears only between heats. | One viewport; no scrolling, lengthy copy, or operator controls. Cards keep a 9:16 frame and resize/reflow for the number of joined players. |
| Player phone | Public-display consent, camera preview, ready state, shared GO/clue, framing feedback, result, optional build CTA. | Each step fits one phone viewport. |
| Operator console | Run controls, prompt library, event and lead settings, AI candidate and override, live heat counters. | Each view fits one viewport; prompt lists paginate. |
| Event report | Event and date filters, visitor and player funnel, heat/prompt/judging activity, CTA conversion, lead roster and exports. | Each report tab fits one viewport; detailed records paginate or use a bounded list. |

On the arena, a 9:16 card matches the common portrait phone framing. Render the video with containment so the complete incoming picture remains visible when a device publishes a different aspect ratio; a branded backing fills any narrow bars. The active player count, not the event's maximum capacity, determines the card layout. Attract mode can show an invitation instead of empty camera cards. Use an official Twilio bug asset unchanged, with its source recorded; do not draw a substitute logo.

By default, playing asks for a screen name and public-display and image-review consent; contact details are requested only when someone later asks for a guide or expert. An admin may select optional at-join contact capture for an event. The visitor checks camera permission before a player spot is reserved. The Video client uses no microphone track. Camera denial offers permission guidance, an easy retry, or a spectator vote.

## Configurable heats

| Setting | Default | Rule |
| --- | --- | --- |
| Players | Minimum 2, maximum 6 | Set both within 2–6. The wall lays out only active players. |
| Hunt timer | 45 seconds; seeded creative prompts use 60 | Admin chooses 5–180 seconds; a prompt may override it. |
| Join deadline | 30 seconds | Begins when the configured minimum is ready. If ready players fall below the minimum, the timer clears and restarts when enough are ready. |
| Start mode | Flexible | **Full:** maximum ready. **Timed:** deadline and minimum. **Manual:** operator only. **Flexible:** whichever happens first. The operator may start any mode once the minimum is ready. |
| Judge policy | Auto with override | Automatic result, operator confirmation of an AI/CV proposal, or fully manual result. Staff can always correct and award one or multiple winners. |
| Prompt pack | Approved per event | Add, edit, enable/disable, and queue prompts on the fly. |
| Lead capture | On, after play | Per-event on/off switch and configurable timing: after play by default, or optional at-join capture. Separately enable build-guide and expert CTAs; add, rename, reorder, require, or remove contact fields. The default form asks for name, work email, and company, with no use-case question. A requested follow-up needs an email or phone contact path; the form does not offer product-update subscriptions. |

The server owns the roster, official clock, and a snapshot of the prompt and effective duration for each heat. Lock freezes the roster; a three-beat countdown reveals no clue. At GO, the exact prompt is sent to the wall and locked phones. Late arrivals queue for the next heat. Saved timer and prompt edits apply to the **next** heat, never midway through the current one.

Event and prompt saves require validation, visible success/error feedback, and revision checks so a stale editor cannot silently overwrite another operator. Result corrections are separate, versioned actions with operator, time, and reason. The browser prototype uses local storage for this interaction; production requires a shared database and server transactions across devices.

## Prompt design and judging

The [50-prompt challenge library](../../concepts/find-it-first-challenge-library.md) covers colors, everyday objects, shapes, gestures, printed words, counts, combinations, and creative rounds. Printed-word cards use **TWILIO, API, CODE, WEBHOOK, and 404**. Give every player the same safe, nearby props and an accessible alternative when needed. The operator can add, edit, enable, disable, and queue prompts during an event; each declares its judging lane and optional duration override.

Start the pilot with prompt-specific, rehearsed rules: color/shape vision, calibrated object and gesture detectors, and OCR restricted to supplied bordered cards. A general image model can inspect an ambiguous match or a combined-object prompt, but its answer is a **candidate** until the event's judge policy accepts it. An operator can override the winner, award any one player or multiple co-winners, or declare no winner. Creative tasks use an audience vote or staff review rather than a claim of objective AI creativity. See [vision judging options](../../concepts/vision-judging-options.md).

Only new post-GO evidence counts. A match must be stable across a short frame sequence inside the camera guide. Rank by the referee's server receipt time of the last qualifying evidence frame, before inference processing; never by AI completion order or a phone's clock. This means **first verified at the server**, which can differ from who physically found an item first because network/device delay varies. A calibrated near-tie window produces co-winners or staff review. Venue tests must check false positives, lighting, latency, accessibility, and a no-match path before a prompt is allowed into automatic mode. No materially valuable prize should depend solely on an untested model.

## Twilio moments, kept in their lane

| Product | Role |
| --- | --- |
| Programmable Video | Carries the live camera arena. The application, not Video, judges frames and declares winners. |
| Messaging (SMS/WhatsApp) | Optional audience vote for the **next** category between heats, or a requested post-play follow-up. A web vote works when no sender is ready. Delivery timing never affects the camera race. |
| Segment | Measures play, votes, guide requests, leads, and consent by event. The application log remains the live source of truth. |
| SendGrid | Optional requested build guide by email. The current form does not offer marketing subscriptions. |
| Voice / Agent Connect | Possible later follow-up after a visitor chooses the build CTA. No hotline or voice interaction is part of the arena or first pilot. |

The [channel plan](../../concepts/twilio-channel-options.md) covers event-specific sender setup and fallbacks. Product credits belong in the result interlude or on the visitor's phone, away from the active clue and portraits.

The optional [spectator vote and operator flow](../../concepts/spectator-and-operator-flow.md) opens only between heats. Spectators choose a category, not the exact prompt; the operator can veto an unsuitable category and queues an approved prompt. The prompt stays sealed until GO. A ballot is engagement, not a lead or marketing consent.

## Leads and measurement

After a result, a player can choose **Play next heat**, **Leave game**, or **See the build**. The build story features GitHub starring by default and offers **Get the build guide** or **Talk to a Twilio expert** when configured. Replay keeps the same player session and screen name, while the camera turns off between heats. The event can turn lead capture off entirely or show either follow-up action. With the default after-play setting, the configured contact fields appear only after a voluntary guide or expert request; an admin can instead ask for them at join. The default fields are name, work email, and company. An admin may remove email if a phone field provides the contact path, though a guide request requires an email. Required fields and an email or phone value are validated when the form is submitted. The form does not offer marketing subscriptions; entering a phone number is not SMS/WhatsApp marketing consent. Turning capture off stops new forms and requests without deleting previous records. A default result card contains an alias and graphics, not a saved camera frame.

The backend counts unique landing visitors, player entries and unique players, heats, completed rounds, verified wins, no-match results, accepted audience votes and unique channel identities, repeat entries, result views, CTA opens, guide requests, valid leads, and expert requests. Filter by event and date range, with CSV export. An SMS/WhatsApp number from a vote is not automatically a lead. QR landing sessions are interest, not booth footfall; counting everyone who approached needs a separate counter or observation method. Store timestamps in UTC and report each event in its configured time zone. Segment receives a limited, contact-free activity stream; it does not receive lead `Identify` calls. Raw frames, message bodies, and contact fields stay out of routine analytics.

In the browser demo, an anonymous event log and a separate lead register are scoped by event ID and timestamp. The report filters both by event and date and offers exports; lead records contain the requested action and any configured fields, while analytics events carry IDs and counts without contact details. This proves the operator workflow locally, but browser storage is neither shared across phones nor suitable for live lead collection. Production needs a server API and database, authenticated operator access, retention/deletion rules, and delivery integration for requested follow-up.

## Repeatable events and operations

Create an event profile rather than cloning the app: immutable event ID/QR slug, venue and time zone, language, public theme, player range and timers, start/judge rules, approved prompts and props, channel switches and senders, CTA/guide, retention notice, analytics destination, and staff roles. Secrets stay on the server. Event operators can disable a bad prompt or pause the show; admins manage sender and privacy settings. Concurrent events need distinct inbound senders or unambiguous event codes.

Preflight on the venue network and lighting: 2–6 simultaneous camera streams and reconnection, prompt reveal timing, every enabled detector's positive and negative cases, safe props, accessible alternatives, QR placement, no-scroll layouts, override and tie flow, save/reload, messaging sender readiness, consent copy, metrics, and emergency stop. The game can run with Video plus web voting while optional channels are off.

## Visual direction

The wall feels like a live broadcast set: dark architectural depth, a distinctive signal core or shutter, Twilio-red energy at key beats, large live portraits, and one visual focal point at a time. Ambient motion attracts; roster lock gathers the players; the countdown reveals nothing; GO opens the clue; verification is quiet; winner takeover is brief and celebratory; the arena settles. Honor reduced motion and give text equivalents for sound. The operator console is visually related but calmer and more functional. Every surface is composed for its viewport; long lists use pagination or successive screens, never scrolling.

## Sources and boundary

- [Twilio Video overview](https://www.twilio.com/docs/video/overview) and [Video limits](https://www.twilio.com/docs/video/programmable-video-limits)
- [Twilio inbound Messaging webhooks](https://www.twilio.com/docs/messaging/guides/webhook-request) and [WhatsApp sender setup](https://www.twilio.com/docs/whatsapp/self-sign-up)
- [Twilio Segment Track](https://www.twilio.com/docs/segment/connections/spec/track) and [SendGrid Mail Send](https://www.twilio.com/docs/sendgrid/api-reference/mail-send)
- [MediaPipe Object Detector](https://developers.google.com/edge/mediapipe/solutions/vision/object_detector/web_js), [Gesture Recognizer](https://developers.google.com/edge/mediapipe/solutions/vision/gesture_recognizer), and [OpenCV color thresholding](https://docs.opencv.org/4.x/da/d97/tutorial_threshold_inRange.html)

The app owns configuration, timing, prompt secrecy, vision validation, results, consent, lead storage, and event metrics. Twilio carries the camera streams and, when enabled, messages, analytics events, and requested email.
