import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../db.mjs';
import { AuthService, AuthError } from '../auth.mjs';

function makeAuth(publicBaseUrl = 'http://localhost:3000') {
  const store = new Store(':memory:');
  return { store, auth: new AuthService({ store, publicBaseUrl }) };
}

test('first boot creates one admin, prints the password once, and stores only a scrypt hash', () => {
  const { store, auth } = makeAuth();
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args.join(' '));
  let first;
  let second;
  try {
    first = auth.bootstrap();
    second = auth.bootstrap();
  } finally {
    console.log = originalLog;
  }
  try {
    assert.equal(first.created, true);
    assert.equal(first.user.role, 'admin');
    assert.equal(second.created, false);
    const passwordLines = output.filter(line => line.startsWith('One-time password: '));
    assert.equal(passwordLines.length, 1);
    const password = passwordLines[0].slice('One-time password: '.length);
    assert.ok(password.length >= 24);
    const row = store.sql.prepare('SELECT * FROM users WHERE username=?').get('admin');
    assert.ok(row);
    assert.notEqual(row.password_hash, password);
    assert.match(row.password_hash, /^[a-f0-9]{128}$/);
    assert.match(row.salt, /^[a-f0-9]{32}$/);
    const login = auth.login('ADMIN', password, '127.0.0.1');
    assert.equal(login.user.role, 'admin');
    assert.ok(login.token);
    assert.ok(login.csrfToken);
  } finally { store.close(); }
});

test('session cookies, CSRF, roles, logout, and expiry are enforced', () => {
  const { store, auth } = makeAuth('https://demo.example.com');
  try {
    auth.createUser('boothadmin', 'a-strong-admin-password', 'admin');
    auth.createUser('boothoperator', 'a-strong-operator-password', 'operator');
    const operator = auth.login('boothoperator', 'a-strong-operator-password', '198.51.100.4');
    const cookie = auth.cookie(operator.token);
    assert.match(cookie, /^signal_stadium_session=[A-Za-z0-9_-]+;/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Secure/);
    assert.doesNotMatch(cookie, new RegExp(operator.csrfToken));
    const cookieHeader = 'other=value; ' + cookie.split(';')[0];
    assert.deepEqual(auth.session(cookieHeader), { user: operator.user, csrfToken: operator.csrfToken });
    assert.equal(auth.require(cookieHeader).user.role, 'operator');
    assert.equal(auth.require(cookieHeader, 'operator', operator.csrfToken).user.role, 'operator');
    assert.throws(() => auth.require(cookieHeader, 'operator', ''), { status: 403, code: 'csrf_invalid' });
    assert.throws(() => auth.require(cookieHeader, 'admin'), { status: 403, code: 'forbidden' });
    const admin = auth.login('boothadmin', 'a-strong-admin-password', '198.51.100.5');
    const adminHeader = auth.cookie(admin.token).split(';')[0];
    assert.equal(auth.require(adminHeader, 'admin', admin.csrfToken).user.role, 'admin');
    assert.match(auth.clearCookie(), /Max-Age=0/);
    assert.match(auth.clearCookie(), /Secure/);
    assert.equal(auth.logout(cookieHeader), true);
    assert.equal(auth.session(cookieHeader), null);
    assert.throws(() => auth.require(cookieHeader), { status: 401, code: 'unauthorized' });
    store.sql.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?')
      .run('2000-01-01T00:00:00.000Z', store.sql.prepare('SELECT token_hash FROM sessions WHERE user_id=?').get(admin.user.id).token_hash);
    assert.equal(auth.session(adminHeader), null);
  } finally { store.close(); }
});

test('failed sign-ins are generic and rate limited by request IP', () => {
  const { store, auth } = makeAuth();
  try {
    auth.createUser('boothadmin', 'a-strong-admin-password', 'admin');
    assert.throws(() => auth.login('unknown', 'a-strong-admin-password', '203.0.113.8'), { status: 401, code: 'invalid_credentials' });
    for (let index = 0; index < 7; index++) {
      assert.throws(() => auth.login('boothadmin', 'wrong-password', '203.0.113.8'), { status: 401, code: 'invalid_credentials' });
    }
    assert.throws(() => auth.login('boothadmin', 'a-strong-admin-password', '203.0.113.8'), { status: 429, code: 'rate_limited' });
    assert.equal(auth.login('boothadmin', 'a-strong-admin-password', '203.0.113.9').user.role, 'admin');
  } finally { store.close(); }
});

test('create-user CLI targets LIVE_SCAVENGER_HUNT_DB and creates an operator', () => {
  const directory = mkdtempSync(join(tmpdir(), 'live-scavenger-hunt-auth-'));
  const filename = join(directory, 'users.sqlite');
  const script = fileURLToPath(new URL('../../../scripts/create-user.mjs', import.meta.url));
  try {
    const admin = spawnSync(process.execPath, [script, '--username', 'firstadmin', '--role', 'admin'], {
      env: { ...process.env, LIVE_SCAVENGER_HUNT_DB: filename }, encoding: 'utf8',
    });
    assert.equal(admin.status, 0, admin.stderr);
    assert.match(admin.stdout, /Created admin user: firstadmin/);
    assert.match(admin.stdout, /One-time password:/);
    const operator = spawnSync(process.execPath, [script, '--username', 'flooroperator', '--role', 'operator'], {
      env: { ...process.env, LIVE_SCAVENGER_HUNT_DB: filename }, encoding: 'utf8',
    });
    assert.equal(operator.status, 0, operator.stderr);
    const store = new Store(filename);
    try {
      assert.equal(store.sql.prepare('SELECT COUNT(*) AS count FROM users').get().count, 2);
      assert.equal(store.sql.prepare('SELECT role FROM users WHERE username=?').get('flooroperator').role, 'operator');
    } finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
