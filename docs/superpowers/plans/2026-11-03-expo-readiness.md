# Expo readiness release

## Scope

This release closes the live booth audit gaps, updates the phone CTA, and incorporates repeat heats and AI-assisted prompt defaults. Existing events and saved data remain; customized timers and judging modes stay saved. The one-time AI and timer changes apply only to untouched revision-1 legacy events. New and existing events without an explicit lead timing setting use the camera-first, after-play lead flow; an admin can explicitly select join-time capture. GitHub starring is the default primary CTA.

## Visitor journey

1. A visitor enters an alias, accepts public-display and image-review consent, and checks camera permission before a slot is reserved. The consent screen explains optional OpenAI image review. A denied camera has an obvious retry action and device-specific permission guidance. Players can switch front and rear cameras.
2. An admin chooses whether a configurable lead form appears at join or after play, or turns lead collection off. Spectators can voluntarily ask for the guide or an expert. New requests cannot claim marketing opt-in.
3. The product story has a configurable primary action: GitHub star, build guide, or Twilio expert. GitHub star is the new default. Secondary actions remain available when enabled.
4. If a live Video connection is lost, evidence and winner selection stop for that player until reconnection. The arena removes stale video. AI failures surface to the operator and hold review for an explicit manual decision.
5. After a result, a player can replay without repeating the join form. A replay keeps the player session and joins behind people already waiting, with the camera off between heats. Leave ends the session.
6. Automatic prompt selection draws randomly among the least-played prompts within the chosen priority tier. New prompts and prompts in untouched legacy events default to AI-assisted judging; new events use a 45-second hunt and 60-second seeded creative prompts. An already customized event keeps its saved judging and timers. Simple color prompts are Low priority. When Standard prompts are enabled, Low prompts wait until all Standard prompts have appeared and then run at most once per five automatic draws; an all-Low deck can run every round. Automatic category ballots honor the cadence; operator-selected categories and queued prompts can override it.

## Data and follow-up

- Metrics distinguish join and replay entries from distinct browser sessions and player IDs, and calculate conversion rates with a matching denominator.
- Segment uses a stable anonymous browser ID from the server cookie for a limited contact-free activity stream. No lead identity is sent to Segment.
- Guide requests create durable delivery jobs. A 24-hour per-event recipient cooldown prevents duplicate emails. SendGrid 202 means accepted; a verified Event Webhook records delivery or failure. Definite 429 rejections retry with backoff; HTTP 503 and uncertain outcomes require staff review without automatic retry. Expert requests appear in a staff queue.
- Event settings, activity, and delivery state remain in SQLite. Admin controls are saved with revision checks.

## Release checks

- Focused backend tests for media eligibility, judging recovery, event config, replay, prompt selection, lead flow, metrics, anonymous Segment activity, and SendGrid webhook/queue behavior.
- Browser QA on phone, arena, spectator, operator, and metrics views in light and dark themes, with no screen overflow in booth-critical views.
- README, runbook, API docs, and visual previews reflect the shipped behavior.
- Run `npm run check`, deploy through the existing GitHub workflow, then verify health, public arena, player join/recovery, operator settings, and configured integration preflight.
