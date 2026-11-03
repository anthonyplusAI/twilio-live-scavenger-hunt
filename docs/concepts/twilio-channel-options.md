# Live Scavenger Hunt: Twilio product plan

**Historical planning recommendation · 2026-11-02.** Some options below are ideas rather than shipped features. The [README](../../README.md) and [runbook](../runbook.md) describe the current app: SMS/WhatsApp support is limited to audience ballots with automatic replies; requested guides use optional SendGrid email; local metrics work without Segment; Voice and Agent Connect are not implemented. Live Scavenger Hunt is a configurable 2–6 player camera race. The public wall stays focused on the live feeds, hidden-until-GO clue, countdown, and result. Product education appears after play. No product conversation interrupts a heat.

## The product moments

| Product | Role in the experience | When visitors see it |
| --- | --- | --- |
| **Twilio Video** | Core transport for the players' live phone cameras and the wall/referee subscriber. The application runs the game clock and vision judge. | Throughout the race. |
| **Twilio Messaging** | Optional SMS or WhatsApp vote on the *next category*, or a requested result/guide follow-up. A web vote always works as the fallback. Messaging never scores the race. | Lobby/result interlude, with a quiet vote cue; requested follow-up after play. |
| **Twilio Segment** | Optional copy of contact-free activity events. The app's own report measures engagement without Segment. | Private event reports remain available with or without a Write Key. |
| **Twilio SendGrid** | Optional email delivery of a requested game card or build guide. | After a visitor requests it. |
| **Twilio Voice + Agent Connect** | Possible later opt-in follow-up after the CTA, if an event wants a separate product conversation. It is outside the arena and the first pilot. | After play only, if deliberately added. |

### Video runs the arena

