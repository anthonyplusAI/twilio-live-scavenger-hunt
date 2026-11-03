# Project guidance

## Keep the public story accurate

- Treat `README.md` as part of the product. When a change affects the player journey, arena, operator controls, metrics, leads, settings, integrations, setup, or production readiness, update the relevant README section in the same change.
- Update `docs/runbook.md` for operating or deployment changes and `docs/full-app-api.md` for route, payload, status, or permission changes. Read the implementation before describing behavior.
- Refresh screenshots in `docs/visuals/` after a visible UI change. Label fixture screenshots as visual previews; never imply illustrated people are live camera feeds. Keep image links and alt text current.
- Distinguish what works in local rehearsal from services that still require Twilio credentials, sender registration, or production HTTPS. Do not claim Voice or Agent Connect is implemented until it is actually wired.
- Before finishing, run `npm run check` and `node scripts/check-readme-links.mjs`. Check the README against the changed screens and code, since a link check cannot detect inaccurate prose.

The demo intentionally leaves Twilio account configuration and production deployment to the event owner. Do not commit `.env`, databases, exported leads, or credentials.
