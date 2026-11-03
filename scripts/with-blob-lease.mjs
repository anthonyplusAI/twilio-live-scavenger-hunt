import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ManagedIdentityCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';

const LOCK_BLOB = 'live-scavenger-hunt-writer.lock';
const LOCK_CONTENT = 'Live Scavenger Hunt writer lease. Keep this blob for cross-replica coordination.\n';
const DEFAULT_TIMING = Object.freeze({
  leaseSeconds: 60,
  renewIntervalMs: 10_000,
  acquireRetryMs: 3_000,
  requestTimeoutMs: 8_000,
  safetyMs: 20_000,
});

function asError(value) {
  return value instanceof Error ? value : new Error(String(value ?? 'Operation aborted.'));
}

async function bounded(operation, { signal, timeoutMs }) {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(asError(signal.reason));
  if (signal?.aborted) onParentAbort();
  else signal?.addEventListener('abort', onParentAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error(`Blob request timed out after ${timeoutMs} ms.`)), timeoutMs);
  let onAbort;
  try {
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(asError(controller.signal.reason));
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener('abort', onAbort);
    signal?.removeEventListener('abort', onParentAbort);
  }
}

async function wait(ms, signal) {
  try { await pause(ms, undefined, { signal }); }
  catch (error) { throw signal?.aborted ? asError(signal.reason) : error; }
}

function leaseBusy(error) {
  return error?.statusCode === 409 &&
    ['LeaseAlreadyPresent', 'LeaseIsBreakingAndCannotBeAcquired'].includes(error.code);
}

// The container already exists. The condition makes simultaneous first boots safe.
export async function ensureLockBlob(blobClient, { signal, requestTimeoutMs = 15_000 } = {}) {
  if (await bounded(abortSignal => blobClient.exists({ abortSignal }), { signal, timeoutMs: requestTimeoutMs })) return;
  try {
    await bounded(abortSignal => blobClient.upload(LOCK_CONTENT, Buffer.byteLength(LOCK_CONTENT), {
      conditions: { ifNoneMatch: '*' }, abortSignal,
    }), { signal, timeoutMs: requestTimeoutMs });
  } catch (error) {
    if (!((error.statusCode === 412 && error.code === 'ConditionNotMet') ||
      (error.statusCode === 409 && error.code === 'BlobAlreadyExists'))) throw error;
    await bounded(abortSignal => blobClient.getProperties({ abortSignal }), { signal, timeoutMs: requestTimeoutMs });
  }
}

// The child owns an isolated process group. Its stdout/stderr pipes remain open
// while descendants inherit them, so "close" also waits for Litestream's app.
export function runProcess(command, args, {
  shutdownSignal,
  leaseLostSignal,
  terminationGraceMs = 45_000,
  emergencyGraceMs = 3_000,
  env = process.env,
} = {}) {
  if (shutdownSignal?.aborted) return Promise.reject(asError(shutdownSignal.reason));
  if (leaseLostSignal?.aborted) return Promise.reject(asError(leaseLostSignal.reason));
  return new Promise((resolveRun, rejectRun) => {
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (error) { rejectRun(error); return; }
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });

    let spawnError;
    let forceTimer;
    let stopping = false;
    let closed = false;
    const signalGroup = kind => {
      if (!child.pid) return;
      try { process.kill(-child.pid, kind); }
      catch (error) { if (error.code !== 'ESRCH') console.error(`Unable to signal worker group: ${error.message}`); }
    };
    const armForce = ms => {
      clearTimeout(forceTimer);
      forceTimer = setTimeout(() => signalGroup('SIGKILL'), ms);
    };
    const stop = emergency => {
      if (closed) return;
      if (emergency) {
        // A lost lease takes precedence even if graceful shutdown has begun.
        // Both Litestream and its exec child must stop well before expiry.
        stopping = true;
        signalGroup('SIGTERM');
        armForce(emergencyGraceMs);
      } else if (!stopping) {
        // Litestream forwards the signal to its exec child, waits for it, and
        // runs its final Blob sync. Signaling the whole group races that flow.
        stopping = true;
        child.kill('SIGTERM');
        armForce(terminationGraceMs);
      }
    };
    const onShutdown = () => stop(false);
    const onLeaseLost = () => stop(true);
    shutdownSignal?.addEventListener('abort', onShutdown, { once: true });
    leaseLostSignal?.addEventListener('abort', onLeaseLost, { once: true });

    child.once('error', error => { spawnError = error; });
    child.once('exit', () => {
      // If Litestream exits first, shut down any app process still in its group.
      stop(true);
    });
    child.once('close', (code, exitSignal) => {
      closed = true;
      clearTimeout(forceTimer);
      shutdownSignal?.removeEventListener('abort', onShutdown);
      leaseLostSignal?.removeEventListener('abort', onLeaseLost);
      signalGroup('SIGKILL'); // final guard for descendants that closed their log pipes
      if (spawnError) rejectRun(spawnError);
      else if (leaseLostSignal?.aborted) rejectRun(asError(leaseLostSignal.reason));
      else if (shutdownSignal?.aborted) rejectRun(asError(shutdownSignal.reason));
      else resolveRun(code ?? (exitSignal ? 1 : 0));
    });
  });
}

