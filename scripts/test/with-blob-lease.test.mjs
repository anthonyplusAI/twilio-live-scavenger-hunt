import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { ensureLockBlob, runProcess, runWithBlobLease } from '../with-blob-lease.mjs';

const quiet = { log() {}, warn() {}, error() {} };
const childStartupTimeoutMs = 10_000;

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition.');
    await pause(10);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('a standby replica does not start work until it owns the blob lease', async () => {
  let leaseAvailable = false;
  let attempts = 0;
  let started = false;
  let stopped = false;
  const work = deferred();
  const leaseClient = {
    async acquireLease(duration) {
      assert.equal(duration, 60);
      attempts += 1;
      if (!leaseAvailable) throw Object.assign(new Error('busy'), { statusCode: 409, code: 'LeaseAlreadyPresent' });
      return { leaseId: 'owned' };
    },
    async renewLease() { return { leaseId: 'owned' }; },
    async releaseLease() { assert.equal(stopped, true, 'release must follow worker shutdown'); },
  };

  const guarded = runWithBlobLease({
    leaseClient, log: quiet,
    timing: { acquireRetryMs: 10, renewIntervalMs: 25, requestTimeoutMs: 100 },
    run: async () => { started = true; await work.promise; stopped = true; return 0; },
  });
  await waitUntil(() => attempts >= 2);
  assert.equal(started, false);
  leaseAvailable = true;
  await waitUntil(() => started);
  work.resolve();
  assert.equal(await guarded, 0);
});

test('lease renewal failure stops a stubborn process before releasing the lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lsh-lease-'));
  const pidFile = join(dir, 'worker.pid');
  let released = false;
  const leaseClient = {
    async acquireLease() { return { leaseId: 'owned' }; },
    async renewLease() {
      if (!existsSync(pidFile)) return { leaseId: 'owned' };
      throw new Error('Blob service is unavailable');
    },
    async releaseLease() {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'worker must be gone before release');
      released = true;
    },
  };

  try {
    await assert.rejects(runWithBlobLease({
      leaseClient, log: quiet,
      timing: { renewIntervalMs: 25, requestTimeoutMs: 100 },
      run: (shutdown, leaseLost) => runProcess(process.execPath, [
        '--input-type=module', '-e',
        'import { writeFileSync } from "node:fs"; process.on("SIGTERM", () => {}); writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);',
        pidFile,
      ], { shutdownSignal: shutdown, leaseLostSignal: leaseLost, emergencyGraceMs: 75 }),
    }), /lease renewal/i);
    assert.equal(released, true);
  } finally {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normal shutdown keeps renewing the lease until the worker finishes its final sync', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lsh-graceful-'));
  const pidFile = join(dir, 'worker.pid');
  const shutdown = new AbortController();
  let renewalsAfterStop = 0;
  let released = false;
  const leaseClient = {
    async acquireLease() { return { leaseId: 'owned' }; },
    async renewLease() {
      if (shutdown.signal.aborted) renewalsAfterStop += 1;
      return { leaseId: 'owned' };
    },
    async releaseLease() {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      released = true;
    },
  };

  try {
    const guarded = runWithBlobLease({
      leaseClient, log: quiet, signal: shutdown.signal,
      timing: { renewIntervalMs: 20, requestTimeoutMs: 100 },
      run: (stop, lost) => runProcess(process.execPath, [
        '--input-type=module', '-e',
        'import { writeFileSync } from "node:fs"; process.on("SIGTERM", () => setTimeout(() => process.exit(0), 140)); writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);',
        pidFile,
      ], { shutdownSignal: stop, leaseLostSignal: lost, terminationGraceMs: 500 }),
    });
    await waitUntil(() => existsSync(pidFile), childStartupTimeoutMs);
    shutdown.abort(new Error('SIGTERM'));
    assert.equal(await guarded, 0);
    assert.ok(renewalsAfterStop >= 2, 'the lease must renew during graceful final sync');
    assert.equal(released, true);
  } finally {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normal shutdown lets Litestream forward SIGTERM to its app before final sync', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lsh-forward-'));
  const parentReady = join(dir, 'litestream-ready');
  const childReady = join(dir, 'app-ready');
  const childTerm = join(dir, 'app-term');
  const premature = join(dir, 'app-terminated-before-forward');
  const finalSync = join(dir, 'final-sync');
  const shutdown = new AbortController();
  const appCode = `
    import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => { writeFileSync(process.argv[2], 'stopped'); process.exit(0); });
    writeFileSync(process.argv[1], 'ready');
    setInterval(() => {}, 1000);
  `;
  const litestreamCode = `
    import { spawn } from 'node:child_process';
    import { existsSync, writeFileSync } from 'node:fs';
    const app = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(appCode)}, process.argv[2], process.argv[3]], { stdio: 'inherit' });
    let stopping = false;
    let forwarded = false;
    process.on('SIGTERM', () => {
      stopping = true;
      setTimeout(() => {
        if (existsSync(process.argv[3])) {
          writeFileSync(process.argv[4], 'too early');
          process.exit(2);
        }
        forwarded = true;
        app.kill('SIGTERM');
      }, 60);
    });
    app.on('exit', () => {
      if (!stopping || !forwarded) {
        writeFileSync(process.argv[4], 'too early');
        process.exit(2);
      }
      writeFileSync(process.argv[5], 'synced');
      process.exit(0);
    });
    const ready = setInterval(() => {
      if (existsSync(process.argv[2])) {
        clearInterval(ready);
        writeFileSync(process.argv[1], 'ready');
      }
    }, 5);
  `;

  try {
    const running = runProcess(process.execPath, [
      '--input-type=module', '-e', litestreamCode,
      parentReady, childReady, childTerm, premature, finalSync,
    ], { shutdownSignal: shutdown.signal, terminationGraceMs: 500, emergencyGraceMs: 75 });
    await waitUntil(() => existsSync(parentReady), childStartupTimeoutMs);
    shutdown.abort(new Error('planned shutdown'));
    await assert.rejects(running, /planned shutdown/);
    assert.equal(existsSync(premature), false, 'app must not receive SIGTERM before Litestream forwards it');
    assert.equal(existsSync(finalSync), true, 'Litestream must finish its final sync');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a local lease deadline stops work even if no renewal response arrives', async () => {
  let stopped = false;
  let released = false;
  const leaseClient = {
    async acquireLease(duration) { assert.equal(duration, 15); return { leaseId: 'owned' }; },
    async renewLease() { return new Promise(() => {}); },
    async releaseLease() { assert.equal(stopped, true); released = true; },
  };

  await assert.rejects(runWithBlobLease({
    leaseClient, log: quiet,
    timing: { leaseSeconds: 15, safetyMs: 14_900, renewIntervalMs: 10, requestTimeoutMs: 500 },
    run: (_shutdown, leaseLost) => new Promise(resolve => leaseLost.addEventListener('abort', () => {
      stopped = true;
      resolve(0);
    }, { once: true })),
  }), /lease deadline/i);
  assert.equal(released, true);
});

