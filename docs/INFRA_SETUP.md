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

The first username is `admin`. Keep the retrieved value in a password manager.
If the database already has users, bootstrap leaves them unchanged. Treat the
Container App secret and Blob replica as sensitive because the database holds
accounts, event settings, metrics, and opt-in leads.

After signing in, use **Team** in the control room to create local operator
usernames and passwords. The **My password** action changes an existing local
account's password; changing `bootstrap-admin-password` after first boot does
not. Local operator accounts work without Google OAuth.

## Optional Google sign-in for Twilio operators

Google sign-in is disabled until both OAuth credentials are configured. The
server grants the **operator** role to any Google account whose signed ID token
has a verified `@twilio.com` email **and** `hd=twilio.com`, the Google Workspace
domain claim. A Google user never becomes an app admin automatically. The
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
   stops the old SQLite writer, then stores the client secret as a Container App
   secret and attaches both settings to the candidate revision. Check
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

The provisioner creates the Azure and Litestream entries. Add the optional
Google entries manually when you create the OAuth client.

| Kind | Name | Use |
| --- | --- | --- |
| Variables | `ACR_NAME`, `ACA_NAME`, `ACA_RESOURCE_GROUP` | Image and rollout target. |
| Variable | `LITESTREAM_REQUIRE_REPLICA` | Starts as `0`; set to `1` after the first backup has been verified. |
| Secrets | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | OIDC identifiers for `azure/login`; no client secret. |
| Optional secrets | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google operator sign-in; consumed by the deploy job only. |
| Optional variable | `GOOGLE_AUTH_DISABLE` | Set to `1` for an explicit controlled sign-in disable; `0` re-enables when both secrets exist. |

The provisioner leaves any existing GitHub secret value untouched. If an OIDC
identifier must change later, rotate it deliberately in repository settings.
GitHub's deploy workflow never forwards these identifiers to its test job.

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
The app allows a 60-second graceful shutdown so Litestream can finish its
final sync. Container Apps can briefly exceed a configured replica limit during platform
maintenance; the Blob lease protects against concurrent writers in that case.
If Blob is unavailable, a new replica cannot acquire the lease or restore the
database, so the game remains unavailable until storage recovers.

## Complete Twilio setup later

The deployed HTTPS origin is suitable for camera permission and webhook URLs.
To enable live video, provide `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`,
`TWILIO_API_KEY_SECRET`, and `TWILIO_AUTH_TOKEN` as Container App secrets, set
`REHEARSAL_MODE=off`, and roll out those environment changes through the same
stop-old-revision process. Configure Twilio webhook URLs with the exact public
HTTPS origin. Messaging, AI judging, Segment, and SendGrid remain optional and
each needs its own credentials or registration. See [the deployment guide](DEPLOYMENT.md)
and [the booth runbook](runbook.md).
