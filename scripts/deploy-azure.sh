#!/usr/bin/env bash
set -Eeuo pipefail

# The app and Litestream each write local SQLite state. ACA's normal single-
# revision rollout overlaps old and new replicas, so we deliberately take a
# short outage and prove the old writer is gone before starting the new one.

IMAGE="${1:?Usage: scripts/deploy-azure.sh ACR_IMAGE_URI}"
: "${ACA_NAME:?ACA_NAME must be set}"
: "${ACA_RESOURCE_GROUP:?ACA_RESOURCE_GROUP must be set}"
for command in az jq curl; do
  command -v "$command" >/dev/null || { echo "Required command missing: $command" >&2; exit 1; }
done
if [ -n "${LITESTREAM_REQUIRE_REPLICA:-}" ] &&
   [ "$LITESTREAM_REQUIRE_REPLICA" != '0' ] &&
   [ "$LITESTREAM_REQUIRE_REPLICA" != '1' ]; then
  echo 'LITESTREAM_REQUIRE_REPLICA must be 0 or 1 when set.' >&2
  exit 1
fi
# Validate OAuth settings before stopping the current writer. An unset pair
# preserves the Container App's existing configuration; an explicit disable
# clears the candidate revision's OAuth environment without deleting secrets.
if [ -n "${GOOGLE_AUTH_DISABLE:-}" ] &&
   [ "$GOOGLE_AUTH_DISABLE" != '0' ] && [ "$GOOGLE_AUTH_DISABLE" != '1' ]; then
  echo 'GOOGLE_AUTH_DISABLE must be 0 or 1 when set.' >&2
  exit 1
fi
GOOGLE_AUTH_UPDATE=0
if [ "${GOOGLE_AUTH_DISABLE:-0}" != '1' ] &&
   { [ -n "${GOOGLE_CLIENT_ID:-}" ] || [ -n "${GOOGLE_CLIENT_SECRET:-}" ]; }; then
  if [ -z "${GOOGLE_CLIENT_ID:-}" ] || [ -z "${GOOGLE_CLIENT_SECRET:-}" ]; then
    echo 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be set to update Google sign-in.' >&2
    exit 1
  fi
  if [[ "$GOOGLE_CLIENT_ID" =~ [[:space:]] ]] || [[ "$GOOGLE_CLIENT_SECRET" =~ [[:space:]] ]]; then
    echo 'Google OAuth credentials cannot contain whitespace.' >&2
    exit 1
  fi
  GOOGLE_AUTH_UPDATE=1
fi
# Twilio activation is an explicit deployment choice. Unset mode preserves the
# current Video mode, even if credentials are already stored in GitHub. The
# Auth Token may be updated alone for signed inbound Messaging webhooks.
if [ -n "${TWILIO_VIDEO_MODE:-}" ] &&
   [ "$TWILIO_VIDEO_MODE" != 'live' ] &&
   [ "$TWILIO_VIDEO_MODE" != 'rehearsal' ]; then
  echo 'TWILIO_VIDEO_MODE must be live or rehearsal when set.' >&2
  exit 1
fi
TWILIO_VIDEO_UPDATE=0
if [ "${TWILIO_VIDEO_MODE:-}" = 'live' ]; then
  if [ -z "${TWILIO_ACCOUNT_SID:-}" ] ||
     [ -z "${TWILIO_API_KEY_SID:-}" ] ||
     [ -z "${TWILIO_API_KEY_SECRET:-}" ] ||
     [ -z "${TWILIO_AUTH_TOKEN:-}" ]; then
    echo 'Live Twilio Video requires TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, and TWILIO_AUTH_TOKEN.' >&2
    exit 1
  fi
  if [[ ! "$TWILIO_ACCOUNT_SID" =~ ^AC[0-9a-fA-F]{32}$ ]]; then
    echo 'TWILIO_ACCOUNT_SID must be an Account SID (AC plus 32 hexadecimal characters).' >&2
    exit 1
  fi
  if [[ ! "$TWILIO_API_KEY_SID" =~ ^SK[0-9a-fA-F]{32}$ ]]; then
    echo 'TWILIO_API_KEY_SID must be an API Key SID (SK plus 32 hexadecimal characters).' >&2
    exit 1
  fi
  if [[ "$TWILIO_API_KEY_SECRET" =~ [[:space:]] ]]; then
    echo 'TWILIO_API_KEY_SECRET cannot contain whitespace.' >&2
    exit 1
  fi
  TWILIO_VIDEO_UPDATE=1
