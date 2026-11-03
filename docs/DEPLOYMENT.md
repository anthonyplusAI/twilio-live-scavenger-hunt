# Deploying Live Scavenger Hunt

The GitHub pipeline deploys a Node 26 image to Azure Container Apps after the
reusable CI `Validate` check passes. [Infrastructure setup](INFRA_SETUP.md)
creates the Azure resources, GitHub OIDC trust, managed identities, and runtime
environment once. App images are tagged with their commit SHA in the private
Container Registry. GitHub does not store an Azure password or registry key.

## Runtime shape

| Setting | Hosted value | Why it matters |
| --- | --- | --- |
| Ingress | External HTTPS → port `8080` | Real phones can grant camera access and scan public QR codes. |
| `HOST`, `PORT` | `0.0.0.0`, `8080` | The app must accept Container Apps ingress traffic. |
| `PUBLIC_BASE_URL` | `https://<Container App FQDN>` | QR destinations, secure cookies, origin checks, and signed Twilio webhooks use this canonical origin. |
| Replicas | Minimum `1`, maximum `1` | Game clock, SSE listeners, judging cache, and SQLite have one owner during normal operation. |
| Writer lease | A renewable 60-second lease on a private Blob | If Container Apps briefly starts an extra replica for maintenance, only the lease holder restores SQLite and starts the game server. |
| Shutdown grace | `60` seconds | Litestream has time for its final backup sync before Container Apps forces the process to stop. |
| Database | `/tmp/live-scavenger-hunt.sqlite` | SQLite stays on fast local disk with WAL, not a network share. |
| Backup | Litestream → private Azure Blob, `1s` sync interval | Restores the database when a new container starts. Unreplicated writes can be lost after an abrupt failure; lag can grow during Blob errors. |
| Initial media mode | `REHEARSAL_MODE=on` | The site can be checked before Twilio Video credentials are configured. |
| Optional Google sign-in | `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` | Both are needed for verified `@twilio.com` Workspace admins. The secret is an ACA secret reference, never a plain environment value. |

The image bundles the generated Twilio Video browser client and the prompt
library used when an event is seeded. The startup supervisor acquires the
writer lease before `scripts/start.sh` restores the local database and runs
the Node server under Litestream. A waiting replica does not open `/health`.
If renewal fails, the supervisor stops the game process. Once
`LITESTREAM_REQUIRE_REPLICA=1`, a missing backup blocks startup rather than
starting a blank event. The unauthenticated `/health` route checks the store and
is the deployment smoke target.

## CI and release flow

1. Open a pull request to `main`. `.github/workflows/ci.yml` runs the production
   Node version, `npm run check`, and a Dockerfile build that checks Litestream
   and starts a rehearsal container. Both jobs must pass the `Validate`
   aggregator. CI receives no Azure or application secrets.
2. Merge only after `Validate` passes. A push to `main`, or a manual dispatch of
   `.github/workflows/deploy.yml`, reruns CI and builds a SHA-tagged image in ACR
   with GitHub OIDC.
3. The rollout pins traffic to the current revision, deactivates it, and waits
   for **zero old replicas**. This planned pause prevents two game engines or
   Litestream processes from writing at once. The old process attempts a final
   sync before exiting. Do not release during a heat.
4. The workflow starts the candidate image as one replica, waits for its health
   state, and tests its revision-specific HTTPS address before directing the
   public hostname to it. A failed pre-cutover rollout stops the candidate
   before reactivating the previous revision. This automatic rollback requires
   schema changes to remain compatible with the previous image: candidate
   startup can already have written to the shared database backup.
5. Confirm the public `/health` endpoint, arena, phone, vote page, operator
   login, and metrics after the rollout. Confirm Blob replication after first
   deploy and complete the restore drill in [INFRA_SETUP.md](INFRA_SETUP.md).

When both Google repository secrets are present, the deploy job checks the
pair before stopping the old revision. After it verifies zero old replicas,
it saves `GOOGLE_CLIENT_SECRET` as the ACA `google-client-secret` and creates
the candidate with `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET=secretref:google-client-secret`. Google sign-in uses the
stable public hostname for its exact callback, so test a complete Google
login **after** public cutover; the revision-specific pre-cutover smoke checks
only health and the arena. An unset pair preserves the live OAuth settings; a
partial pair fails before downtime when Google is being enabled or refreshed. The explicit `GOOGLE_AUTH_DISABLE=1`
repository variable removes both OAuth environment variables in the next safe
rollout. The [OAuth setup steps](INFRA_SETUP.md#optional-google-sign-in-for-twilio-admins)
include the registered redirect URI.

To dispatch a release already on `main`:

```sh
gh workflow run deploy.yml --ref main
gh run list --workflow deploy.yml --limit 3
gh run watch <run-id> --exit-status
```

Check the active image and logs when diagnosing a failure:

```sh
az containerapp show -g rg-live-scavenger-hunt -n live-scavenger-hunt \
  --query '{fqdn:properties.configuration.ingress.fqdn,image:properties.template.containers[0].image,revision:properties.latestReadyRevisionName}'
az containerapp revision list -g rg-live-scavenger-hunt -n live-scavenger-hunt -o table
az containerapp logs show -g rg-live-scavenger-hunt -n live-scavenger-hunt --tail 100
```

Use the Azure Portal or a private shell to read the generated admin password
from the `bootstrap-admin-password` Container App secret. The initial username
is `admin`; the exact retrieval command is in [INFRA_SETUP.md](INFRA_SETUP.md).
The password is intentionally absent from application and GitHub Actions logs.
After sign-in, **Team** creates local operator accounts and changes their
usernames or passwords. **My username** changes the admin login name and signs
out that account. **My password** changes the admin password; editing the
bootstrap secret does not reset an account already stored in SQLite.

## Configuration changes and recovery

The runtime configuration is set on the Container App during provisioning.
Image deploys preserve existing secrets and environment variables. A secret or
environment update itself can create a new revision, so make those changes in
a maintenance window using the same stop-old-revision sequence. A direct
`az containerapp update` against a live single-revision app can overlap two
revisions and interrupt the game while the second waits for the writer lease;
do not use it for a production change.

Before the first event, verify the backup and restore flow, then set the GitHub
variable `LITESTREAM_REQUIRE_REPLICA=1` and deploy again. Do not change the
storage account, Blob container, or Litestream path without migrating the
replica; a new empty destination looks like data loss. Never run `litestream
restore` over the live database file. If an image must be rolled back after
public traffic has reached it, stop that revision, wait for zero replicas, then
start the prior image against the **current** Blob replica. Do not replace
accepted leads or votes with a pre-release snapshot.

The cloud site initially uses rehearsal camera snapshots. Live Twilio Video
requires Video credentials and an Auth Token, plus a fresh venue-phone test.
SMS/WhatsApp requires sender registration and webhook configuration; OpenAI
vision, Segment, and SendGrid are optional. See [the booth runbook](runbook.md)
for event operations. The hosted site does not implement Voice or Agent
Connect.
