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

function runStoppedWriterUpdate(googleSettings) {
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
        LITESTREAM_REQUIRE_REPLICA: '1',
        GOOGLE_AUTH_DISABLE: '',
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
        ...googleSettings,
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
    assert.equal(`${run.stdout}${run.stderr}`.includes(googleSettings.GOOGLE_CLIENT_SECRET || 'unprintable-secret'), false);
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
  assert.match(calls[secretAt], /--secrets google-client-secret=/);
  assert.equal(update.includes(`GOOGLE_CLIENT_ID=${clientId}`), true);
  assert.match(update, /GOOGLE_CLIENT_SECRET=secretref:google-client-secret/);
  assert.equal(update.includes(secret), false, 'the plaintext secret must never be a revision environment value');
});