fi
if [ -n "${TWILIO_AUTH_TOKEN:-}" ] && [[ "$TWILIO_AUTH_TOKEN" =~ [[:space:]] ]]; then
  echo 'TWILIO_AUTH_TOKEN cannot contain whitespace.' >&2
  exit 1
fi
# Optional server integrations follow the same stopped-writer rollout. Blank
# GitHub settings preserve the current Container App values.
if [ -n "${OPENAI_API_KEY:-}" ] && [[ "$OPENAI_API_KEY" =~ [[:space:]] ]]; then
  echo 'OPENAI_API_KEY cannot contain whitespace.' >&2
  exit 1
fi
if [ -n "${OPENAI_VISION_MODEL:-}" ] && [[ "$OPENAI_VISION_MODEL" =~ [[:space:]] ]]; then
  echo 'OPENAI_VISION_MODEL cannot contain whitespace.' >&2
  exit 1
fi
if [ -n "${SEGMENT_WRITE_KEY:-}" ] && [[ "$SEGMENT_WRITE_KEY" =~ [[:space:]] ]]; then
  echo 'SEGMENT_WRITE_KEY cannot contain whitespace.' >&2
  exit 1
fi
SENDGRID_UPDATE=0
if [ -n "${SENDGRID_API_KEY:-}" ] || [ -n "${SENDGRID_FROM_EMAIL:-}" ]; then
  if [ -z "${SENDGRID_API_KEY:-}" ] || [ -z "${SENDGRID_FROM_EMAIL:-}" ]; then
    echo 'SENDGRID_API_KEY and SENDGRID_FROM_EMAIL must both be set to update guide email.' >&2
    exit 1
  fi
  if [[ "$SENDGRID_API_KEY" =~ [[:space:]] ]]; then
    echo 'SENDGRID_API_KEY cannot contain whitespace.' >&2
    exit 1
  fi
  if [[ ! "$SENDGRID_FROM_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
    echo 'SENDGRID_FROM_EMAIL must be a valid sender email address.' >&2
    exit 1
  fi
  SENDGRID_UPDATE=1
fi
if [ -n "${SENDGRID_REGION:-}" ] &&
   [ "$SENDGRID_REGION" != 'eu' ] &&
   [ "$SENDGRID_REGION" != 'global' ] &&
   [ "$SENDGRID_REGION" != 'us' ]; then
  echo 'SENDGRID_REGION must be eu, global, or us when set.' >&2
  exit 1
fi
if [ -n "${GITHUB_RUN_ID:-}" ]; then
  DEPLOY_RUN_ID="$GITHUB_RUN_ID"
else
  # Keep manual local invocations distinct even within the same second.
  DEPLOY_RUN_ID="$(date -u +%s)$$"
fi
DEPLOY_SUFFIX="r${DEPLOY_RUN_ID}a${GITHUB_RUN_ATTEMPT:-1}"
if [[ ! "$DEPLOY_SUFFIX" =~ ^r[0-9]+a[0-9]+$ ]] ||
   [ "${#DEPLOY_SUFFIX}" -gt 36 ]; then
  echo 'Deployment run identifier must contain only digits and fit Azure revision and secret names.' >&2
  exit 1
fi

OLD_REVISION=''
OLD_TARGET_PORT=''
NEW_REVISION=''
ROLLOUT_STARTED=0
TRAFFIC_ADMITTED=0
UPDATE_ATTEMPTED=0
EXPECTED_CANDIDATE=''
BASELINE_NAMES='[]'

revision_json() {
  az containerapp revision show \
    --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" \
    --revision "$1" --output json
}

all_revisions_json() {
  az containerapp revision list \
    --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" \
    --all --output json
}

wait_for_zero_replicas() {
  local revision="$1" details active replicas provisioning running stable=0
  for attempt in $(seq 1 60); do
    if details=$(revision_json "$revision" 2>/dev/null); then
      active=$(jq -r '.properties.active | if . == null then "unknown" else tostring end' <<< "$details")
      replicas=$(jq -r '(.properties.replicas | tonumber? // 0)' <<< "$details")
      provisioning=$(jq -r '.properties.provisioningState // "unknown"' <<< "$details")
      running=$(jq -r '.properties.runningState // "unknown"' <<< "$details")
      if [ "$active" = 'false' ] && [ "$replicas" -eq 0 ] &&
         [ "$provisioning" != 'Provisioning' ] &&
         [ "$provisioning" != 'Deprovisioning' ] &&
         { [ "$running" = 'Stopped' ] || [ "$running" = 'Failed' ] ||
           { [ "$running" = 'unknown' ] &&
             { [ "$provisioning" = 'Deprovisioned' ] ||
               [ "$provisioning" = 'Failed' ] ||
               [ "$provisioning" = 'unknown' ]; }; }; }; then
        stable=$((stable + 1))
        if [ "$stable" -ge 2 ]; then
          echo "Revision $revision has no running writer."
          return 0
        fi
      else
        stable=0
      fi
      echo "Waiting for $revision to stop (active=$active, replicas=$replicas, provisioning=$provisioning, running=$running, $attempt/60)..."
    else
      stable=0
      echo "Waiting for $revision status ($attempt/60)..."
    fi
    sleep 5
  done
  echo "Timed out waiting for revision $revision to reach zero replicas." >&2
  return 1
}

wait_for_stopped_candidate() {
  local revision="$1" details active replicas provisioning running stable=0
  for attempt in $(seq 1 60); do
    if details=$(revision_json "$revision" 2>/dev/null); then
      active=$(jq -r '.properties.active | if . == null then "unknown" else tostring end' <<< "$details")
      replicas=$(jq -r '(.properties.replicas | tonumber? // 0)' <<< "$details")
      provisioning=$(jq -r '.properties.provisioningState // "unknown"' <<< "$details")
      running=$(jq -r '.properties.runningState // "unknown"' <<< "$details")
      if [ "$active" = 'false' ] && [ "$replicas" -eq 0 ] &&
         [ "$provisioning" != 'Provisioning' ] &&
         [ "$provisioning" != 'Deprovisioning' ] &&
         { [ "$running" = 'Stopped' ] || [ "$running" = 'Failed' ] ||
           { [ "$running" = 'unknown' ] &&
             { [ "$provisioning" = 'Deprovisioned' ] ||
               [ "$provisioning" = 'Failed' ] ||
               [ "$provisioning" = 'unknown' ]; }; }; }; then
        stable=$((stable + 1))
        if [ "$stable" -ge 2 ]; then
          echo "Replacement $revision is stopped after provisioning settled."
          return 0
        fi
      else
        stable=0
        az containerapp revision deactivate \
          --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" \
          --revision "$revision" --output none >/dev/null 2>&1 || true
      fi
      echo "Waiting for replacement $revision to settle (active=$active, replicas=$replicas, provisioning=$provisioning, running=$running, $attempt/60)..."
    else
      stable=0
      echo "Waiting for replacement $revision to appear ($attempt/60)..."
    fi
    sleep 5
  done
  echo "Timed out proving replacement $revision is stopped." >&2
  return 1
}

on_exit() {
  local status="$1" revisions candidate latest_revision expected_seen current_port rollback_ok=1
  trap - EXIT
  if [ "$status" -eq 0 ] || [ "$ROLLOUT_STARTED" -eq 0 ]; then
    exit "$status"
  fi
  if [ "$TRAFFIC_ADMITTED" -eq 1 ]; then
    echo '::error::Public traffic may have reached the candidate. Automatic rollback is unsafe because it could discard accepted game or lead writes.' >&2
    exit "$status"
  fi

  # Candidate startup can change the restored SQLite database before public
  # cutover. Automatic old-image rollback requires backward-compatible schema
  # changes; review future migrations before allowing this deployment path.
  set +e
  echo 'Pre-cutover failure: stopping every replacement revision before restoring the previous writer.' >&2
  revisions=$(all_revisions_json 2>/dev/null)
  if [ -z "$revisions" ]; then
    echo '::error::Could not list revisions for a safe rollback. Leaving the app stopped.' >&2
    exit "$status"
  fi
  latest_revision=$(az containerapp show \
    --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" \
    --query properties.latestRevisionName --output tsv 2>/dev/null || true)
  if [ "$UPDATE_ATTEMPTED" -eq 0 ]; then latest_revision=''; fi
  expected_seen=$(jq -r \
    --arg expected "$EXPECTED_CANDIDATE" \
    '[.[] | select(.name == $expected)] | length' \
    <<< "$revisions")
  local -a replacements=()
  while IFS= read -r candidate; do
    replacements+=("$candidate")
  done < <(jq -r \
    --arg old "$OLD_REVISION" \
    --arg expected "$EXPECTED_CANDIDATE" \
    --arg latest "$latest_revision" \
    --argjson baseline "$BASELINE_NAMES" \
    '.[] | .name as $name | select($name != $old and (
      $name == $expected or $name == $latest or ($baseline | index($name)) == null or
      .properties.active == true or ((.properties.replicas | tonumber? // 0) > 0)
    )) | .name' \
    <<< "$revisions")
  for candidate in "${replacements[@]}"; do
    az containerapp revision deactivate \
      --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" \
      --revision "$candidate" --output none >/dev/null 2>&1 || true
  done
  for candidate in "${replacements[@]}"; do
    wait_for_stopped_candidate "$candidate" || rollback_ok=0
  done
  if [ "$rollback_ok" -ne 1 ]; then
    echo '::error::A replacement revision may still be running. Refusing to reactivate the old writer.' >&2
    exit "$status"
  fi
  if [ "$UPDATE_ATTEMPTED" -eq 1 ] && [ "$expected_seen" -eq 0 ]; then
    echo "::error::The expected revision $EXPECTED_CANDIDATE is not visible; the update may still create it. Leaving the old writer stopped for manual recovery." >&2
    exit "$status"
  fi
  if [ -n "$OLD_REVISION" ]; then
    current_port=$(az containerapp show \
      --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" \
      --query properties.configuration.ingress.targetPort --output tsv 2>/dev/null || true)
    if [ -z "$current_port" ]; then
      rollback_ok=0
    elif [ "$current_port" != "$OLD_TARGET_PORT" ]; then
      az containerapp ingress update \
        --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" \
        --target-port "$OLD_TARGET_PORT" --output none || rollback_ok=0
      current_port=$(az containerapp show \
        --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" \
        --query properties.configuration.ingress.targetPort --output tsv 2>/dev/null || true)
      [ "$current_port" = "$OLD_TARGET_PORT" ] || rollback_ok=0
    fi
    if [ "$rollback_ok" -eq 1 ]; then
      az containerapp revision activate \
        --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" \
        --revision "$OLD_REVISION" --output none || rollback_ok=0
    fi
    if [ "$rollback_ok" -eq 1 ]; then
      az containerapp ingress traffic set \
        --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" \
        --revision-weight "${OLD_REVISION}=100" --output none || rollback_ok=0
    fi
    if [ "$rollback_ok" -eq 1 ]; then
      echo "Restored previous revision $OLD_REVISION." >&2
    else
      echo '::error::Could not restore the previous revision. Manual recovery is required.' >&2
    fi
  else
    echo 'No previous active revision existed; the first deploy remains stopped.' >&2
  fi
  exit "$status"
}
trap 'on_exit $?' EXIT

APP_JSON=$(az containerapp show \
  --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" --output json)
OLD_TARGET_PORT=$(jq -r '.properties.configuration.ingress.targetPort // ""' <<< "$APP_JSON")
if ! [[ "$OLD_TARGET_PORT" =~ ^[0-9]+$ ]]; then
  echo '::error::Container App ingress has no numeric target port.' >&2
  exit 1
fi
REVISIONS_JSON=$(all_revisions_json)
BASELINE_NAMES=$(jq -c '[.[].name]' <<< "$REVISIONS_JSON")
ACTIVE_REVISIONS=()
while IFS= read -r revision; do
  ACTIVE_REVISIONS+=("$revision")
done < <(jq -r '.[] | select(.properties.active == true) | .name' <<< "$REVISIONS_JSON")
RUNNING_REVISIONS=()
while IFS= read -r revision; do
  RUNNING_REVISIONS+=("$revision")
done < <(jq -r '.[] | select((.properties.replicas | tonumber? // 0) > 0) | .name' <<< "$REVISIONS_JSON")
RUNNING_REPLICA_COUNT=$(jq '[.[].properties.replicas | tonumber? // 0] | add // 0' <<< "$REVISIONS_JSON")
if [ "${#ACTIVE_REVISIONS[@]}" -ne 1 ] || [ "$RUNNING_REPLICA_COUNT" -gt 1 ]; then
  echo '::error::Expected exactly one active revision and at most one running replica. Restore the previous revision manually before retrying a stopped deployment.' >&2
  exit 1
fi
OLD_REVISION="${ACTIVE_REVISIONS[0]}"
if [ "${#RUNNING_REVISIONS[@]}" -eq 1 ] && [ "${RUNNING_REVISIONS[0]}" != "$OLD_REVISION" ]; then
  echo '::error::A non-active revision still has a running replica. Wait for it to stop before deploying.' >&2
  exit 1
fi

CURRENT_MODE=$(jq -r '.properties.configuration.activeRevisionsMode // ""' <<< "$APP_JSON")
if [ "$CURRENT_MODE" != 'Single' ] && [ "$CURRENT_MODE" != 'Multiple' ]; then
  echo "::error::Unexpected ACA revision mode: $CURRENT_MODE" >&2
  exit 1
fi

pinned_to_old() {
  jq -e --arg old "$OLD_REVISION" '
    (.properties.configuration.ingress.traffic // []) as $routes |
    ($routes | length == 1) and
    ($routes[0].revisionName == $old) and
    ($routes[0].weight == 100) and
    (($routes[0].latestRevision // false) == false)
  ' <<< "$1" >/dev/null
}

ROLLOUT_STARTED=1
if [ "$CURRENT_MODE" != 'Multiple' ]; then
  az containerapp revision set-mode \
    --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" \
    --mode multiple --output none
fi
if [ -n "$OLD_REVISION" ]; then
  # A fixed traffic rule keeps the candidate off the public hostname until its
  # revision-specific URL has passed the smoke test.
  az containerapp ingress traffic set \
    --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" \
    --revision-weight "${OLD_REVISION}=100" --output none
  APP_JSON=$(az containerapp show \
    --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" --output json)
  if ! pinned_to_old "$APP_JSON"; then
    echo '::error::Ingress did not retain exactly one explicit old-revision traffic rule. Refusing to start a candidate.' >&2
    exit 1
  fi
  az containerapp revision deactivate \
    --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" \
    --revision "$OLD_REVISION" --output none
  wait_for_zero_replicas "$OLD_REVISION"
  APP_JSON=$(az containerapp show \
    --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" --output json)
  if ! pinned_to_old "$APP_JSON"; then
    echo '::error::Traffic was repointed when the old revision stopped. Refusing to create a candidate.' >&2
    exit 1
  fi
fi

REVISIONS_JSON=$(all_revisions_json)
if jq -e '[.[] | select((.properties.replicas | tonumber? // 0) > 0)] | length != 0' \
  <<< "$REVISIONS_JSON" >/dev/null; then
  echo '::error::A replica is still running. Refusing to start another SQLite writer.' >&2
  exit 1
fi
if [ "$OLD_TARGET_PORT" != '8080' ]; then
  echo "Changing ingress target port from $OLD_TARGET_PORT to 8080 after the old revision stopped."
  az containerapp ingress update \
    --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" \
    --target-port 8080 --output none
  CURRENT_TARGET_PORT=$(az containerapp show \
    --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" \
    --query properties.configuration.ingress.targetPort --output tsv)
  if [ "$CURRENT_TARGET_PORT" != '8080' ]; then
    echo '::error::Ingress target port did not change to 8080.' >&2
    exit 1
  fi
fi
APP_JSON=$(az containerapp show \
  --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" --output json)
if ! pinned_to_old "$APP_JSON"; then
  echo '::error::Traffic rule changed before candidate creation.' >&2
  exit 1
fi
REVISIONS_JSON=$(all_revisions_json)
if jq -e '[.[] | select(.properties.active == true or ((.properties.replicas | tonumber? // 0) > 0))] | length != 0' \
  <<< "$REVISIONS_JSON" >/dev/null; then
  echo '::error::A revision became active before candidate creation. Refusing a second SQLite writer.' >&2
  exit 1
fi
BASELINE_NAMES=$(jq -c '[.[].name]' <<< "$REVISIONS_JSON")

store_container_secret() {
  local name="$1" value="$2"
  # Azure CLI diagnostics can include command arguments. Keep credential
  # values out of workflow logs and use a generic error on failure.
  if ! az containerapp secret set \
    --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" \
    --secrets "$name=$value" --output none >/dev/null 2>&1; then
    echo "::error::Could not store Container App secret $name." >&2
    return 1
  fi
}

ENV_UPDATES=()
if [ -n "${LITESTREAM_REQUIRE_REPLICA:-}" ]; then
  ENV_UPDATES+=("LITESTREAM_REQUIRE_REPLICA=$LITESTREAM_REQUIRE_REPLICA")
fi
if [ "$GOOGLE_AUTH_UPDATE" -eq 1 ]; then
  # App-level secret changes do not create revisions. Do this only after the
  # old writer is stopped. Per-rollout names keep prior revision references
  # intact if this candidate needs a pre-cutover rollback.
  store_container_secret "google-client-secret-$DEPLOY_SUFFIX" "$GOOGLE_CLIENT_SECRET"
  ENV_UPDATES+=("GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID" "GOOGLE_CLIENT_SECRET=secretref:google-client-secret-$DEPLOY_SUFFIX")
fi
if [ "$TWILIO_VIDEO_UPDATE" -eq 1 ]; then
  store_container_secret "twilio-account-sid-$DEPLOY_SUFFIX" "$TWILIO_ACCOUNT_SID"
  store_container_secret "twilio-api-key-sid-$DEPLOY_SUFFIX" "$TWILIO_API_KEY_SID"
  store_container_secret "twilio-api-key-secret-$DEPLOY_SUFFIX" "$TWILIO_API_KEY_SECRET"
  ENV_UPDATES+=(
    "TWILIO_ACCOUNT_SID=secretref:twilio-account-sid-$DEPLOY_SUFFIX"
    "TWILIO_API_KEY_SID=secretref:twilio-api-key-sid-$DEPLOY_SUFFIX"
    "TWILIO_API_KEY_SECRET=secretref:twilio-api-key-secret-$DEPLOY_SUFFIX"
  )
fi
if [ -n "${TWILIO_AUTH_TOKEN:-}" ]; then
  store_container_secret "twilio-auth-token-$DEPLOY_SUFFIX" "$TWILIO_AUTH_TOKEN"
  ENV_UPDATES+=("TWILIO_AUTH_TOKEN=secretref:twilio-auth-token-$DEPLOY_SUFFIX")
fi
if [ "${TWILIO_VIDEO_MODE:-}" = 'live' ]; then
  ENV_UPDATES+=("REHEARSAL_MODE=off")
elif [ "${TWILIO_VIDEO_MODE:-}" = 'rehearsal' ]; then
  ENV_UPDATES+=("REHEARSAL_MODE=on")
fi
if [ -n "${OPENAI_API_KEY:-}" ]; then
  store_container_secret "openai-api-key-$DEPLOY_SUFFIX" "$OPENAI_API_KEY"
  ENV_UPDATES+=("OPENAI_API_KEY=secretref:openai-api-key-$DEPLOY_SUFFIX")
fi
if [ -n "${OPENAI_VISION_MODEL:-}" ]; then
  ENV_UPDATES+=("OPENAI_VISION_MODEL=$OPENAI_VISION_MODEL")
fi
if [ -n "${SEGMENT_WRITE_KEY:-}" ]; then
  store_container_secret "segment-write-key-$DEPLOY_SUFFIX" "$SEGMENT_WRITE_KEY"
  ENV_UPDATES+=("SEGMENT_WRITE_KEY=secretref:segment-write-key-$DEPLOY_SUFFIX")
fi
if [ "$SENDGRID_UPDATE" -eq 1 ]; then
  store_container_secret "sendgrid-api-key-$DEPLOY_SUFFIX" "$SENDGRID_API_KEY"
  ENV_UPDATES+=("SENDGRID_API_KEY=secretref:sendgrid-api-key-$DEPLOY_SUFFIX" "SENDGRID_FROM_EMAIL=$SENDGRID_FROM_EMAIL")
fi
if [ -n "${SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY:-}" ]; then
  store_container_secret "sendgrid-webhook-key-$DEPLOY_SUFFIX" "$SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY"
  ENV_UPDATES+=("SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY=secretref:sendgrid-webhook-key-$DEPLOY_SUFFIX")
fi
if [ -n "${SENDGRID_REGION:-}" ]; then
  ENV_UPDATES+=("SENDGRID_REGION=$SENDGRID_REGION")
fi
UPDATE_ARGS=()
if [ "${#ENV_UPDATES[@]}" -gt 0 ]; then
  UPDATE_ARGS=(--set-env-vars "${ENV_UPDATES[@]}")
fi
if [ "${GOOGLE_AUTH_DISABLE:-0}" = '1' ]; then
  UPDATE_ARGS+=(--remove-env-vars GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET)
fi
EXPECTED_CANDIDATE="${ACA_NAME}--${DEPLOY_SUFFIX}"
echo "Starting candidate from $IMAGE after the old writer stopped."
UPDATE_ATTEMPTED=1
az containerapp update \
  --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" \
  --image "$IMAGE" --revision-suffix "$DEPLOY_SUFFIX" \
  --min-replicas 1 --max-replicas 1 --termination-grace-period 60 \
  "${UPDATE_ARGS[@]}" --output none
APP_JSON=$(az containerapp show \
  --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" --output json)
if ! pinned_to_old "$APP_JSON"; then
  TRAFFIC_ADMITTED=1
  echo '::error::Candidate may have received public traffic during update. Automatic rollback is unsafe.' >&2
  exit 1
fi

REVISION_DETAILS=''
for attempt in $(seq 1 90); do
  APP_JSON=$(az containerapp show \
    --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" --output json)
  candidate=$(jq -r '.properties.latestRevisionName // ""' <<< "$APP_JSON")
  if [ -n "$candidate" ] && [ "$candidate" != "$OLD_REVISION" ]; then
    if [ "$candidate" != "$EXPECTED_CANDIDATE" ]; then
      if jq -e --arg candidate "$candidate" 'index($candidate) != null' \
        <<< "$BASELINE_NAMES" >/dev/null; then
        echo "Waiting for this rollout's revision; latest still points to prior revision $candidate ($attempt/90)..."
        sleep 5
        continue
      fi
      echo "::error::Unexpected latest revision $candidate; expected $EXPECTED_CANDIDATE. Refusing to smoke another deployment." >&2
      exit 1
    fi
    NEW_REVISION="$candidate"
    REVISION_DETAILS=$(revision_json "$NEW_REVISION" 2>/dev/null || true)
    if [ -n "$REVISION_DETAILS" ]; then
      image=$(jq -r '.properties.template.containers[0].image // ""' <<< "$REVISION_DETAILS")
      provisioning=$(jq -r '.properties.provisioningState // ""' <<< "$REVISION_DETAILS")
      health=$(jq -r '.properties.healthState // ""' <<< "$REVISION_DETAILS")
      running=$(jq -r '.properties.runningState // ""' <<< "$REVISION_DETAILS")
      active=$(jq -r '.properties.active | if . == null then "" else tostring end' <<< "$REVISION_DETAILS")
      replicas=$(jq -r '(.properties.replicas | tonumber? // 0)' <<< "$REVISION_DETAILS")
      latest_ready=$(jq -r '.properties.latestReadyRevisionName // ""' <<< "$APP_JSON")
      if [ "$image" = "$IMAGE" ] && [ "$provisioning" = 'Provisioned' ] &&
         [ "$health" = 'Healthy' ] && [ "$active" = 'true' ] &&
         [ "$replicas" -eq 1 ] && [ "$latest_ready" = "$NEW_REVISION" ]; then
        echo "Candidate $NEW_REVISION is healthy with one replica."
        break
      fi
      if [ "$provisioning" = 'Failed' ] || [ "$running" = 'Failed' ]; then
        echo "::error::Candidate failed (provisioning=$provisioning, running=$running)." >&2
        exit 1
      fi
      echo "Waiting for candidate $NEW_REVISION (provisioning=$provisioning, health=$health, replicas=$replicas, $attempt/90)..."
    fi
  fi
  if [ "$attempt" -eq 90 ]; then
    echo '::error::Candidate did not become healthy within 7.5 minutes.' >&2
    exit 1
  fi
  sleep 5
done

REVISIONS_JSON=$(all_revisions_json)
RUNNING_REVISIONS=()
while IFS= read -r revision; do
  RUNNING_REVISIONS+=("$revision")
done < <(jq -r '.[] | select((.properties.replicas | tonumber? // 0) > 0) | .name' <<< "$REVISIONS_JSON")
ACTIVE_REVISIONS=()
while IFS= read -r revision; do
  ACTIVE_REVISIONS+=("$revision")
done < <(jq -r '.[] | select(.properties.active == true) | .name' <<< "$REVISIONS_JSON")
RUNNING_REPLICA_COUNT=$(jq '[.[].properties.replicas | tonumber? // 0] | add // 0' <<< "$REVISIONS_JSON")
if [ "${#ACTIVE_REVISIONS[@]}" -ne 1 ] || [ "${ACTIVE_REVISIONS[0]}" != "$NEW_REVISION" ] ||
   [ "${#RUNNING_REVISIONS[@]}" -ne 1 ] || [ "${RUNNING_REVISIONS[0]}" != "$NEW_REVISION" ] ||
   [ "$RUNNING_REPLICA_COUNT" -ne 1 ]; then
  echo '::error::Candidate is not the only active single-replica revision. Refusing public cutover.' >&2
  exit 1
fi
APP_JSON=$(az containerapp show \
  --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" --output json)
if ! pinned_to_old "$APP_JSON"; then
  TRAFFIC_ADMITTED=1
  echo '::error::Candidate may have received public traffic before smoke. Automatic rollback is unsafe.' >&2
  exit 1
fi

APP_FQDN=$(jq -r '.properties.configuration.ingress.fqdn // ""' <<< "$APP_JSON")
REVISION_FQDN=$(jq -r '.properties.fqdn // ""' <<< "$REVISION_DETAILS")
if [ -z "$REVISION_FQDN" ] && [ -n "$APP_FQDN" ]; then
  REVISION_FQDN="${NEW_REVISION}.${APP_FQDN#*.}"
fi
if [ -z "$APP_FQDN" ] || [ -z "$REVISION_FQDN" ]; then
  echo '::error::Could not resolve the public and revision-specific hostnames.' >&2
  exit 1
fi

smoke() {
  local hostname="$1" health_file health_code arena_code
  health_file=$(mktemp)
  for attempt in $(seq 1 30); do
    health_code=$(curl --silent --show-error --connect-timeout 5 --max-time 20 \
      --output "$health_file" --write-out '%{http_code}' \
      "https://${hostname}/health" || true)
    arena_code=$(curl --silent --show-error --location --max-redirs 2 \
      --connect-timeout 5 --max-time 20 \
      --output /dev/null --write-out '%{http_code}' \
      "https://${hostname}/" || true)
    if [ "$health_code" = '200' ] && [ "$arena_code" = '200' ] &&
       jq -e '.ok == true and (.events | type == "number")' "$health_file" >/dev/null 2>&1; then
      rm -f "$health_file"
      echo "Health and arena smoke passed at $hostname."
      return 0
    fi
    echo "Smoke at $hostname: /health=$health_code, /arena=$arena_code ($attempt/30)."
    [ "$attempt" -eq 30 ] || sleep 5
  done
  rm -f "$health_file"
  return 1
}

smoke "$REVISION_FQDN"

APP_JSON=$(az containerapp show \
  --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" --output json)
if ! pinned_to_old "$APP_JSON"; then
  TRAFFIC_ADMITTED=1
  echo '::error::Candidate may have received public traffic before cutover. Automatic rollback is unsafe.' >&2
  exit 1
fi

# Do not automatically restore the old revision after this point: the public
# candidate may accept leads, votes, and game writes immediately.
TRAFFIC_ADMITTED=1
az containerapp ingress traffic set \
  --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" \
  --revision-weight "${NEW_REVISION}=100" --output none
smoke "$APP_FQDN"
az containerapp revision set-mode \
  --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" \
  --mode single --output none

FINAL_OK=0
for attempt in $(seq 1 12); do
  FINAL_JSON=$(az containerapp show \
    --name "$ACA_NAME" --resource-group "$ACA_RESOURCE_GROUP" --output json)
  FINAL_MODE=$(jq -r '.properties.configuration.activeRevisionsMode // ""' <<< "$FINAL_JSON")
  FINAL_READY=$(jq -r '.properties.latestReadyRevisionName // ""' <<< "$FINAL_JSON")
  FINAL_LATEST=$(jq -r '.properties.latestRevisionName // ""' <<< "$FINAL_JSON")
  FINAL_PORT=$(jq -r '.properties.configuration.ingress.targetPort // ""' <<< "$FINAL_JSON")
  if [ "$FINAL_MODE" = 'Single' ] && [ "$FINAL_READY" = "$NEW_REVISION" ] &&
     [ "$FINAL_LATEST" = "$NEW_REVISION" ] && [ "$FINAL_PORT" = '8080' ]; then
    FINAL_OK=1
    break
  fi
  sleep 5
done
if [ "$FINAL_OK" -ne 1 ]; then
  echo '::error::Final revision mode/readiness did not match the deployed image.' >&2
  exit 1
fi
REVISIONS_JSON=$(all_revisions_json)
ACTIVE_REVISIONS=()
while IFS= read -r revision; do
  ACTIVE_REVISIONS+=("$revision")
done < <(jq -r '.[] | select(.properties.active == true) | .name' <<< "$REVISIONS_JSON")
RUNNING_REPLICA_COUNT=$(jq '[.[].properties.replicas | tonumber? // 0] | add // 0' <<< "$REVISIONS_JSON")
if [ "${#ACTIVE_REVISIONS[@]}" -ne 1 ] || [ "${ACTIVE_REVISIONS[0]}" != "$NEW_REVISION" ] ||
   [ "$RUNNING_REPLICA_COUNT" -ne 1 ]; then
  echo '::error::Post-cutover revision count is not one active candidate with one replica.' >&2
  exit 1
fi

ROLLOUT_STARTED=0
echo "Deployed $IMAGE to https://$APP_FQDN"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf 'Deployed image %s to [Live Scavenger Hunt](https://%s).\n' "$IMAGE" "$APP_FQDN" >> "$GITHUB_STEP_SUMMARY"
fi
