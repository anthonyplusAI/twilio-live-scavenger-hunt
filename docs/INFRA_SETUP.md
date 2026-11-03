# Azure infrastructure setup

This is the one-time setup for the Live Scavenger Hunt deployment. It follows
the same dedicated-resource-group, ACR, Container Apps, Log Analytics, and
GitHub OIDC pattern as Birdies & Eagles. The app keeps its working SQLite file
on the container's fast local disk. Litestream restores and continuously copies
that database to a private Azure Blob container; SQLite is **not** placed on an
Azure Files network mount.

## Resources and access

| Resource | Name | Purpose |
| --- | --- | --- |
| Resource group | `rg-live-scavenger-hunt` | Isolates the deployment in `centralus`. |
| Container Registry | `livescavengerhunt` | Private SHA-tagged images; admin login disabled. |
| Log Analytics | `law-live-scavenger-hunt` | Container logs and rollout diagnostics. |
| Container Apps environment | `cae-live-scavenger-hunt` | Hosts the single-replica app. |
| Container App | `live-scavenger-hunt` | Public HTTPS ingress, one replica. The placeholder uses port `80`; the real app uses `8080`. |
| Storage account | `livescavengerhuntdata` | Private HTTPS-only `StorageV2`/`Standard_LRS` Blob store. |
| Blob container | `litestream` | Database replica; seven-day Blob and container soft delete. |
| Entra application | `live-scavenger-hunt-gha-deploy` | Trusts this repo's `main` branch via GitHub OIDC. |

The app's system-assigned managed identity has `AcrPull` on ACR and `Storage
Blob Data Contributor` on the backup storage account. The GitHub OIDC service
principal has `AcrPush` on ACR and `Contributor` on this resource group. No ACR
admin credential, Azure service-principal password, or Blob account key is
stored in GitHub or the Container App. The provisioner creates the private
container through Azure Resource Manager without a storage key. The app also
holds a renewable lease on `live-scavenger-hunt-writer.lock` in this container while Litestream
and the game server run. An extra replica waits for that lease instead of
becoming a second SQLite writer.
GitHub currently issues immutable OIDC subjects containing numeric owner and
repository IDs. The provisioner reads the repository's subject prefix from
GitHub and registers the exact `main` branch claim in Entra.

## Before running

Install Azure CLI and GitHub CLI, sign into both, then select the intended
subscription. The script checks the selected subscription and GitHub repository
before creating anything. It is safe to rerun and preserves an existing admin
password, GitHub secrets, and a running app's environment and revisions.

```sh
az login
az account set --subscription b001fc6f-ea19-456a-8401-63971a1a1d98
gh auth login
export AZURE_SUBSCRIPTION_ID=b001fc6f-ea19-456a-8401-63971a1a1d98
./scripts/provision-azure.sh
```

The expected subscription is **DevNet Demos Prod** and the expected repo is
`anthonyplusAI/twilio-live-scavenger-hunt`. If an existing resource group has a
different registry, storage account, app, or Container Apps environment, the
script stops instead of silently pointing the game at an empty backup store.
The default names can be overridden with `RG`, `LOCATION`, `ACR`, `ACA_ENV`,
`ACA`, `LAW`, `STORAGE`, and `BLOB` after reviewing the existing resources.

Provisioning creates an active public placeholder revision on port `80`. The
first deploy workflow pins and stops that revision, switches ingress to port
`8080`, and starts the real app. The Container App is preconfigured with
`HOST=0.0.0.0`, `PORT=8080`, its canonical
`PUBLIC_BASE_URL=https://<Container App FQDN>`, local SQLite path
`/tmp/live-scavenger-hunt.sqlite`, and Litestream managed-identity settings.
`REHEARSAL_MODE=on` lets the site run before Twilio Video credentials are added.

The script generates a strong one-time `BOOTSTRAP_ADMIN_PASSWORD` and stores it
as a Container App secret. It is **not printed in container logs** or committed
to the repo. To retrieve it from a private terminal after the first real deploy:

```sh
az containerapp secret list \
  --name live-scavenger-hunt --resource-group rg-live-scavenger-hunt \
  --show-values \
  --query "[?name=='bootstrap-admin-password'].value | [0]" -o tsv
```

The first username is `admin`. Keep the retrieved password in a password manager.
After signing in, **Team → Admin login** edits that existing local account.
Leave the username as `admin` and enter a new password to reset it, or change
the username as well. The account's active sessions end after either change.
If the database already has users, bootstrap leaves them unchanged. Treat the
Container App secret and Blob replica as sensitive because the database holds
accounts, event settings, metrics, and captured leads.

After signing in, use **Team → Add operator** in the control room to create
separate local operator accounts. An admin can reset and rename those accounts
from Team. Changing `bootstrap-admin-password` after first boot does not change
the saved admin login. Local operator accounts work without Google OAuth.

