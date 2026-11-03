#!/usr/bin/env bash
set -Eeuo pipefail

# One-time Azure and GitHub setup for the CI-gated Container Apps deployment.
# Re-running this script adopts the named resources. It never replaces an
# existing bootstrap password or changes a running game's revision settings.

RG="${RG:-rg-live-scavenger-hunt}"
LOCATION="${LOCATION:-centralus}"
ACR="${ACR:-livescavengerhunt}"
ACA_ENV="${ACA_ENV:-cae-live-scavenger-hunt}"
ACA="${ACA:-live-scavenger-hunt}"
LAW="${LAW:-law-live-scavenger-hunt}"
STORAGE="${STORAGE:-livescavengerhuntdata}"
BLOB="${BLOB:-litestream}"
REPO="anthonyplusAI/twilio-live-scavenger-hunt"
DEPLOY_APP_NAME="${ACA}-gha-deploy"
TAGS=(created_by=codex managed_by=live-scavenger-hunt)
PLACEHOLDER_IMAGE="mcr.microsoft.com/k8se/quickstart:latest"

fail() { echo "ERROR: $*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || fail "Install '$1' before provisioning."; }
require az
require gh
require openssl

# Pin the Azure subscription explicitly. A default CLI context is too easy to
# change between projects, and provisioning creates billable resources.
: "${AZURE_SUBSCRIPTION_ID:?Set AZURE_SUBSCRIPTION_ID to the intended subscription ID before running this script.}"
ACTUAL_SUBSCRIPTION="$(az account show --query id -o tsv)" \
  || fail "Azure CLI is not signed in. Run az login."
[[ "$ACTUAL_SUBSCRIPTION" == "$AZURE_SUBSCRIPTION_ID" ]] \
  || fail "Selected Azure subscription is $ACTUAL_SUBSCRIPTION, expected $AZURE_SUBSCRIPTION_ID. Select the intended subscription first."
TENANT_ID="$(az account show --query tenantId -o tsv)"
ACTUAL_REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" \
  || fail "GitHub CLI is not signed in or this directory is not a GitHub repo."
ACTUAL_REPO_LOWER="$(printf '%s' "$ACTUAL_REPO" | tr '[:upper:]' '[:lower:]')"
EXPECTED_REPO_LOWER="$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]')"
[[ "$ACTUAL_REPO_LOWER" == "$EXPECTED_REPO_LOWER" ]] \
  || fail "Current GitHub repo is $ACTUAL_REPO, expected $REPO."

echo "Provisioning $ACA in $RG ($LOCATION), subscription $ACTUAL_SUBSCRIPTION, repo $ACTUAL_REPO"

assert_no_other_resource() {
  local kind="$1" expected="$2" found="$3"
  [[ -z "$found" || "$found" == "$expected" ]] \
    || fail "$kind '$found' already exists in $RG. Set the matching name override after reviewing it; do not create a second data destination."
}

if az group show -n "$RG" -o none 2>/dev/null; then
  RG_LOCATION="$(az group show -n "$RG" --query location -o tsv)"
  [[ "$RG_LOCATION" == "$LOCATION" ]] \
    || fail "Existing resource group $RG is in $RG_LOCATION, expected $LOCATION."
  assert_no_other_resource "Container Registry" "$ACR" "$(az acr list -g "$RG" --query '[].name' -o tsv)"
  assert_no_other_resource "Storage account" "$STORAGE" "$(az storage account list -g "$RG" --query '[].name' -o tsv)"
  assert_no_other_resource "Container App" "$ACA" "$(az containerapp list -g "$RG" --query '[].name' -o tsv)"
  assert_no_other_resource "Container Apps environment" "$ACA_ENV" "$(az containerapp env list -g "$RG" --query '[].name' -o tsv)"
  assert_no_other_resource "Log Analytics workspace" "$LAW" "$(az monitor log-analytics workspace list -g "$RG" --query '[].name' -o tsv)"
else
  az group create -n "$RG" -l "$LOCATION" --tags "${TAGS[@]}" -o none
fi

echo "[1/6] Container Registry"
if ! az acr show -n "$ACR" -g "$RG" -o none 2>/dev/null; then
  az acr create -n "$ACR" -g "$RG" --sku Basic --tags "${TAGS[@]}" -o none
fi
# The image is pushed by GitHub OIDC and pulled by the app's managed identity.
az acr update -n "$ACR" -g "$RG" --admin-enabled false -o none
ACR_ID="$(az acr show -n "$ACR" -g "$RG" --query id -o tsv)"

echo "[2/6] Private Blob backup store"
if ! az storage account show -n "$STORAGE" -g "$RG" -o none 2>/dev/null; then
  az storage account create -n "$STORAGE" -g "$RG" -l "$LOCATION" \
    --kind StorageV2 --sku Standard_LRS --https-only true \
    --allow-blob-public-access false --min-tls-version TLS1_2 \
    --tags "${TAGS[@]}" -o none
else
  az storage account update -n "$STORAGE" -g "$RG" --https-only true \
    --allow-blob-public-access false --min-tls-version TLS1_2 -o none
fi
STORAGE_ID="$(az storage account show -n "$STORAGE" -g "$RG" --query id -o tsv)"
az storage account blob-service-properties update -n "$STORAGE" -g "$RG" \
  --enable-delete-retention true --delete-retention-days 7 \
  --enable-container-delete-retention true --container-delete-retention-days 7 -o none
# Manage the container through Azure Resource Manager; no account key is needed.
if az storage container-rm show --name "$BLOB" --storage-account "$STORAGE" \
    --resource-group "$RG" -o none 2>/dev/null; then
  az storage container-rm update --name "$BLOB" --storage-account "$STORAGE" \
    --resource-group "$RG" --public-access off -o none
else
  az storage container-rm create --name "$BLOB" --storage-account "$STORAGE" \
    --resource-group "$RG" --public-access off -o none
fi

echo "[3/6] Log Analytics and Container Apps environment"
if ! az monitor log-analytics workspace show -g "$RG" -n "$LAW" -o none 2>/dev/null; then
  az monitor log-analytics workspace create -g "$RG" -n "$LAW" -l "$LOCATION" \
    --tags "${TAGS[@]}" -o none
fi
if ! az containerapp env show -n "$ACA_ENV" -g "$RG" -o none 2>/dev/null; then
  LAW_ID="$(az monitor log-analytics workspace show -g "$RG" -n "$LAW" --query customerId -o tsv)"
  LAW_KEY="$(az monitor log-analytics workspace get-shared-keys -g "$RG" -n "$LAW" --query primarySharedKey -o tsv)"
  az containerapp env create -n "$ACA_ENV" -g "$RG" -l "$LOCATION" \
    --logs-destination log-analytics --logs-workspace-id "$LAW_ID" \
    --logs-workspace-key "$LAW_KEY" --tags "${TAGS[@]}" -o none
  unset LAW_KEY
fi

echo "[4/6] Container App, identity, and runtime configuration"
if ! az containerapp show -n "$ACA" -g "$RG" -o none 2>/dev/null; then
  az containerapp create -n "$ACA" -g "$RG" --environment "$ACA_ENV" \
    --image "$PLACEHOLDER_IMAGE" --target-port 80 --ingress external \
    --cpu 1.0 --memory 2.0Gi --min-replicas 1 --max-replicas 1 \
    --tags "${TAGS[@]}" -o none
fi
EXPECTED_ENV_ID="$(az containerapp env show -n "$ACA_ENV" -g "$RG" --query id -o tsv)"
APP_ENV_ID="$(az containerapp show -n "$ACA" -g "$RG" \
  --query properties.managedEnvironmentId -o tsv)"
[[ "$APP_ENV_ID" == "$EXPECTED_ENV_ID" ]] \
  || fail "Container App $ACA belongs to $APP_ENV_ID, expected $EXPECTED_ENV_ID."
APP_IDENTITY="$(az containerapp show -n "$ACA" -g "$RG" \
  --query identity.principalId -o tsv)"
if [[ -z "$APP_IDENTITY" ]]; then
  APP_IDENTITY="$(az containerapp identity assign -n "$ACA" -g "$RG" \
    --system-assigned --query principalId -o tsv)"
fi
[[ -n "$APP_IDENTITY" ]] || fail "Container App system identity was not assigned."

ensure_role() {
  local principal="$1" role="$2" scope="$3" count
  count="$(az role assignment list --assignee "$principal" --scope "$scope" \
    --role "$role" --query 'length(@)' -o tsv)"
  if [[ "$count" == "0" ]]; then
    az role assignment create --assignee-object-id "$principal" \
      --assignee-principal-type ServicePrincipal --role "$role" --scope "$scope" -o none
  fi
}
ensure_role "$APP_IDENTITY" AcrPull "$ACR_ID"
ensure_role "$APP_IDENTITY" 'Storage Blob Data Contributor' "$STORAGE_ID"
REGISTRY_IDENTITY="$(az containerapp show -n "$ACA" -g "$RG" \
  --query "properties.configuration.registries[?server=='${ACR}.azurecr.io'].identity | [0]" -o tsv)"
if [[ "$REGISTRY_IDENTITY" != system ]]; then
  az containerapp registry set -n "$ACA" -g "$RG" \
    --server "${ACR}.azurecr.io" --identity system -o none
fi

APP_IMAGE="$(az containerapp show -n "$ACA" -g "$RG" \
  --query 'properties.template.containers[0].image' -o tsv)"
SECRET_EXISTS="$(az containerapp secret list -n "$ACA" -g "$RG" \
  --query "[?name=='bootstrap-admin-password'].name | [0]" -o tsv)"
if [[ -z "$SECRET_EXISTS" ]]; then
  BOOTSTRAP_PASSWORD="$(openssl rand -hex 32)"
  az containerapp secret set -n "$ACA" -g "$RG" \
    --secrets "bootstrap-admin-password=$BOOTSTRAP_PASSWORD" -o none
  unset BOOTSTRAP_PASSWORD
fi
FQDN="$(az containerapp show -n "$ACA" -g "$RG" \
  --query properties.configuration.ingress.fqdn -o tsv)"
[[ -n "$FQDN" ]] || fail "Container App has no public FQDN."
if [[ "$APP_IMAGE" == "$PLACEHOLDER_IMAGE" ]]; then
  # Only a placeholder may be updated here. After the real image is live, all
  # configuration changes must use the controlled stop-old-revision rollout.
  az containerapp update -n "$ACA" -g "$RG" \
    --set-env-vars \
      HOST=0.0.0.0 PORT=8080 NODE_ENV=production \
      "PUBLIC_BASE_URL=https://${FQDN}" \
      LIVE_SCAVENGER_HUNT_DB=/tmp/live-scavenger-hunt.sqlite \
      LITESTREAM_ENABLED=1 \
      "LITESTREAM_AZURE_ACCOUNT_NAME=${STORAGE}" \
      "LITESTREAM_AZURE_CONTAINER_NAME=${BLOB}" \
      LITESTREAM_REQUIRE_REPLICA=0 \
      REHEARSAL_MODE=on \
      BOOTSTRAP_ADMIN_PASSWORD=secretref:bootstrap-admin-password \
    --min-replicas 1 --max-replicas 1 -o none
else
  echo "  Existing app image is live; preserving its env, secrets, and revisions."
fi

echo "[5/6] Dedicated GitHub OIDC identity"
APP_IDS="$(az ad app list --display-name "$DEPLOY_APP_NAME" --query '[].appId' -o tsv)"
[[ "$(printf '%s\n' "$APP_IDS" | sed '/^$/d' | wc -l | tr -d ' ')" -le 1 ]] \
  || fail "More than one Entra app is named $DEPLOY_APP_NAME. Resolve the duplicate before provisioning."
OIDC_APP_ID="$APP_IDS"
if [[ -z "$OIDC_APP_ID" ]]; then
  OIDC_APP_ID="$(az ad app create --display-name "$DEPLOY_APP_NAME" --query appId -o tsv)"
fi
if ! az ad sp show --id "$OIDC_APP_ID" -o none 2>/dev/null; then
  az ad sp create --id "$OIDC_APP_ID" -o none
fi
OIDC_PRINCIPAL="$(az ad sp show --id "$OIDC_APP_ID" --query id -o tsv)"
ensure_role "$OIDC_PRINCIPAL" AcrPush "$ACR_ID"
RG_ID="$(az group show -n "$RG" --query id -o tsv)"
ensure_role "$OIDC_PRINCIPAL" Contributor "$RG_ID"

OIDC_SUBJECT="repo:${ACTUAL_REPO}:ref:refs/heads/main"
EXISTING_SUBJECT="$(az ad app federated-credential list --id "$OIDC_APP_ID" \
  --query "[?name=='gha-main'].subject | [0]" -o tsv)"
if [[ -n "$EXISTING_SUBJECT" && "$EXISTING_SUBJECT" != "$OIDC_SUBJECT" ]]; then
  fail "Existing gha-main federated credential trusts $EXISTING_SUBJECT, not $OIDC_SUBJECT. Refusing to overwrite trust."
fi
if [[ -z "$EXISTING_SUBJECT" ]]; then
  OIDC_PARAMETERS="$(printf '{"name":"gha-main","issuer":"https://token.actions.githubusercontent.com","subject":"%s","audiences":["api://AzureADTokenExchange"]}' "$OIDC_SUBJECT")"
  az ad app federated-credential create --id "$OIDC_APP_ID" \
    --parameters "$OIDC_PARAMETERS" -o none
fi

echo "[6/6] GitHub deployment variables and OIDC identifiers"
gh variable set ACR_NAME --body "$ACR"
gh variable set ACA_NAME --body "$ACA"
gh variable set ACA_RESOURCE_GROUP --body "$RG"
if ! gh variable list --json name --jq '.[].name' | grep -qx LITESTREAM_REQUIRE_REPLICA; then
  gh variable set LITESTREAM_REQUIRE_REPLICA --body 0
fi
ensure_gh_secret() {
  local name="$1" value="$2"
  if gh secret list --json name --jq '.[].name' | grep -qx "$name"; then
    echo "  $name already exists; leaving it untouched."
  else
    gh secret set "$name" --body "$value"
  fi
}
ensure_gh_secret AZURE_CLIENT_ID "$OIDC_APP_ID"
ensure_gh_secret AZURE_TENANT_ID "$TENANT_ID"
ensure_gh_secret AZURE_SUBSCRIPTION_ID "$ACTUAL_SUBSCRIPTION"

echo "Provisioning complete. ACA URL: https://${FQDN}"
echo "The placeholder remains active for the first controlled rollout."
echo "After the first deploy, verify Blob backup, set LITESTREAM_REQUIRE_REPLICA=1, and redeploy."
echo "Twilio remains unconfigured; the app will launch in rehearsal mode."