// The only caller that may start restore/Litestream is inside this lease scope.
export async function runWithBlobLease({ leaseClient, run, signal, timing = {}, log = console }) {
  const settings = { ...DEFAULT_TIMING, ...timing };
  const leaseMs = settings.leaseSeconds * 1_000;
  if (!Number.isInteger(settings.leaseSeconds) || settings.leaseSeconds < 15 || settings.leaseSeconds > 60 ||
      settings.safetyMs <= 0 || settings.safetyMs >= leaseMs) throw new Error('Invalid lease timing.');

  let acquiredAt;
  let waitingLogged = false;
  for (;;) {
    if (signal?.aborted) throw asError(signal.reason);
    const requestStarted = performance.now();
    try {
      await bounded(abortSignal => leaseClient.acquireLease(settings.leaseSeconds, { abortSignal }), {
        signal, timeoutMs: settings.requestTimeoutMs,
      });
      acquiredAt = requestStarted;
      break;
    } catch (error) {
      if (signal?.aborted) throw asError(signal.reason);
      if (!leaseBusy(error)) throw new Error(`Could not acquire writer lease: ${error.message}`, { cause: error });
      if (!waitingLogged) { log.log('Another replica owns the writer lease; waiting without starting the app.'); waitingLogged = true; }
      await wait(settings.acquireRetryMs, signal);
    }
  }
  log.log('Writer lease acquired. Restoring and starting Litestream.');

  const shutdown = new AbortController();
  const leaseLost = new AbortController();
  const stopRenewal = new AbortController();
  const onShutdown = () => shutdown.abort(asError(signal.reason));
  if (signal?.aborted) onShutdown();
  else signal?.addEventListener('abort', onShutdown, { once: true });
  let lossError;
  let deadlineTimer;
  const lose = error => {
    if (lossError) return;
    lossError = error;
    log.error(error.message);
    leaseLost.abort(error);
  };
  const setDeadline = requestStarted => {
    clearTimeout(deadlineTimer);
    const remaining = requestStarted + leaseMs - settings.safetyMs - performance.now();
    if (remaining <= 0) lose(new Error('Writer lease deadline reached before a confirmed renewal.'));
    else deadlineTimer = setTimeout(() => lose(new Error('Writer lease deadline reached before a confirmed renewal.')), remaining);
  };
  setDeadline(acquiredAt);

  const renew = (async () => {
    for (;;) {
      try { await wait(settings.renewIntervalMs, stopRenewal.signal); }
      catch { return; }
      if (stopRenewal.signal.aborted || leaseLost.signal.aborted) return;
      const requestStarted = performance.now();
      try {
        await bounded(abortSignal => leaseClient.renewLease({ abortSignal }), {
          signal: stopRenewal.signal, timeoutMs: settings.requestTimeoutMs,
        });
      } catch (error) {
        if (!stopRenewal.signal.aborted) lose(new Error(`Writer lease renewal failed: ${error.message}`, { cause: error }));
        return;
      }
      if (stopRenewal.signal.aborted || leaseLost.signal.aborted) return;
      setDeadline(requestStarted);
    }
  })();

  let result;
  let workError;
  let releaseError;
  try {
    if (shutdown.signal.aborted) throw asError(shutdown.signal.reason);
    result = await run(shutdown.signal, leaseLost.signal);
  } catch (error) { workError = error; }
  finally {
    clearTimeout(deadlineTimer);
    stopRenewal.abort(new Error('Worker stopped.'));
    await renew;
    signal?.removeEventListener('abort', onShutdown);
    try {
      await bounded(abortSignal => leaseClient.releaseLease({ abortSignal }), {
        timeoutMs: settings.requestTimeoutMs,
      });
      log.log('Writer lease released after worker shutdown.');
    } catch (error) { releaseError = error; }
  }
  if (lossError) throw lossError;
  if (releaseError) throw new Error(`Could not release writer lease: ${releaseError.message}`, { cause: releaseError });
  if (workError && (!signal?.aborted || workError !== signal.reason)) throw workError;
  return signal?.aborted ? 0 : result;
}