## Optional Google sign-in for Twilio admins

Google sign-in is disabled until both OAuth credentials are configured. The
server grants the **admin** role to any Google account whose signed ID token
has a verified `@twilio.com` email **and** `hd=twilio.com`, the Google Workspace
domain claim. This gives the account access to Team, Metrics, and collected leads. The
`hd` request parameter only helps choose an account; the server checks the
returned claim. See [Google's OpenID Connect guidance](https://developers.google.com/identity/openid-connect/openid-connect).

1. In a Google Cloud project you administer, configure **Google Auth Platform**
   branding and audience. If the project belongs to the Twilio Workspace
   organization, an **Internal** audience can limit who reaches the consent
   screen. An **External** app in Testing is limited to named test users, so it
   cannot meet the “any verified Twilio account” requirement until its
   publishing setup allows that audience. The app enforces the Workspace claim
   either way. See [Google's audience options](https://support.google.com/cloud/answer/15549945).
2. In **Google Auth Platform → Clients**, create an OAuth client of type **Web
   application**. Add this exact **Authorized redirect URI**:

   ```text
   https://live-scavenger-hunt.delightfulwave-e00d5e3d.centralus.azurecontainerapps.io/api/auth/google/callback
   ```

   The scheme, host, path, and trailing slash must match exactly. If the app
   later gets a custom domain, register that new callback and update
   `PUBLIC_BASE_URL` during a controlled rollout. For local tests, you may also
   register `http://127.0.0.1:65111/api/auth/google/callback` and use a local
   `.env` with that origin. See [Google's web-server OAuth setup](https://developers.google.com/identity/protocols/oauth2/web-server).
3. In this GitHub repository, open **Settings → Secrets and variables → Actions**.
   Add repository secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from the
   new client. Do not place the client secret in `.env.example`, the repo, or a
   workflow variable. The deploy job reads these secrets; the CI and image-build
   jobs do not.
4. Dispatch `deploy.yml` on `main` between heats. The controlled rollout first
   stops the old SQLite writer, then stores the client secret with any other
   supplied credentials as a batch. It waits for Azure
   provisioning to settle, verifies the expected secret names, and attaches
   both settings to the candidate revision. Check
   `/api/auth/providers` for `google.enabled: true`, then sign in on the stable
   public hostname with a verified Twilio Workspace account. A non-Twilio
   account should be denied. The Google button appears on `/login` only when
   configured.

If only one GitHub secret is present while enabling or refreshing Google
sign-in, deployment fails **before** the old revision is stopped. If neither
is present, deployment preserves any existing OAuth configuration. To turn
Google sign-in off explicitly, set repository
variable `GOOGLE_AUTH_DISABLE=1` and dispatch the same controlled deployment;
the new revision has both OAuth environment variables removed. Set the variable to `0` and
deploy with both secrets to re-enable it. The stored Container App secret is
retained for rollback and no longer used while sign-in is disabled.

## GitHub settings

The provisioner creates the Azure and Litestream entries. Add Google and
Twilio entries in **Settings → Secrets and variables → Actions** when those
integrations are ready. The CI and image-build jobs never receive application
credentials; only the deploy job reads them.

| Kind | Name | Use |
| --- | --- | --- |
| Variables | `ACR_NAME`, `ACA_NAME`, `ACA_RESOURCE_GROUP` | Image and rollout target. |
| Variable | `LITESTREAM_REQUIRE_REPLICA` | Starts as `0`; set to `1` after the first backup has been verified. |
| Secrets | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | OIDC identifiers for `azure/login`; no client secret. |
| Optional secrets | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google admin sign-in; consumed by the deploy job only. |
| Optional variable | `GOOGLE_AUTH_DISABLE` | Set to `1` for an explicit controlled sign-in disable; `0` re-enables when both secrets exist. |
| Twilio secrets | `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_AUTH_TOKEN` | The complete Video set. The Auth Token also validates signed Video and Messaging webhooks. |
| Twilio variable | `TWILIO_VIDEO_MODE` | Set to `live` to activate Video with the full credential set, or `rehearsal` to use app-routed camera snapshots. Unset preserves the current Video mode. |
| Optional secrets | `OPENAI_API_KEY`, `SEGMENT_WRITE_KEY`, `SENDGRID_API_KEY`, `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` | AI-assisted judging, Segment mirroring, requested guide email, and verification of SendGrid delivery callbacks respectively. |
| Optional variables | `OPENAI_VISION_MODEL`, `SENDGRID_FROM_EMAIL`, `SENDGRID_REGION` | Model choice, verified guide sender, and SendGrid API region. |

The provisioner leaves any existing GitHub secret value untouched. If an OIDC
identifier must change later, rotate it deliberately in repository settings.
GitHub's deploy workflow never forwards these identifiers to its test job.
Segment only receives the limited, contact-free activity stream.

## First rollout and backup verification

1. Merge a green deployment PR to `main` or dispatch `deploy.yml` from `main`.
   Watch the CI, image build, controlled rollout, and `/health` smoke pass.
2. Open the app's HTTPS arena, player page, spectator ballot, operator login,
   and private metrics. The first rollout runs in **rehearsal mode**; live
   Twilio Video and SMS/WhatsApp still need account setup.
3. Confirm Litestream has written files under the `live-scavenger-hunt.sqlite`
   prefix in the private `litestream` Blob container. For a one-time management
   check, use a storage key in a shell variable and clear it immediately:

   ```sh
   STORAGE_KEY="$(az storage account keys list -g rg-live-scavenger-hunt \
     --account-name livescavengerhuntdata --query '[0].value' -o tsv)"
   az storage blob list --account-name livescavengerhuntdata \
     --container-name litestream --account-key "$STORAGE_KEY" \
     --prefix live-scavenger-hunt.sqlite/ --query '[].name' -o tsv
   unset STORAGE_KEY
   ```

4. Run a **restore drill to a different file** and check `PRAGMA integrity_check`
   before any expo. Never overwrite the live `/tmp/live-scavenger-hunt.sqlite`
   file during a drill. A stopped copy of the container with its managed
   identity, or `az containerapp exec` with a separate output path, can run
   `litestream restore -config /etc/litestream.yml -o /tmp/restore-check.sqlite
   /tmp/live-scavenger-hunt.sqlite`.
5. After a verified backup and restore, require a remote replica on every
   future start: `gh variable set LITESTREAM_REQUIRE_REPLICA --body 1`, then
   dispatch `deploy.yml` again. The rollout stops the old writer before applying
   that setting. A missing or unreadable backup will then fail startup instead
   of silently creating an empty database.

Litestream attempts a sync once per second when Blob is healthy. A sudden host
failure can lose unreplicated writes, and Blob errors can make the lag much
longer; this is a **backup/restore design**, not a zero-loss database. Check
backup freshness and restore integrity before each event. Do not deploy during an
active heat. The deployment workflow intentionally creates a short outage to
prevent two game engines or Litestream writers from running at once.
Azure control-plane conflicts can extend that pause; use the
[deployment recovery steps](DEPLOYMENT.md#failed-rollout-recovery)
if the old revision is not restored automatically.
The app allows a 60-second graceful shutdown so Litestream can finish its
final sync. Container Apps can briefly exceed a configured replica limit during platform
maintenance; the Blob lease protects against concurrent writers in that case.
If Blob is unavailable, a new replica cannot acquire the lease or restore the
database, so the game remains unavailable until storage recovers.

## Activate Twilio Video

The deployed HTTPS origin already supports phone camera permission and signed
webhooks. The application creates a Video Group Room for each heat and supplies
its own room status callback URL; no account-wide Video webhook is needed.

1. In the Twilio Console, get the **Account SID** and **Auth Token** for the
   account that will own the Rooms. Create a **Standard API Key** in **US1** for
   Video and copy its SID and secret when the Console shows them. The API Key
   secret and Auth Token are different credentials. Keep both in a password
   manager; do not paste either into an issue, commit, or chat.
2. Add the four GitHub **Actions secrets** listed in the table above. Store
   the Account SID and API Key SID there too so all four values reach Azure as
   Container App secret references. Set the repository **Actions variable**
   `TWILIO_VIDEO_MODE` to `live`.
3. Dispatch `deploy.yml` from `main` **between heats**. The script checks that
   the quartet is complete and the SID shapes are correct *before* touching
   Azure. It then stops and verifies the old writer, stores four
   rollout-specific ACA secrets as a batch, waits for Azure
   provisioning to settle, verifies their names, and starts the candidate with
   `REHEARSAL_MODE=off`. The previous revision keeps its original secret
   references if the candidate needs a pre-cutover rollback. An unset mode
   leaves the current setting alone. `TWILIO_VIDEO_MODE=rehearsal` explicitly
   switches the next revision back to snapshots without deleting stored
   credentials. Use the same controlled workflow for later credential changes;
   a direct Container App environment update can start a second SQLite writer.
4. After cutover, sign in and check **Operator → Preflight**. Run a real heat
   with at least two phones and the signed-in arena wall. Confirm the phones
   publish video, the wall subscribes, and the Video callback reports player
   connection changes. A healthy `/health` response alone does not prove the
   Twilio credentials work. The script can check completeness and SID format,
   but the live heat verifies account access and the API Key secret.

For SMS or WhatsApp ballots, the deployed Auth Token verifies Twilio's inbound
signature even when Video remains in rehearsal mode. A nonempty
`TWILIO_AUTH_TOKEN` Actions secret is attached during a controlled deployment
without changing the explicit `REHEARSAL_MODE` setting. The hosted app starts
with `REHEARSAL_MODE=on`. Use senders in the same Twilio account as that
Auth Token; the app has one app-wide signing token. Configure the sender's
inbound **POST** webhook
to the exact public URL
`https://live-scavenger-hunt.delightfulwave-e00d5e3d.centralus.azurecontainerapps.io/webhooks/twilio/messaging`,
then enable that sender and channel in the event's voting settings. The app
responds with TwiML ballot acknowledgments, which Twilio sends as replies from
the sender. Obtain the sender registrations and approvals required for both
inbound ballots and those replies in each event country. If replies go from a
US local 10DLC number to US recipients, [register its A2P 10DLC brand and
campaign](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/quickstart)
before use. The WhatsApp Sandbox requires every test phone to send its join
code; use a [registered WhatsApp Business
sender](https://www.twilio.com/docs/whatsapp/self-sign-up) for expo visitors.
The web ballot works without a Messaging sender.
See [the deployment guide](DEPLOYMENT.md) and [the booth runbook](runbook.md)
for verification and optional OpenAI, Segment, and SendGrid setup.

## Activate optional AI, Segment, and guide email

These server integrations are independent of live Twilio Video. Add their
credentials under the same GitHub **Actions secrets and variables** page, then
dispatch `deploy.yml` from `main` between heats. The deployment validates
settings before the old revision stops and attaches API keys as
rollout-specific ACA secret references only after that writer reaches zero
replicas. Supplied secrets are batched into a Container App update; the workflow waits
for provisioning to settle and verifies their names before starting the
replacement. Empty or absent
settings preserve the existing ACA values.

1. **AI judging:** add `OPENAI_API_KEY` as an Actions secret. Optionally set the
   Actions variable `OPENAI_VISION_MODEL` to a model available to that account;
   the app otherwise uses its built-in default. Only AI-assisted prompts send
   a brief camera evidence image for review, and the operator can override the
   verdict. Check the event's camera consent and privacy copy before use.
2. **Segment:** create a Source and add its `SEGMENT_WRITE_KEY` as an Actions
   secret to mirror the app's limited activity stream. Local metrics continue
   to work without Segment. The app sends no lead identity to Segment.
3. **Guide email:** verify the sending identity in SendGrid, create an API key
   with Mail Send access, add `SENDGRID_API_KEY` as an Actions secret, and set
   `SENDGRID_FROM_EMAIL` to the exact verified address as an Actions variable.
   Both settings must be present when enabling or refreshing guide email; a
   partial pair fails before downtime. Set `SENDGRID_REGION=eu` only for an EU
   regional account. The default uses the global API; `global` or `us` can
   explicitly switch a previously configured EU deployment back. The default
   post-heat action is a GitHub star link. An admin can instead make the guide
   or expert action primary in event settings. A first follow-up action opens a
   voluntary contact form after play; a compatible second request reuses those
   details. A guide request needs an email. The same actions
   are available to spectators who do not play. Expert requests enter the
   admin-only follow-up queue in Metrics and do not place a Voice call.
4. **Confirm guide delivery:** in SendGrid, open **Settings → Mail Settings →
   Event Webhooks**, create an Event Webhook with POST URL
   `https://live-scavenger-hunt.delightfulwave-e00d5e3d.centralus.azurecontainerapps.io/webhooks/sendgrid/events`
   (replace the host if this event runs at another origin), and select
   **processed**, **deferred**, **delivered**, **bounce**, and **dropped** events.
   Enable **Signed Event Webhook** and save the webhook. Open its edit screen
   to copy the public verification key; add it as the Actions secret
   `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY`, then deploy. The app rejects unsigned
   or invalid callbacks. See [SendGrid's signed webhook setup](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features)
   for the signing control and key location. Mail Send's HTTP `202` means
   SendGrid accepted the message; only a signed callback can confirm delivery
   or report a bounce/drop. The webhook key is independent of the Mail Send API
   key and can be added after guide sending is configured. A guide requested
   again for the same event and email within 24 hours is recorded without
   another send. Definite HTTP 429 responses retry with backoff; HTTP 503 and
   uncertain network outcomes require staff review without automatic retry.

After cutover, test one AI-assisted prompt, check that a safe game event appears
in the intended Segment Source, and request a guide with a staff email address.
Check **accepted** first, then **delivered** after the signed SendGrid callback;
an accepted message alone does not establish delivery. The operator Preflight
view checks configuration presence; those real actions confirm account access
and the complete send path. Removing a GitHub secret does not clear an
existing ACA secret reference. Older secret versions are kept for rollback;
clean them up only after their referencing revisions are no longer needed.
Keep all API keys out of the repository and browser code.
