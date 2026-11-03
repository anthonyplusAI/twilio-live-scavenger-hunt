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

## GitHub settings created by the script

| Kind | Name | Use |
| --- | --- | --- |
| Variables | `ACR_NAME`, `ACA_NAME`, `ACA_RESOURCE_GROUP` | Image and rollout target. |
| Variable | `LITESTREAM_REQUIRE_REPLICA` | Starts as `0`; set to `1` after the first backup has been verified. |
| Secrets | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | OIDC identifiers for `azure/login`; no client secret. |

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
