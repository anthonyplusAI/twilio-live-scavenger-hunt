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
| Live Video mode | `REHEARSAL_MODE=off` with four Twilio ACA secret references | The deploy workflow sets this only when `TWILIO_VIDEO_MODE=live` and the complete credential set passes pre-stop validation. |
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
   sync before exiting. When new credentials are supplied, the deploy job saves
   their rollout-specific ACA secrets as a batch, waits for
   Container App provisioning to settle, and verifies the expected secret
   names before starting the candidate. Do not release during a heat.
4. The workflow starts the candidate image as one replica, waits for its health
   state, and tests its revision-specific HTTPS address before directing the
   public hostname to it. A failed pre-cutover rollout stops the candidate
   before reactivating the previous revision; Azure operations still in progress
   are retried after provisioning settles. Recovery can still require a manual
   restore if Azure does not settle or a rollback step fails. The previous image
   also needs to read the current database schema: candidate startup can
   already have written to the shared database backup.
5. Confirm the public `/health` endpoint, arena, phone, vote page, operator
   login, and metrics after the rollout. Confirm Blob replication after first
   deploy and complete the restore drill in [INFRA_SETUP.md](INFRA_SETUP.md).

When both Google repository secrets are present, the deploy job checks the
pair before stopping the old revision. After it verifies zero old replicas,
it saves `GOOGLE_CLIENT_SECRET` with the other supplied credentials as a batch
under rollout-specific names, verifies those names, and
creates the candidate with `GOOGLE_CLIENT_ID` and a reference to that secret.
Google sign-in uses the stable public hostname for its exact callback, so test
a complete Google login **after** public cutover; the revision-specific smoke checks
only health and the arena. An unset pair preserves the live OAuth settings; a
partial pair fails before downtime when Google is being enabled or refreshed.
The explicit `GOOGLE_AUTH_DISABLE=1` repository variable removes both OAuth
environment variables in the next safe
rollout. The [OAuth setup steps](INFRA_SETUP.md#optional-google-sign-in-for-twilio-admins)
include the registered redirect URI.

Twilio Video activation follows the same stopped-writer boundary. Add the
Actions secrets `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`,
`TWILIO_API_KEY_SECRET`, and `TWILIO_AUTH_TOKEN`, then set the Actions variable
`TWILIO_VIDEO_MODE=live`. The deploy script rejects a missing value, malformed
SID, or whitespace in a secret before its first Azure call. After the old
writer reaches zero replicas, it saves all four under rollout-specific ACA
secret names as a batch, waits for provisioning and verifies their
names, then attaches only `secretref:` values to the candidate and sets
`REHEARSAL_MODE=off`. It never prints the credentials.
`TWILIO_VIDEO_MODE=rehearsal` explicitly sets `REHEARSAL_MODE=on`; an unset
mode preserves the active setting. A nonempty
`TWILIO_AUTH_TOKEN` secret can also be deployed alone for signed Messaging
webhooks without changing the explicit `REHEARSAL_MODE` setting. Removing a
GitHub secret later does not remove its existing ACA reference; use the
event's voting toggle to stop ballots and the explicit rehearsal mode to stop
live Video.

These checks catch incomplete settings before downtime, but they do not test
Twilio account permissions or network access. After public cutover, check
Operator **Preflight** and a real two-phone heat. The app creates the Video
Room and its signed status callback automatically. SMS/WhatsApp sender inbound
POST URLs are configured separately in Twilio and the event; the webhook's
TwiML response instructs Twilio to send a ballot acknowledgment. The [Twilio
setup steps](INFRA_SETUP.md#activate-twilio-video) cover those settings.

The same stopped-writer update supports optional OpenAI, Segment, and SendGrid
settings. Nonempty `OPENAI_API_KEY`, `SEGMENT_WRITE_KEY`, `SENDGRID_API_KEY`,
and `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` Actions secrets become ACA secret
references; optional
`OPENAI_VISION_MODEL`, `SENDGRID_FROM_EMAIL`, and `SENDGRID_REGION`
Actions variables become candidate environment settings.
The SendGrid API key and verified sender email must be supplied together.
The app does not send lead identity to Segment. Invalid values and a partial
SendGrid pair fail before the old writer stops. Unset values preserve the live configuration;
removing a GitHub secret does not remove an existing ACA reference. The
[optional integration setup](INFRA_SETUP.md#activate-optional-ai-segment-and-guide-email)
includes signed SendGrid Event Webhook setup and post-cutover checks. The
webhook key can be deployed separately from the API key and verified sender.
After sending a staff test guide, check that its status moves from **accepted**
to **delivered**; `202 Accepted` alone does not confirm delivery. A repeated
request for the same event and email within 24 hours is recorded without
another send. HTTP 503 and uncertain network outcomes are held for staff
review without automatic retry.

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
az containerapp revision list -g rg-live-scavenger-hunt -n live-scavenger-hunt --all -o table
az containerapp logs show -g rg-live-scavenger-hunt -n live-scavenger-hunt --tail 100
```

### Failed rollout recovery

If a rollout reports `ContainerAppOperationInProgress` or leaves the app
stopped, check the app's provisioning state and the revisions before rerunning
the workflow. Azure may finish a secret update after its CLI call reports a
failure. Inspect **secret names only**; never print their values in a shared
terminal or CI log. Wait for provisioning to finish before another write:

```sh
az containerapp show -g rg-live-scavenger-hunt -n live-scavenger-hunt \
  --query 'properties.provisioningState' -o tsv
az containerapp revision list -g rg-live-scavenger-hunt -n live-scavenger-hunt --all \
  --query '[].{name:name,active:properties.active,replicas:properties.replicas,provisioning:properties.provisioningState}' -o table
az containerapp secret list -g rg-live-scavenger-hunt -n live-scavenger-hunt \
  --query '[].name' -o tsv
```

Restore the previous revision **only for a pre-cutover failure** after
confirming that public traffic never reached the candidate. The deploy script
refuses automatic rollback once it may have admitted public traffic: the
candidate could already hold game or lead writes. If cutover happened, or
traffic history is uncertain, preserve the candidate and investigate its
health, logs, and data before choosing a recovery plan. Do not run the
old-revision commands below in that case.

For a confirmed pre-cutover failure, use the previous revision recorded by the
deploy log. The following commands restore its single writer and public
traffic:

If a candidate exists, deactivate it and confirm it has zero replicas before
starting the previous revision:

```sh
CANDIDATE_REVISION='live-scavenger-hunt--replace-with-candidate-revision'
az containerapp revision deactivate -g rg-live-scavenger-hunt -n live-scavenger-hunt \
  --revision "$CANDIDATE_REVISION"
az containerapp revision show -g rg-live-scavenger-hunt -n live-scavenger-hunt \
  --revision "$CANDIDATE_REVISION" \
  --query '{active:properties.active,replicas:properties.replicas,running:properties.runningState}'
```

Wait until the candidate reports `active: false` and `replicas: 0`. If the
rollout changed the app ingress port, restore its previous value before
reactivating the old image. The deploy log records this as `Changing ingress
target port from X to 8080`; use `X` as `PREVIOUS_TARGET_PORT`:

```sh
PREVIOUS_TARGET_PORT='replace-with-port-from-deploy-log'
az containerapp ingress update -g rg-live-scavenger-hunt -n live-scavenger-hunt \
  --target-port "$PREVIOUS_TARGET_PORT"
```

Skip that ingress command if the rollout did not change the port. When no
candidate is running and provisioning has settled, set `PREVIOUS_REVISION` to
its name from the all-revisions list, restore it, and check the public health
endpoint:

```sh
PREVIOUS_REVISION='live-scavenger-hunt--replace-with-previous-revision'
az containerapp revision activate -g rg-live-scavenger-hunt -n live-scavenger-hunt \
  --revision "$PREVIOUS_REVISION"
az containerapp ingress traffic set -g rg-live-scavenger-hunt -n live-scavenger-hunt \
  --revision-weight "${PREVIOUS_REVISION}=100"
curl --fail --show-error \
  https://live-scavenger-hunt.delightfulwave-e00d5e3d.centralus.azurecontainerapps.io/health
```

If Azure again reports an operation in progress, wait for provisioning to
settle and retry the rejected command. Check for a healthy previous revision
and 100% traffic before dispatching another release. A deployment failure may
interrupt the public site until recovery succeeds.

Use the Azure Portal or a private shell to read the generated admin password
from the `bootstrap-admin-password` Container App secret. The initial username
is `admin`; the exact retrieval command is in [INFRA_SETUP.md](INFRA_SETUP.md).
The password is intentionally absent from application and GitHub Actions logs.
After sign-in, **Team → Admin login** changes the existing local admin username
or resets its password. Leave the username as `admin` when only changing the
password. A verified Twilio Google admin can make this change without the old
local password. **Add operator** creates a separate account and cannot overwrite
`admin`. Editing the bootstrap secret does not reset an account already stored
in SQLite.

## Configuration changes and recovery

The runtime configuration is set on the Container App during provisioning.
Image deploys preserve existing secrets and environment variables when the
corresponding GitHub Actions setting is unset. Configured credentials create
rollout-specific ACA secret names, so a failed pre-cutover candidate cannot
change the credentials used by the previous revision. Older secret versions
remain for rollback; review and remove versions only after their referencing
revisions are no longer needed. An app-level secret update does not create a
revision, but it can leave Container App provisioning in progress. An
environment update can create a revision. Make either change in a maintenance
window using the same stop-old-revision sequence. A direct
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
requires its four credentials, the explicit `TWILIO_VIDEO_MODE=live` rollout,
and a fresh venue-phone test. SMS/WhatsApp requires sender registration and
webhook configuration for inbound ballots and automated acknowledgment replies;
OpenAI vision, Segment, and SendGrid are optional server integrations. See
[the booth runbook](runbook.md) for event operations. The hosted site does not
implement Voice or Agent Connect.
