# Live Scavenger Hunt: spectator and operator flow

The shared event backend, web ballot, optional signed SMS/WhatsApp webhooks, operator controls, and Twilio Video integration are implemented. The hosted deployment remains in rehearsal mode until Twilio credentials are added and a real-phone venue test passes. The [runbook](../runbook.md) describes the current controls and activation steps.

## A spectator's optional vote

1. During the **result and lobby interlude**, the wall briefly asks the crowd to choose the **next category**, such as Object, Color, or Printed word. It never shows the exact next prompt. The active race keeps its clock, clue, and player feeds as the only focal points.
2. A spectator opens a separate vote link or scans a vote QR. The web ballot is the default. An event may also enable an SMS keyword or a WhatsApp link once its sender is ready. No account or contact form is required to vote.
3. The ballot accepts one category choice per browser session or messaging sender **per voting window**. The server records the event ID, window ID, category, channel, and receipt time. A phone number used for an SMS/WhatsApp vote is not a lead and is not marketing consent.
4. The window closes **before the next roster locks**. The winning category narrows the random draw among unused approved prompts. The operator can reject an unsafe or impractical result and choose another approved category.
5. The exact prompt remains sealed until the next heat's **GO**. Voting cannot give a player advance knowledge of the challenge or affect who wins the camera race.

For SMS and WhatsApp, Twilio sends inbound messages to the application's webhook with fields including `MessageSid`, `From`, `To`, and `Body`. The server validates Twilio's signature, deduplicates by `MessageSid`, maps the sender and event code to the event, and counts a valid vote once. Its TwiML response automatically sends a confirmation or correction message to the voter, so the sender must be able to send replies and meet applicable registration rules. A vote does not authorize later promotional messages. See [Twilio's incoming message webhook](https://www.twilio.com/docs/messaging/guides/webhook-request), [webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security), [WhatsApp inbound behavior](https://www.twilio.com/docs/whatsapp/api), [US A2P 10DLC](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc), and the [Twilio Messaging Policy](https://www.twilio.com/en-us/legal/messaging-policy).

An **audience-judged creative round** is a different optional mode. After its timer ends, the wall shows the eligible final entries together and spectators choose a winner during a short voting window. This mode does not use the first-match referee; the operator removes unsafe entries and can settle ties or override the result. Players' linked web sessions cannot vote for their own entry, but cross-channel identity checks are imperfect, so this mode should use lighthearted prizes only.

## Admin and booth operator

| Moment | Admin or operator action | Audience sees |
| --- | --- | --- |
| Before doors open | Create/select the event; set 2–6 player range, join/start rules, timer, judge policy, approved prompts, postgame CTA, and the event's optional lead form fields. For a live vote, choose categories, channels, sender, and window rule. Test QR, network, cameras, and the winner override. | Arena attract screen and join QR. |
| Lobby | Watch ready slots and camera health. The configured mode can start at capacity or deadline; the operator can start when the minimum is ready. | Player portraits and ready count. The clue stays hidden. |
| Countdown and hunt | Let the server lock players, start the shared countdown, then reveal the prompt at GO. The operator watches the heat and any detection candidate. | Countdown, then the same clue and timer on wall and phones. |
| Decision | Accept a valid referee candidate or correct it; award one winner, several tied winners, or no match. Record the correction. | A short winner moment, then the arena resets. |
| Between heats | If voting is enabled, review the next-category tally, apply a safety override if needed, and queue an approved prompt without revealing it. An admin can also revise the postgame form and save it for new requests; earlier leads retain the fields they submitted. | Optional category vote and upcoming-category result, never the exact clue. |
| After the event | Filter metrics by event/date, review play, replay, and spectator engagement, export accepted leads, and fulfil only the follow-ups attendees requested. | Nothing further unless they requested a guide or expert conversation. |

Event settings, prompts, ready/start controls, judge proposals, winner/tie/no-match decisions, configurable leads, metrics, live vote controls, signed messaging webhooks, and authenticated staff roles are implemented. Saved game rules take effect next heat; lead form changes take effect when saved. Live Twilio Video and messaging ballots need account credentials, sender configuration, and a complete venue test before an expo.