The player web app gets a short-lived access token from the application server and publishes camera video to an event-scoped Room. Configure the game to publish **video without microphone audio**. The wall and a controlled referee subscriber receive the active players' tracks; spectators do not join the Room. Twilio's selective forwarding unit forwards tracks but does not detect objects or select winners. The application owns prompt reveal, timing, verification, and operator overrides. Keep recording off by default. [Video technical overview](https://www.twilio.com/docs/video/overview) · [Video app components](https://www.twilio.com/docs/video/video-app-components) · [JavaScript quickstart](https://www.twilio.com/docs/video/javascript-getting-started) · [recording rules](https://www.twilio.com/docs/video/api/recording-rules)

### Messaging gives spectators one simple action

Between heats, a spectator may vote for the **next category** using the event's web ballot, SMS keyword, or WhatsApp click-to-chat link. The vote window closes before the next roster locks; only the category is announced, while the exact prompt remains sealed until GO. SMS/WhatsApp delivery time can vary, so these channels do not decide who found an item first. A player can participate without a phone number, and a visitor can watch without registering. The on-wall cue stays small and disappears during the camera race. See the [spectator and operator flow](spectator-and-operator-flow.md).

For inbound messages, map `To` to the event, validate the Twilio webhook signature, deduplicate by `MessageSid`, and accept at most one ballot per sender per window. If events share one sender, require an explicit event code; otherwise use distinct senders. Do not infer a name or email from a vote. A requested follow-up message needs its own purpose-specific consent; a vote is not marketing opt-in. [Incoming Messaging webhook](https://www.twilio.com/docs/messaging/guides/webhook-request) · [secure webhooks](https://www.twilio.com/docs/usage/webhooks/webhooks-security) · [Twilio Messaging Policy](https://www.twilio.com/en-us/legal/messaging-policy)

Enable SMS or WhatsApp **per event**, after sender setup is ready. A US local 10DLC outbound program needs A2P registration; US/Canada toll-free SMS needs approved verification. WhatsApp requires a registered sender. A user-initiated WhatsApp conversation opens a 24-hour window for free-form replies; business-initiated messages outside it require an approved template. Keep the web path available if a sender is unavailable or approval is delayed. [A2P 10DLC](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/quickstart) · [toll-free verification](https://www.twilio.com/docs/messaging/compliance/toll-free/console-onboarding) · [WhatsApp sender registration](https://www.twilio.com/docs/whatsapp/self-sign-up) · [WhatsApp quickstart](https://www.twilio.com/docs/whatsapp/quickstart)

### The CTA explains the build

A short result interlude can map the three products to what visitors just experienced: **Video carried the live cameras. Messaging let the crowd steer the next category. Segment can mirror engagement events.** The build story features GitHub starring by default and offers “Get the build guide” or “Talk with a Twilio expert at this booth” when configured. Lead capture is optional per event. By default, the admin-configured contact fields appear only after a voluntary follow-up request; an admin may instead select at-join capture and reuse those saved details later. The form does not offer a product-updates subscription. SendGrid can deliver the requested guide using a verified sender. [SendGrid Mail Send](https://www.twilio.com/docs/sendgrid/api-reference/mail-send) · [sender identity](https://www.twilio.com/docs/sendgrid/for-developers/sending-email/sender-identity)

If the team later wants an AI voice or chat follow-up, Voice and Agent Connect can connect a developer-owned agent to Twilio channels through a separate postgame CTA. Agent Connect is middleware for conversation channels, not a Video vision judge. This is a future extension, not part of the game or first pilot. [Agent Connect overview](https://www.twilio.com/docs/conversations/agent-connect/overview)

## Per-event configuration

One deployment supports many events by saving a versioned configuration under an immutable `event_id`. Changes to active gameplay apply at the **next heat**; the current heat keeps its prompt/timer snapshot. The operator sees whether each save succeeded and can recover from a conflicting edit.

| Group | Configurable values |
| --- | --- |
| Game | Event name/slug; 2–6 player minimum/maximum; start on capacity, deadline, manual command, or the first of these; join deadline; default and per-prompt duration; prompt pack and judge mode; automatic progression; tie/override policy. |
| Presentation | Branding, language, CTA destination, wall layout, approved public copy. |
| Video | Room naming/rotation, token issuer, audio off, camera fallback, bitrate profile, recording off/on, public-camera notice. |
| Messaging | SMS/WhatsApp enabled switches, sender IDs, vote keywords and windows, inbound route, acknowledgement and requested-follow-up copy, sender approval, consent records, web fallback. |
| Lead form | Capture on/off, after-play timing by default or optional at-join timing, guide/expert offers, ordered fields and required flags. |
| Segment/SendGrid | Optional Segment Write Key, guide email template, authenticated sender, and delivery webhook. |
| Operations | Event schedule/time zone, operator roles, launch rehearsal, secret references, retention policy, pause/disable controls. |

Secrets belong in server-side secret storage, never the wall or browser configuration. Preflight each event's QR, camera permissions, room, webhook signature, sender status, web ballot, and result CTA before opening the booth.

## Metrics that answer the booth question

The application event log is authoritative for live counters and winner decisions. With a Write Key, a limited `Track` stream goes to Segment; the app does not send lead `Identify` calls. Carry `event_id`, `heat_id`, `participant_id` or anonymous session ID, prompt version, and channel where relevant. Keep raw video, message text, phone numbers, and email out of routine `Track` properties. [Segment Track spec](https://www.twilio.com/docs/segment/connections/spec/track)

| Question | Definition |
| --- | --- |
| Interest | Unique QR landing sessions. This is **not** physical crowd size. |
| Players | Unique participant IDs that joined Video and attempted at least one heat. |
| Play engagement | Heats started/completed, attempts per player, repeat players, prompts tried, and average time to verified match. |
| Spectator engagement | Unique accepted ballots and total accepted ballots, split by web/SMS/WhatsApp. Cross-channel people count can overlap unless identities are voluntarily linked. |
| Product interest | CTA opens, build-guide requests, expert conversations requested, and conversion from player/voter to CTA. |
| Leads | Contact details captured after a voluntary guide or expert request by default, or at join if an admin selects that timing; the form does not offer marketing subscriptions. |
| Delivery | Requested messages/emails accepted, delivered, bounced, and clicked when tracking is enabled. |
| Operations | Camera join failures, detector uncertainty, operator overrides/ties, message rejection, and median/p95 verification latency. |

Suggested event names: `QR Landing Opened`, `Video Joined`, `Heat Started`, `Prompt Revealed`, `Match Verified`, `Winner Finalized`, `Vote Accepted`, `CTA Opened`, `Lead Submitted`, `Recap Requested`, and `Recap Sent`. Deduplicate votes and wins in the application before forwarding them to Segment; Segment is the analytics layer, not the live scoring engine.