test('an external stop while waiting for the lease never starts the app', async () => {
  const stop = new AbortController();
  let started = false;
  const leaseClient = {
    async acquireLease() { throw Object.assign(new Error('busy'), { statusCode: 409, code: 'LeaseAlreadyPresent' }); },
    async renewLease() { throw new Error('unexpected renewal'); },
    async releaseLease() { throw new Error('unexpected release'); },
  };
  const guarded = runWithBlobLease({
    leaseClient, log: quiet, signal: stop.signal,
    timing: { acquireRetryMs: 10, requestTimeoutMs: 100 },
    run: async () => { started = true; return 0; },
  });
  await pause(25);
  stop.abort(new Error('container stopping'));
  await assert.rejects(guarded, /container stopping/);
  assert.equal(started, false);
});

test('lock blob creation uses a create-only condition and accepts a concurrent creator', async () => {
  let verified = false;
  const blobClient = {
    async exists() { return false; },
    async upload(body, length, options) {
      assert.equal(length, Buffer.byteLength(body));
      assert.equal(options.conditions.ifNoneMatch, '*');
      throw Object.assign(new Error('already created'), { statusCode: 412, code: 'ConditionNotMet' });
    },
    async getProperties() { verified = true; return { leaseState: 'leased' }; },
  };
  await ensureLockBlob(blobClient, { requestTimeoutMs: 100 });
  assert.equal(verified, true);
});

test('an unexpected clean Litestream exit is reported as a failed writer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lsh-replicate-'));
  const db = join(dir, 'game.sqlite');
  const binary = join(dir, 'fake-litestream');
  writeFileSync(db, 'local fixture');
  writeFileSync(binary, '#!/bin/sh\nexit 0\n');
  chmodSync(binary, 0o755);
  try {
    const { runLitestream } = await import('../with-blob-lease.mjs');
    await assert.rejects(runLitestream(new AbortController().signal, new AbortController().signal, {
      databasePath: db,
      litestreamBinary: binary,
    }), /Litestream replication process exited unexpectedly with code 0/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
