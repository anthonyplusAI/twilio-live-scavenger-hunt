# Expo readiness release

## Scope

This release closes five gaps found in the live booth audit and updates the phone CTA. The existing event settings and saved data must survive migration. New and existing events without an explicit lead timing setting use the faster camera-first, after-play lead flow; an admin can explicitly select join-time capture. GitHub starring is the default primary CTA.

## Visitor journey

1. A visitor enters an alias, accepts display consent, and checks camera permission before a slot is reserved. A denied camera has an obvious retry action and device-specific permission guidance. Players can switch front and rear cameras.
2. An admin chooses whether a configurable lead form appears at join or after play, or turns lead collection off. Spectators can voluntarily ask for the guide or an expert. Marketing opt-in is separate and off by default.
3. The product story has a configurable primary action: GitHub star, build guide, or Twilio expert. GitHub star is the new default. Secondary actions remain available when enabled.
4. If a live Video connection is lost, evidence and winner selection stop for that player until reconnection. The arena removes stale video. AI failures surface to the operator and hold review for an explicit manual decision.

## Data and follow-up

- Metrics distinguish join sessions from distinct browser sessions and calculate conversion rates with a matching denominator.
- Segment uses a stable pseudonymous browser ID from the server cookie. Only consented leads receive Identify, tied to that same anonymous ID.
- Guide requests create durable delivery jobs. SendGrid 202 means accepted; a verified Event Webhook records delivery or failure. Bounded retries handle definite transient failures. Expert requests appear in a staff queue.
- Event settings, activity, and delivery state remain in SQLite. Admin controls are saved with revision checks.

## Release checks

- Focused backend tests for media eligibility, judging recovery, event config, lead flow, metrics, Segment identity, and SendGrid webhook/queue behavior.
- Browser QA on phone, arena, spectator, operator, and metrics views in light and dark themes, with no screen overflow in booth-critical views.
- README, runbook, API docs, and visual previews reflect the shipped behavior.
- Run `npm run check`, deploy through the existing GitHub workflow, then verify health, public arena, player join/recovery, operator settings, and configured integration preflight.