export async function runLitestream(shutdownSignal, leaseLostSignal, {
  databasePath = process.env.LIVE_SCAVENGER_HUNT_DB,
  litestreamBinary = 'litestream',
} = {}) {
  mkdirSync(dirname(databasePath), { recursive: true });
  if (!existsSync(databasePath)) {
    console.log('Restoring the local database from Azure Blob when a replica exists.');
    const args = ['restore', '-integrity-check', 'quick'];
    if (process.env.LITESTREAM_REQUIRE_REPLICA !== '1') args.push('-if-replica-exists');
    args.push('-config', '/etc/litestream.yml', databasePath);
    const code = await runProcess(litestreamBinary, args, { shutdownSignal, leaseLostSignal });
    if (code !== 0) throw new Error(`Litestream restore exited with code ${code}.`);
  }
  const code = await runProcess(litestreamBinary, ['replicate', '-config', '/etc/litestream.yml', '-exec', 'node app/server/index.mjs'], {
    shutdownSignal, leaseLostSignal,
  });
  throw new Error(`Litestream replication process exited unexpectedly with code ${code}.`);
}

async function main() {
  const account = process.env.LITESTREAM_AZURE_ACCOUNT_NAME || '';
  const container = process.env.LITESTREAM_AZURE_CONTAINER_NAME || '';
  const databasePath = process.env.LIVE_SCAVENGER_HUNT_DB || '';
  if (!/^[a-z0-9]{3,24}$/.test(account)) throw new Error('LITESTREAM_AZURE_ACCOUNT_NAME must be an Azure Storage account name.');
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$/.test(container) || container.includes('--'))
    throw new Error('LITESTREAM_AZURE_CONTAINER_NAME must be an Azure Blob container name.');
  if (!isAbsolute(databasePath)) throw new Error('LIVE_SCAVENGER_HUNT_DB must be an absolute path.');

  const shutdown = new AbortController();
  const onSignal = name => {
    if (!shutdown.signal.aborted) {
      console.log(`${name} received; stopping the app while retaining the writer lease.`);
      shutdown.abort(new Error(name));
    }
  };
  const handlers = ['SIGTERM', 'SIGINT', 'SIGHUP'].map(name => [name, () => onSignal(name)]);
  for (const [name, handler] of handlers) process.on(name, handler);
  try {
    const credential = process.env.AZURE_CLIENT_ID
      ? new ManagedIdentityCredential({ clientId: process.env.AZURE_CLIENT_ID })
      : new ManagedIdentityCredential();
    const service = new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential, {
      retryOptions: { maxTries: 1, tryTimeoutInMs: 7_000 },
    });
    const blob = service.getContainerClient(container).getBlockBlobClient(LOCK_BLOB);
    await ensureLockBlob(blob, { signal: shutdown.signal });
    if (shutdown.signal.aborted) return 0;
    return await runWithBlobLease({
      leaseClient: blob.getBlobLeaseClient(), signal: shutdown.signal,
      run: runLitestream,
    });
  } catch (error) {
    if (shutdown.signal.aborted && error === shutdown.signal.reason) return 0;
    throw error;
  } finally {
    for (const [name, handler] of handlers) process.off(name, handler);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`Lease guard failed: ${error.message}`);
    process.exitCode = 1;
  });
}
