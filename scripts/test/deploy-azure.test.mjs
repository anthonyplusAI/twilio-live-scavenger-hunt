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
      { settings: { SEGMENT_IDENTIFY_LEADS: 'yes' }, error: /SEGMENT_IDENTIFY_LEADS must be 0 or 1/ },
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
          SEGMENT_WRITE_KEY: '', SEGMENT_IDENTIFY_LEADS: '',
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

function runStoppedWriterUpdate(settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lsh-deploy-disable-'));
  const azPath = join(dir, 'az');
  const azLog = join(dir, 'az-calls');
  const stopped = join(dir, 'old-stopped');
  const previous = 'live-scavenger-hunt--old';
  writeFileSync(azPath, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_AZ_LOG"
if [ "$1 $2" = 'containerapp show' ]; then
  for arg in "$@"; do
    if [ "$arg" = '--query' ]; then printf '%s\\n' "$FAKE_OLD_REVISION"; exit 0; fi
  done
  printf '%s\\n' "$FAKE_APP_JSON"; exit 0
fi
if [ "$1 $2 $3" = 'containerapp revision list' ]; then
  if [ -f "$FAKE_STOPPED" ]; then printf '%s\\n' "$FAKE_INACTIVE_REVISIONS"
  else printf '%s\\n' "$FAKE_ACTIVE_REVISIONS"; fi
  exit 0
fi
if [ "$1 $2 $3" = 'containerapp revision show' ]; then
  printf '%s\\n' "$FAKE_STOPPED_REVISION"; exit 0
fi
if [ "$1 $2 $3" = 'containerapp revision deactivate' ]; then
  touch "$FAKE_STOPPED"; exit 0
fi
if [ "$1 $2 $3" = 'containerapp ingress traffic' ]; then exit 0; fi
if [ "$1 $2 $3" = 'containerapp secret set' ]; then exit 0; fi
if [ "$1 $2" = 'containerapp update' ]; then exit 71; fi
exit 83
`);
  writeFileSync(join(dir, 'sleep'), '#!/bin/sh\nexit 0\n');
  chmodSync(azPath, 0o755);
  chmodSync(join(dir, 'sleep'), 0o755);
  const app = { properties: { configuration: { activeRevisionsMode: 'Multiple', ingress: {
    targetPort: 8080, traffic: [{ revisionName: previous, weight: 100, latestRevision: false }],
  } }, latestRevisionName: previous } };
  const revision = active => [{ name: previous, properties: { active, replicas: active ? 1 : 0 } }];
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
        SEGMENT_IDENTIFY_LEADS: '',
        SENDGRID_API_KEY: '',
        SENDGRID_FROM_EMAIL: '',
        SENDGRID_REGION: '',
        ...settings,
        FAKE_AZ_LOG: azLog,
        FAKE_STOPPED: stopped,
        FAKE_OLD_REVISION: previous,
        FAKE_APP_JSON: JSON.stringify(app),
        FAKE_ACTIVE_REVISIONS: JSON.stringify(revision(true)),
        FAKE_INACTIVE_REVISIONS: JSON.stringify(revision(false)),
        FAKE_STOPPED_REVISION: JSON.stringify({ properties: {
          active: false, replicas: 0, provisioningState: 'Deprovisioned', runningState: 'Stopped',
        } }),
      },
    });
    assert.equal(run.status, 71, run.stderr);
    assert.equal(existsSync(stopped), true, 'the old revision must stop before update');
    const calls = readFileSync(azLog, 'utf8').split('\n');
    const update = calls.find(call => call.startsWith('containerapp update '));
    assert.ok(update, 'candidate update must be attempted');
    for (const name of ['GOOGLE_CLIENT_SECRET', 'TWILIO_API_KEY_SECRET', 'TWILIO_AUTH_TOKEN',
      'OPENAI_API_KEY', 'SEGMENT_WRITE_KEY', 'SENDGRID_API_KEY']) {
      if (settings[name]) assert.equal(`${run.stdout}${run.stderr}`.includes(settings[name]), false);
    }
    return { calls, update };
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
  assert.equal(secretCalls.length, 4);
  assert.ok(secretCalls.every(({ index }) => stoppedAt < index && index < updateAt));
  for (const [name, secretName] of [
    ['TWILIO_ACCOUNT_SID', 'twilio-account-sid'],
    ['TWILIO_API_KEY_SID', 'twilio-api-key-sid'],
    ['TWILIO_API_KEY_SECRET', 'twilio-api-key-secret'],
    ['TWILIO_AUTH_TOKEN', 'twilio-auth-token'],
  ]) {
    assert.equal(secretCalls.some(({ call }) => call.includes(`--secrets ${secretName}-r1234567890a1=`)), true);
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
  assert.equal(secretCalls.length, 3);
  assert.ok(secretCalls.every(({ index }) => stoppedAt < index && index < updateAt));
  for (const name of ['openai-api-key', 'segment-write-key', 'sendgrid-api-key'])
    assert.equal(secretCalls.some(({ call }) => call.includes(`--secrets ${name}-r1234567890a1=`)), true);
  assert.match(update, /OPENAI_API_KEY=secretref:openai-api-key-r1234567890a1/);
  assert.match(update, /OPENAI_VISION_MODEL=gpt-6-luna/);
  assert.match(update, /SEGMENT_WRITE_KEY=secretref:segment-write-key-r1234567890a1/);
  assert.match(update, /SENDGRID_API_KEY=secretref:sendgrid-api-key-r1234567890a1/);
  assert.match(update, /SENDGRID_FROM_EMAIL=booth@example.com/);
  assert.match(update, /SENDGRID_REGION=eu/);
  assert.equal(update.includes('SEGMENT_IDENTIFY_LEADS='), false, 'identify must stay off unless explicitly configured');
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
    GITHUB_RUN_ID: '872000001',
  };
  const first = runStoppedWriterUpdate({ ...settings, GITHUB_RUN_ATTEMPT: '1' });
  const second = runStoppedWriterUpdate({ ...settings, GITHUB_RUN_ATTEMPT: '2' });
  for (const name of [
    'google-client-secret', 'twilio-account-sid', 'twilio-api-key-sid',
    'twilio-api-key-secret', 'twilio-auth-token', 'openai-api-key',
    'segment-write-key', 'sendgrid-api-key',
  ]) {
    assert.equal(first.calls.some(call => call.includes(`--secrets ${name}-r872000001a1=`)), true);
    assert.equal(second.calls.some(call => call.includes(`--secrets ${name}-r872000001a2=`)), true);
    assert.equal(first.update.includes(`secretref:${name}-r872000001a1`), true);
    assert.equal(second.update.includes(`secretref:${name}-r872000001a2`), true);
    assert.equal(second.update.includes(`secretref:${name}-r872000001a1`), false);
  }
  assert.match(first.update, /--revision-suffix r872000001a1/);
  assert.match(second.update, /--revision-suffix r872000001a2/);
});

test('explicit Segment Identify values and SendGrid region changes use the stopped-writer update', () => {
  const { calls, update } = runStoppedWriterUpdate({
    SEGMENT_IDENTIFY_LEADS: '0',
    SENDGRID_REGION: 'global',
    OPENAI_VISION_MODEL: 'gpt-6-luna',
  });
  assert.match(update, /SEGMENT_IDENTIFY_LEADS=0/);
  assert.match(update, /SENDGRID_REGION=global/);
  assert.match(update, /OPENAI_VISION_MODEL=gpt-6-luna/);
  assert.equal(calls.some(call => call.startsWith('containerapp secret set ')), false);
  const enabled = runStoppedWriterUpdate({ SEGMENT_IDENTIFY_LEADS: '1' });
  assert.match(enabled.update, /SEGMENT_IDENTIFY_LEADS=1/);
});
