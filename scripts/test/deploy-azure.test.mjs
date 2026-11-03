import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

const deployScript = resolve(import.meta.dirname, '../deploy-azure.sh');

test('invalid Google OAuth rollout settings fail before the live revision is touched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lsh-deploy-config-'));
  const azPath = join(dir, 'az');
  const azLog = join(dir, 'az-calls');
  writeFileSync(azPath, '#!/bin/sh\nprintf called >> "$FAKE_AZ_LOG"\nexit 82\n');
  chmodSync(azPath, 0o755);
  try {
    for (const { settings, error } of [
      { settings: { GOOGLE_CLIENT_ID: '123-test.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: '' },
        error: /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be set/ },
      { settings: { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: randomBytes(20).toString('hex') },
        error: /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be set/ },
      { settings: { GOOGLE_AUTH_DISABLE: 'yes' }, error: /GOOGLE_AUTH_DISABLE must be 0 or 1/ },
    ]) {
      const run = spawnSync('bash', [deployScript, 'example.azurecr.io/live-scavenger-hunt:test'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          ACA_NAME: 'live-scavenger-hunt',
          ACA_RESOURCE_GROUP: 'rg-live-scavenger-hunt',
          FAKE_AZ_LOG: azLog,
          ...settings,
        },
      });
      assert.equal(run.status, 1);
      assert.match(run.stderr, error);
      if (settings.GOOGLE_CLIENT_SECRET)
        assert.equal(`${run.stdout}${run.stderr}`.includes(settings.GOOGLE_CLIENT_SECRET), false);
      assert.equal(existsSync(azLog), false, 'validation must complete before an Azure call');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid Twilio rollout settings fail before the live revision is touched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lsh-deploy-twilio-config-'));
  const azPath = join(dir, 'az');
  const azLog = join(dir, 'az-calls');
  writeFileSync(azPath, '#!/bin/sh\nprintf called >> "$FAKE_AZ_LOG"\nexit 82\n');
  chmodSync(azPath, 0o755);
  const accountSid = `AC${'1'.repeat(32)}`;
  const keySid = `SK${'2'.repeat(32)}`;
  const keySecret = randomBytes(24).toString('hex');
  const authToken = randomBytes(24).toString('hex');
  try {
    for (const { settings, error } of [
      { settings: { TWILIO_VIDEO_MODE: 'yes' }, error: /TWILIO_VIDEO_MODE must be live or rehearsal/ },
      { settings: { TWILIO_VIDEO_MODE: 'live' }, error: /requires TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, and TWILIO_AUTH_TOKEN/ },
      { settings: { TWILIO_VIDEO_MODE: 'live', TWILIO_ACCOUNT_SID: accountSid, TWILIO_API_KEY_SID: keySid, TWILIO_API_KEY_SECRET: keySecret },
        error: /requires TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, and TWILIO_AUTH_TOKEN/ },
      { settings: { TWILIO_VIDEO_MODE: 'live', TWILIO_ACCOUNT_SID: 'ACwrong', TWILIO_API_KEY_SID: keySid, TWILIO_API_KEY_SECRET: keySecret, TWILIO_AUTH_TOKEN: authToken },
        error: /TWILIO_ACCOUNT_SID must be an Account SID/ },
      { settings: { TWILIO_VIDEO_MODE: 'live', TWILIO_ACCOUNT_SID: accountSid, TWILIO_API_KEY_SID: 'SKwrong', TWILIO_API_KEY_SECRET: keySecret, TWILIO_AUTH_TOKEN: authToken },
        error: /TWILIO_API_KEY_SID must be an API Key SID/ },
    ]) {
      const run = spawnSync('bash', [deployScript, 'example.azurecr.io/live-scavenger-hunt:test'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          ACA_NAME: 'live-scavenger-hunt',
          ACA_RESOURCE_GROUP: 'rg-live-scavenger-hunt',
          FAKE_AZ_LOG: azLog,
          TWILIO_VIDEO_MODE: '',
          TWILIO_ACCOUNT_SID: '',
          TWILIO_API_KEY_SID: '',
          TWILIO_API_KEY_SECRET: '',
          TWILIO_AUTH_TOKEN: '',
          ...settings,
        },
      });
      assert.equal(run.status, 1);
      assert.match(run.stderr, error);
      assert.equal(`${run.stdout}${run.stderr}`.includes(keySecret), false);
      assert.equal(`${run.stdout}${run.stderr}`.includes(authToken), false);
      assert.equal(existsSync(azLog), false, 'validation must complete before an Azure call');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid optional integration settings fail before the live revision is touched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lsh-deploy-optional-config-'));
  const azPath = join(dir, 'az');
  const azLog = join(dir, 'az-calls');
  writeFileSync(azPath, '#!/bin/sh\nprintf called >> "$FAKE_AZ_LOG"\nexit 82\n');
  chmodSync(azPath, 0o755);
  const key = randomBytes(24).toString('hex');
  try {
    for (const { settings, error } of [
      { settings: { OPENAI_API_KEY: `${key} bad` }, error: /OPENAI_API_KEY cannot contain whitespace/ },
      { settings: { OPENAI_VISION_MODEL: 'model with spaces' }, error: /OPENAI_VISION_MODEL cannot contain whitespace/ },
      { settings: { SEGMENT_WRITE_KEY: `${key}\nbad` }, error: /SEGMENT_WRITE_KEY cannot contain whitespace/ },
      { settings: { SENDGRID_API_KEY: key }, error: /SENDGRID_API_KEY and SENDGRID_FROM_EMAIL must both be set/ },
      { settings: { SENDGRID_FROM_EMAIL: 'booth@example.com' }, error: /SENDGRID_API_KEY and SENDGRID_FROM_EMAIL must both be set/ },
      { settings: { SENDGRID_API_KEY: key, SENDGRID_FROM_EMAIL: 'not-an-email' }, error: /SENDGRID_FROM_EMAIL must be a valid sender email address/ },
      { settings: { SENDGRID_API_KEY: key, SENDGRID_FROM_EMAIL: 'booth@example.com', SENDGRID_REGION: 'asia' },
        error: /SENDGRID_REGION must be eu, global, or us/ },
      { settings: { GITHUB_RUN_ID: 'bad-run-id' }, error: /Deployment run identifier must contain only digits/ },
    ]) {
      const run = spawnSync('bash', [deployScript, 'example.azurecr.io/live-scavenger-hunt:test'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          ACA_NAME: 'live-scavenger-hunt',
          ACA_RESOURCE_GROUP: 'rg-live-scavenger-hunt',
          FAKE_AZ_LOG: azLog,
          OPENAI_API_KEY: '', OPENAI_VISION_MODEL: '',
          SEGMENT_WRITE_KEY: '',
          SENDGRID_API_KEY: '', SENDGRID_FROM_EMAIL: '', SENDGRID_REGION: '',
          ...settings,
        },
      });
      assert.equal(run.status, 1);
      assert.match(run.stderr, error);
      assert.equal(`${run.stdout}${run.stderr}`.includes(key), false);
      assert.equal(existsSync(azLog), false, 'validation must complete before an Azure call');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runStoppedWriterUpdate(settings = {}, behavior = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lsh-deploy-disable-'));
  const azPath = join(dir, 'az');
  const azLog = join(dir, 'az-calls');
  const stopped = join(dir, 'old-stopped');
  const secretSaved = join(dir, 'secret-saved');
  const secretAttempt = join(dir, 'secret-attempt');
  const activationRejected = join(dir, 'activation-rejected');
  const settledAfterReject = join(dir, 'settled-after-reject');
  const restored = join(dir, 'restored');
  const trafficRestored = join(dir, 'traffic-restored');
  const activationProbed = join(dir, 'activation-probed');
  const activationReady = join(dir, 'activation-ready');
  const previous = 'live-scavenger-hunt--old';
  writeFileSync(azPath, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_AZ_LOG"
if [ "$1 $2" = 'containerapp show' ]; then
  query=''
  previous_arg=''
  for arg in "$@"; do
    if [ "$previous_arg" = '--query' ]; then query="$arg"; break; fi
    previous_arg="$arg"
  done
  if [ "$query" = 'properties.latestRevisionName' ]; then
    printf '%s\\n' "$FAKE_OLD_REVISION"; exit 0
  fi
  if [ "$query" = 'properties.configuration.ingress.targetPort' ]; then
    printf '8080\\n'; exit 0
  fi
  if [ -f "$FAKE_ACTIVATION_REJECTED" ] && [ ! -f "$FAKE_SETTLED_AFTER_REJECT" ]; then
    touch "$FAKE_SETTLED_AFTER_REJECT"
    printf '%s\\n' "$FAKE_APP_IN_PROGRESS_JSON"; exit 0
  fi
  printf '%s\\n' "$FAKE_APP_JSON"; exit 0
fi
if [ "$1 $2 $3" = 'containerapp revision list' ]; then
  if [ -f "$FAKE_RESTORED" ] && [ "$FAKE_ACTIVATION_MODE" != 'failed' ] &&
     { [ "$FAKE_ACTIVATION_MODE" != 'delayed' ] || [ -f "$FAKE_ACTIVATION_READY" ]; }; then
    printf '%s\\n' "$FAKE_ACTIVE_REVISIONS"
  elif [ -f "$FAKE_STOPPED" ]; then printf '%s\\n' "$FAKE_INACTIVE_REVISIONS"
  else printf '%s\\n' "$FAKE_ACTIVE_REVISIONS"; fi
  exit 0
fi
if [ "$1 $2 $3" = 'containerapp revision show' ]; then
  if [ -f "$FAKE_RESTORED" ]; then
    if [ "$FAKE_ACTIVATION_MODE" = 'failed' ] ||
       { [ "$FAKE_ACTIVATION_MODE" = 'failed-after-traffic' ] && [ -f "$FAKE_TRAFFIC_RESTORED" ]; }; then
      printf '%s\\n' "$FAKE_FAILED_REVISION"; exit 0
    fi
    if [ "$FAKE_ACTIVATION_MODE" = 'delayed' ]; then
      if [ ! -f "$FAKE_ACTIVATION_PROBED" ]; then
        touch "$FAKE_ACTIVATION_PROBED"
        printf '%s\\n' "$FAKE_STOPPED_REVISION"; exit 0
      fi
      if [ ! -f "$FAKE_ACTIVATION_READY" ]; then
        touch "$FAKE_ACTIVATION_READY"
        printf '%s\\n' "$FAKE_STOPPED_REVISION"; exit 0
      fi
    fi
    printf '%s\\n' "$FAKE_RUNNING_REVISION"; exit 0
  fi
  printf '%s\\n' "$FAKE_STOPPED_REVISION"; exit 0
fi
if [ "$1 $2 $3" = 'containerapp revision deactivate' ]; then
  touch "$FAKE_STOPPED"; exit 0
fi
if [ "$1 $2 $3" = 'containerapp revision activate' ]; then
  if [ "$FAKE_ROLLBACK_MODE" = 'reject-once' ] && [ ! -f "$FAKE_ACTIVATION_REJECTED" ]; then
    touch "$FAKE_ACTIVATION_REJECTED"
    printf 'ERROR: (ContainerAppOperationInProgress) Busy\\n' >&2
    exit 75
  fi
  touch "$FAKE_RESTORED"; exit 0
fi
if [ "$1 $2 $3" = 'containerapp ingress traffic' ]; then
  if [ -f "$FAKE_RESTORED" ] && [ "$FAKE_ACTIVATION_MODE" = 'delayed' ] &&
     [ ! -f "$FAKE_ACTIVATION_READY" ]; then
    printf 'ERROR: (RevisionNotReady) The previous revision is still starting\\n' >&2
    exit 75
  fi
  if [ -f "$FAKE_RESTORED" ]; then touch "$FAKE_TRAFFIC_RESTORED"; fi
  exit 0
fi
if [ "$1 $2 $3" = 'containerapp secret list' ]; then
  if [ -f "$FAKE_SECRET_SAVED" ]; then printf '%s\\n' "$FAKE_SECRET_NAMES_JSON"
  else printf '[]\\n'; fi
  exit 0
fi
if [ "$1 $2 $3" = 'containerapp secret set' ]; then
  if [ "$FAKE_SECRET_SET_MODE" = 'reject-once' ] && [ ! -f "$FAKE_SECRET_ATTEMPT" ]; then
    touch "$FAKE_SECRET_ATTEMPT"
    printf 'ERROR: (ContainerAppOperationInProgress) Busy\\n' >&2
    exit 75
  fi
  if [ "$FAKE_SECRET_SET_MODE" = 'invalid' ]; then
    printf 'ERROR: (InvalidParameter) Rejected %s\\n' "$FAKE_SECRET_VALUE_FOR_ERROR" >&2
    exit 75
  fi
  touch "$FAKE_SECRET_SAVED"
  if [ "$FAKE_SECRET_SET_MODE" = 'false-negative' ]; then
    printf 'ERROR: (ContainerAppOperationInProgress) Accepted but still provisioning %s\\n' "$FAKE_SECRET_VALUE_FOR_ERROR" >&2
    exit 75
  fi
  exit 0
fi
if [ "$1 $2" = 'containerapp update' ]; then exit 71; fi
exit 83
`);
  writeFileSync(join(dir, 'sleep'), '#!/bin/sh\nexit 0\n');
  chmodSync(azPath, 0o755);
  chmodSync(join(dir, 'sleep'), 0o755);
  const app = { properties: { provisioningState: 'Succeeded', configuration: { activeRevisionsMode: 'Multiple', ingress: {
    targetPort: 8080, traffic: [{ revisionName: previous, weight: 100, latestRevision: false }],
  } }, latestRevisionName: previous } };
  const appInProgress = { properties: { ...app.properties, provisioningState: 'InProgress' } };
  const suffix = `r${settings.GITHUB_RUN_ID || '1234567890'}a${settings.GITHUB_RUN_ATTEMPT || '1'}`;
  const secretNames = [];
  if (settings.GOOGLE_AUTH_DISABLE !== '1' && settings.GOOGLE_CLIENT_ID && settings.GOOGLE_CLIENT_SECRET)
    secretNames.push(`google-client-secret-${suffix}`);
  if (settings.TWILIO_VIDEO_MODE === 'live')
    secretNames.push(`twilio-account-sid-${suffix}`, `twilio-api-key-sid-${suffix}`, `twilio-api-key-secret-${suffix}`);
  if (settings.TWILIO_AUTH_TOKEN) secretNames.push(`twilio-auth-token-${suffix}`);
  if (settings.OPENAI_API_KEY) secretNames.push(`openai-api-key-${suffix}`);
  if (settings.SEGMENT_WRITE_KEY) secretNames.push(`segment-write-key-${suffix}`);
  if (settings.SENDGRID_API_KEY && settings.SENDGRID_FROM_EMAIL) secretNames.push(`sendgrid-api-key-${suffix}`);
  if (settings.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY) secretNames.push(`sendgrid-webhook-key-${suffix}`);
  const revision = active => [{ name: previous, properties: {
    active, replicas: active ? 1 : 0,
    provisioningState: active ? 'Provisioned' : 'Deprovisioned',
    runningState: active ? 'Running' : 'Stopped',
    healthState: active ? 'Healthy' : 'Unknown',
  } }];
  try {
    const run = spawnSync('bash', [deployScript, 'example.azurecr.io/live-scavenger-hunt:test'], {
      encoding: 'utf8', timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        ACA_NAME: 'live-scavenger-hunt',
        ACA_RESOURCE_GROUP: 'rg-live-scavenger-hunt',
        GITHUB_RUN_ID: '1234567890',
        GITHUB_RUN_ATTEMPT: '1',
        LITESTREAM_REQUIRE_REPLICA: '1',
        GOOGLE_AUTH_DISABLE: '',
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
        TWILIO_VIDEO_MODE: '',
        TWILIO_ACCOUNT_SID: '',
        TWILIO_API_KEY_SID: '',
        TWILIO_API_KEY_SECRET: '',
        TWILIO_AUTH_TOKEN: '',
        OPENAI_API_KEY: '',
        OPENAI_VISION_MODEL: '',
        SEGMENT_WRITE_KEY: '',
        SENDGRID_API_KEY: '',
        SENDGRID_FROM_EMAIL: '',
        SENDGRID_REGION: '',
        ...settings,
        FAKE_AZ_LOG: azLog,
        FAKE_STOPPED: stopped,
        FAKE_SECRET_SAVED: secretSaved,
        FAKE_SECRET_ATTEMPT: secretAttempt,
        FAKE_SECRET_SET_MODE: behavior.secretSetMode || '',
        FAKE_SECRET_NAMES_JSON: JSON.stringify(secretNames),
        FAKE_SECRET_VALUE_FOR_ERROR: behavior.secretValueForError || '',
        FAKE_ROLLBACK_MODE: behavior.rollbackMode || '',
        FAKE_ACTIVATION_MODE: behavior.activationMode || '',
        FAKE_ACTIVATION_REJECTED: activationRejected,
        FAKE_SETTLED_AFTER_REJECT: settledAfterReject,
        FAKE_RESTORED: restored,
        FAKE_TRAFFIC_RESTORED: trafficRestored,
        FAKE_ACTIVATION_PROBED: activationProbed,
        FAKE_ACTIVATION_READY: activationReady,
        FAKE_OLD_REVISION: previous,
        FAKE_APP_JSON: JSON.stringify(app),
        FAKE_APP_IN_PROGRESS_JSON: JSON.stringify(appInProgress),
        FAKE_ACTIVE_REVISIONS: JSON.stringify(revision(true)),
        FAKE_INACTIVE_REVISIONS: JSON.stringify(revision(false)),
        FAKE_RUNNING_REVISION: JSON.stringify({ properties: revision(true)[0].properties }),
        FAKE_FAILED_REVISION: JSON.stringify({ properties: {
          active: false, replicas: 0, provisioningState: 'Failed', runningState: 'Failed', healthState: 'Unhealthy',
        } }),
        FAKE_STOPPED_REVISION: JSON.stringify({ properties: {
          active: false, replicas: 0, provisioningState: 'Deprovisioned', runningState: 'Stopped',
        } }),
      },
    });
    assert.equal(run.status, behavior.expectedStatus ?? 71, run.stderr);
    assert.equal(existsSync(stopped), true, 'the old revision must stop before update');
    const calls = readFileSync(azLog, 'utf8').split('\n');
    const update = calls.find(call => call.startsWith('containerapp update '));
    if (behavior.expectUpdate === false) assert.equal(update, undefined);
    else assert.ok(update, 'candidate update must be attempted');
    if (update) assert.match(update, /(?:^| )--output none(?: |$)/,
      'candidate updates must keep Azure configuration out of workflow output');
    for (const name of ['GOOGLE_CLIENT_SECRET', 'TWILIO_API_KEY_SECRET', 'TWILIO_AUTH_TOKEN',
      'OPENAI_API_KEY', 'SEGMENT_WRITE_KEY', 'SENDGRID_API_KEY',
      'SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY']) {
      if (settings[name]) assert.equal(`${run.stdout}${run.stderr}`.includes(settings[name]), false);
    }
    if (behavior.secretValueForError)
      assert.equal(`${run.stdout}${run.stderr}`.includes(behavior.secretValueForError), false);
    return { calls, update, stderr: run.stderr, restored: existsSync(restored) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('explicit Google disable removes OAuth env during the stopped-writer update', () => {
  const { calls, update } = runStoppedWriterUpdate({
    GOOGLE_AUTH_DISABLE: '1',
    GOOGLE_CLIENT_ID: '123-test.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: randomBytes(20).toString('hex'),
  });
  assert.match(update, /--set-env-vars LITESTREAM_REQUIRE_REPLICA=1/);
  assert.match(update, /--remove-env-vars GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET/);
  assert.equal(calls.some(call => call.startsWith('containerapp secret set ')), false);
});

test('Google credentials are attached only after stopping the prior writer', () => {
  const clientId = '123-test.apps.googleusercontent.com';
  const secret = randomBytes(20).toString('hex');
  const { calls, update } = runStoppedWriterUpdate({
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: secret,
  });
  const stoppedAt = calls.findIndex(call => call.startsWith('containerapp revision deactivate '));
  const secretAt = calls.findIndex(call => call.startsWith('containerapp secret set '));
  const updateAt = calls.findIndex(call => call.startsWith('containerapp update '));
  assert.ok(stoppedAt >= 0 && stoppedAt < secretAt && secretAt < updateAt);
  assert.match(calls[secretAt], /--secrets google-client-secret-r1234567890a1=/);
  assert.equal(update.includes(`GOOGLE_CLIENT_ID=${clientId}`), true);
  assert.match(update, /GOOGLE_CLIENT_SECRET=secretref:google-client-secret-r1234567890a1/);
  assert.equal(update.includes(secret), false, 'the plaintext secret must never be a revision environment value');
});

test('unset Twilio mode and secrets preserve the candidate configuration', () => {
  const { calls, update } = runStoppedWriterUpdate();
  assert.equal(update.includes('REHEARSAL_MODE='), false);
  assert.equal(update.includes('TWILIO_'), false);
  for (const name of ['OPENAI_', 'SEGMENT_', 'SENDGRID_'])
    assert.equal(update.includes(name), false);
  assert.equal(calls.some(call => call.startsWith('containerapp secret set ')), false);
});

test('an image-only rollout works with no environment update on Bash 3.2', () => {
  const { calls, update } = runStoppedWriterUpdate({ LITESTREAM_REQUIRE_REPLICA: '' });
  assert.ok(update, 'the candidate update must still run');
  assert.equal(update.includes('--set-env-vars'), false);
  assert.equal(update.includes('--remove-env-vars'), false);
  assert.match(update, /--output none$/);
  assert.equal(calls.some(call => call.startsWith('containerapp secret set ')), false);
});

test('explicit Twilio rehearsal mode is applied in the stopped-writer update', () => {
  const { calls, update } = runStoppedWriterUpdate({ TWILIO_VIDEO_MODE: 'rehearsal' });
  assert.match(update, /REHEARSAL_MODE=on/);
  assert.equal(calls.some(call => call.startsWith('containerapp secret set ')), false);
});

test('live Twilio credentials become secret references only after the old writer stops', () => {
  const accountSid = `AC${'1'.repeat(32)}`;
  const keySid = `SK${'2'.repeat(32)}`;
  const keySecret = randomBytes(24).toString('hex');
  const authToken = randomBytes(24).toString('hex');
  const { calls, update } = runStoppedWriterUpdate({
    TWILIO_VIDEO_MODE: 'live',
    TWILIO_ACCOUNT_SID: accountSid,
    TWILIO_API_KEY_SID: keySid,
    TWILIO_API_KEY_SECRET: keySecret,
    TWILIO_AUTH_TOKEN: authToken,
  });
  const stoppedAt = calls.findIndex(call => call.startsWith('containerapp revision deactivate '));
  const secretCalls = calls.map((call, index) => ({ call, index }))
    .filter(({ call }) => call.startsWith('containerapp secret set '));
  const updateAt = calls.findIndex(call => call.startsWith('containerapp update '));
  assert.equal(secretCalls.length, 1, 'all credentials use one Azure secret update');
  assert.ok(secretCalls.every(({ index }) => stoppedAt < index && index < updateAt));
  for (const [name, secretName] of [
    ['TWILIO_ACCOUNT_SID', 'twilio-account-sid'],
    ['TWILIO_API_KEY_SID', 'twilio-api-key-sid'],
    ['TWILIO_API_KEY_SECRET', 'twilio-api-key-secret'],
    ['TWILIO_AUTH_TOKEN', 'twilio-auth-token'],
  ]) {
    assert.equal(secretCalls[0].call.includes(`${secretName}-r1234567890a1=`), true);
    assert.equal(update.includes(`${name}=secretref:${secretName}-r1234567890a1`), true);
  }
  assert.match(update, /REHEARSAL_MODE=off/);
  for (const value of [accountSid, keySid, keySecret, authToken])
    assert.equal(update.includes(value), false, 'credentials must never be plain revision environment values');
});

test('Auth Token can be deployed for signed messaging without changing REHEARSAL_MODE', () => {
  const authToken = randomBytes(24).toString('hex');
  const { calls, update } = runStoppedWriterUpdate({ TWILIO_AUTH_TOKEN: authToken });
  assert.equal(calls.filter(call => call.startsWith('containerapp secret set ')).length, 1);
  assert.match(update, /TWILIO_AUTH_TOKEN=secretref:twilio-auth-token-r1234567890a1/);
  assert.equal(update.includes('REHEARSAL_MODE='), false);
  assert.equal(update.includes(authToken), false);
});

test('optional integration keys are attached after the old writer stops without exposing values', () => {
  const openaiKey = randomBytes(24).toString('hex');
  const segmentKey = randomBytes(24).toString('hex');
  const sendgridKey = randomBytes(24).toString('hex');
  const { calls, update } = runStoppedWriterUpdate({
    OPENAI_API_KEY: openaiKey,
    OPENAI_VISION_MODEL: 'gpt-6-luna',
    SEGMENT_WRITE_KEY: segmentKey,
    SENDGRID_API_KEY: sendgridKey,
    SENDGRID_FROM_EMAIL: 'booth@example.com',
    SENDGRID_REGION: 'eu',
  });
  const stoppedAt = calls.findIndex(call => call.startsWith('containerapp revision deactivate '));
  const secretCalls = calls.map((call, index) => ({ call, index }))
    .filter(({ call }) => call.startsWith('containerapp secret set '));
  const updateAt = calls.findIndex(call => call.startsWith('containerapp update '));
  assert.equal(secretCalls.length, 1, 'optional credentials are batched');
  assert.ok(secretCalls.every(({ index }) => stoppedAt < index && index < updateAt));
  for (const name of ['openai-api-key', 'segment-write-key', 'sendgrid-api-key'])
    assert.equal(secretCalls[0].call.includes(`${name}-r1234567890a1=`), true);
  assert.match(update, /OPENAI_API_KEY=secretref:openai-api-key-r1234567890a1/);
  assert.match(update, /OPENAI_VISION_MODEL=gpt-6-luna/);
  assert.match(update, /SEGMENT_WRITE_KEY=secretref:segment-write-key-r1234567890a1/);
  assert.match(update, /SENDGRID_API_KEY=secretref:sendgrid-api-key-r1234567890a1/);
  assert.match(update, /SENDGRID_FROM_EMAIL=booth@example.com/);
  assert.match(update, /SENDGRID_REGION=eu/);
  assert.equal(update.includes('SEGMENT_IDENTIFY_LEADS='), false, 'deployment does not configure retired Identify');
  for (const value of [openaiKey, segmentKey, sendgridKey])
    assert.equal(update.includes(value), false, 'API keys must never be plain revision environment values');
});

test('each rollout gets distinct secret names so rollback keeps the old references', () => {
  const settings = {
    GOOGLE_CLIENT_ID: '123-test.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: randomBytes(20).toString('hex'),
    TWILIO_VIDEO_MODE: 'live',
    TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
    TWILIO_API_KEY_SID: `SK${'2'.repeat(32)}`,
    TWILIO_API_KEY_SECRET: randomBytes(24).toString('hex'),
    TWILIO_AUTH_TOKEN: randomBytes(24).toString('hex'),
    OPENAI_API_KEY: randomBytes(24).toString('hex'),
    SEGMENT_WRITE_KEY: randomBytes(24).toString('hex'),
    SENDGRID_API_KEY: randomBytes(24).toString('hex'),
    SENDGRID_FROM_EMAIL: 'booth@example.com',
    SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: randomBytes(24).toString('hex'),
    GITHUB_RUN_ID: '872000001',
  };
  const first = runStoppedWriterUpdate({ ...settings, GITHUB_RUN_ATTEMPT: '1' });
  const second = runStoppedWriterUpdate({ ...settings, GITHUB_RUN_ATTEMPT: '2' });
  for (const name of [
    'google-client-secret', 'twilio-account-sid', 'twilio-api-key-sid',
    'twilio-api-key-secret', 'twilio-auth-token', 'openai-api-key',
    'segment-write-key', 'sendgrid-api-key', 'sendgrid-webhook-key',
  ]) {
    assert.equal(first.calls.some(call => call.includes(`${name}-r872000001a1=`)), true);
    assert.equal(second.calls.some(call => call.includes(`${name}-r872000001a2=`)), true);
    assert.equal(first.update.includes(`secretref:${name}-r872000001a1`), true);
    assert.equal(second.update.includes(`secretref:${name}-r872000001a2`), true);
    assert.equal(second.update.includes(`secretref:${name}-r872000001a1`), false);
  }
  assert.match(first.update, /--revision-suffix r872000001a1/);
  assert.match(second.update, /--revision-suffix r872000001a2/);
});

test('SendGrid region and OpenAI model changes use the stopped-writer update', () => {
  const { calls, update } = runStoppedWriterUpdate({
    SENDGRID_REGION: 'global',
    OPENAI_VISION_MODEL: 'gpt-6-luna',
  });
  assert.match(update, /SENDGRID_REGION=global/);
  assert.match(update, /OPENAI_VISION_MODEL=gpt-6-luna/);
  assert.equal(calls.some(call => call.startsWith('containerapp secret set ')), false);
});

test('a delayed Azure success is accepted only after every rollout secret name is visible', () => {
  const key = randomBytes(24).toString('hex');
  const echoedValue = randomBytes(24).toString('hex');
  const { calls, update, stderr } = runStoppedWriterUpdate(
    { OPENAI_API_KEY: key },
    { secretSetMode: 'false-negative', secretValueForError: echoedValue },
  );
  assert.equal(calls.filter(call => call.startsWith('containerapp secret set ')).length, 1);
  const listAt = calls.findIndex(call => call.startsWith('containerapp secret list '));
  const updateAt = calls.findIndex(call => call.startsWith('containerapp update '));
  assert.ok(listAt >= 0 && listAt < updateAt, 'names must be verified before a candidate starts');
  assert.match(update, /OPENAI_API_KEY=secretref:openai-api-key-r1234567890a1/);
  assert.equal(stderr.includes(echoedValue), false, 'Azure error text must not leak a key');
});

test('a transient secret update conflict retries the complete batch before candidate creation', () => {
  const { calls, update } = runStoppedWriterUpdate({
    OPENAI_API_KEY: randomBytes(24).toString('hex'),
    SEGMENT_WRITE_KEY: randomBytes(24).toString('hex'),
  }, { secretSetMode: 'reject-once' });
  const secretCalls = calls.filter(call => call.startsWith('containerapp secret set '));
  assert.equal(secretCalls.length, 2);
  for (const call of secretCalls) {
    assert.match(call, /openai-api-key-r1234567890a1=/);
    assert.match(call, /segment-write-key-r1234567890a1=/);
  }
  assert.ok(update);
  assert.ok(calls.findIndex(call => call.startsWith('containerapp secret list ')) <
    calls.findIndex(call => call.startsWith('containerapp update ')));
});

test('a secret failure restores the old revision after a transient rollback conflict', () => {
  const echoedValue = randomBytes(24).toString('hex');
  const { calls, stderr, restored } = runStoppedWriterUpdate(
    { OPENAI_API_KEY: randomBytes(24).toString('hex') },
    {
      secretSetMode: 'invalid',
      secretValueForError: echoedValue,
      rollbackMode: 'reject-once',
      expectedStatus: 1,
      expectUpdate: false,
    },
  );
  assert.equal(restored, true, 'old revision should be reactivated');
  assert.equal(calls.filter(call => call.startsWith('containerapp revision activate ')).length, 2);
  assert.match(stderr, /Could not store the Container App secret batch \(Azure error: InvalidParameter\)/);
  assert.match(stderr, /Azure operation is still in progress; retrying activate the previous revision/);
  assert.match(stderr, /Restored previous revision live-scavenger-hunt--old/);
  assert.equal(stderr.includes('Could not restore the previous revision'), false);
  assert.equal(stderr.includes(echoedValue), false);
});

test('rollback waits for delayed old-revision activation before claiming recovery', () => {
  const { calls, stderr, restored } = runStoppedWriterUpdate(
    { OPENAI_API_KEY: randomBytes(24).toString('hex') },
    { secretSetMode: 'invalid', activationMode: 'delayed', expectedStatus: 1, expectUpdate: false },
  );
  assert.equal(restored, true, 'Azure accepted the activation command');
  const activationAt = calls.findIndex(call => call.startsWith('containerapp revision activate '));
  const laterStatusChecks = calls.slice(activationAt + 1)
    .filter(call => call.startsWith('containerapp revision show '));
  assert.ok(laterStatusChecks.length >= 3, 'rollback must poll until the old revision is healthy');
  assert.match(stderr, /Restored previous revision live-scavenger-hunt--old/);
});

test('rollback does not claim recovery when activation command succeeds but the revision fails', () => {
  const { calls, stderr, restored } = runStoppedWriterUpdate(
    { OPENAI_API_KEY: randomBytes(24).toString('hex') },
    { secretSetMode: 'invalid', activationMode: 'failed', expectedStatus: 1, expectUpdate: false },
  );
  assert.equal(restored, true, 'Azure accepted the activation command');
  assert.equal(calls.some(call => call.startsWith('containerapp revision activate ')), true);
  assert.match(stderr, /Previous revision activation failed/);
  assert.match(stderr, /Could not restore the previous revision/);
  assert.equal(stderr.includes('Restored previous revision live-scavenger-hunt--old'), false);
});

test('rollback rechecks the final traffic target after activation initially looks healthy', () => {
  const { calls, stderr, restored } = runStoppedWriterUpdate(
    { OPENAI_API_KEY: randomBytes(24).toString('hex') },
    { secretSetMode: 'invalid', activationMode: 'failed-after-traffic', expectedStatus: 1, expectUpdate: false },
  );
  assert.equal(restored, true, 'Azure accepted the activation command');
  assert.ok(calls.some(call => call.startsWith('containerapp ingress traffic set ')),
    'the route restoration command must have been accepted');
  assert.match(stderr, /Rollback reached a failed Azure state/);
  assert.match(stderr, /Could not restore the previous revision/);
  assert.equal(stderr.includes('Restored previous revision live-scavenger-hunt--old'), false);
});
