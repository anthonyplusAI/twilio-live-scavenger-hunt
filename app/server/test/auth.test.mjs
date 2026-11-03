import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Store } from '../db.mjs';
import { AuthService, AuthError } from '../auth.mjs';

const verifiedGoogle = { emailVerified: true, hostedDomain: 'twilio.com' };

function makeAuth(publicBaseUrl = 'http://localhost:3000') {
  const store = new Store(':memory:');
  return { store, auth: new AuthService({ store, publicBaseUrl }) };
}

function testBootstrapPassword() {
  let value;
  do { value = randomBytes(32).toString('hex'); }
  while (new Set(value).size < 8);
  return value;
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

test('a configured bootstrap password creates the first admin without entering retained logs', () => {
  const password = testBootstrapPassword();
  const store = new Store(':memory:');
  const auth = new AuthService({ store, bootstrapPassword: password });
  const output = [];
  const originalLog = console.log;
  try {
    console.log = (...args) => output.push(args.join(' '));
    const first = auth.bootstrap();
    const second = auth.bootstrap();
    assert.equal(first.created, true);
    assert.equal(first.user.username, 'admin');
    assert.equal(second.created, false);
    assert.equal(auth.login('admin', password).user.role, 'admin');
    assert.equal(store.sql.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
    assert.ok(!output.join('\n').includes(password));
    assert.ok(!output.some(line => line.startsWith('One-time password: ')));
  } finally {
    console.log = originalLog;
    store.close();
  }
});

test('invalid configured bootstrap passwords fail before a user is created', () => {
  for (const password of ['', null, 42]) {
    const store = new Store(':memory:');
    try {
      const auth = new AuthService({ store, bootstrapPassword: password });
      assert.throws(() => auth.bootstrap(), { code: 'invalid_password' });
      assert.equal(store.sql.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
    } finally { store.close(); }
  }
});

test('local accounts accept any nonempty password, including a single character and a space', () => {
  const { store, auth } = makeAuth();
  try {
    const admin = auth.createUser('admin', 'x', 'admin');
    assert.equal(auth.login('admin', 'x').user.id, admin.id);
    auth.changePassword(admin.id, 'x', ' ');
    assert.equal(auth.login('admin', ' ').user.id, admin.id);
    const operator = auth.createOperator('boothhost', 'z');
    assert.equal(auth.login('boothhost', 'z').user.id, operator.id);
    auth.resetOperatorPassword(operator.id, ' ');
    assert.equal(auth.login('boothhost', ' ').user.id, operator.id);
    assert.throws(() => auth.createOperator('emptyuser', ''), { code: 'invalid_password' });
    assert.throws(() => auth.changePassword(admin.id, ' ', ''), { code: 'invalid_password' });
    assert.throws(() => auth.resetOperatorPassword(operator.id, ''), { code: 'invalid_password' });
  } finally { store.close(); }
});

test('long local passwords remain usable for login, username changes, and password changes', () => {
  const { store, auth } = makeAuth();
  const longPassword = 'p'.repeat(1500);
  try {
    const admin = auth.createUser('admin', longPassword, 'admin');
    assert.equal(auth.login('admin', longPassword).user.id, admin.id);
    assert.equal(auth.renameUsername(admin.id, longPassword, 'boothadmin').username, 'boothadmin');
    auth.changePassword(admin.id, longPassword, 'q');
    assert.equal(auth.login('boothadmin', 'q').user.id, admin.id);
    const operator = auth.createOperator('floorhost', 'r');
    auth.resetOperatorPassword(operator.id, longPassword);
    assert.equal(auth.login('floorhost', longPassword).user.id, operator.id);
  } finally { store.close(); }
});

test('technical password limit is measured in UTF-8 bytes for local account operations', () => {
  const { store, auth } = makeAuth();
  const accepted = 'p'.repeat(16_384);
  const tooLarge = 'é'.repeat(8_193);
  try {
    const admin = auth.createUser('admin', accepted, 'admin');
    assert.equal(auth.login('admin', accepted).user.id, admin.id);
    assert.throws(() => auth.createOperator('oversize', tooLarge), { code: 'invalid_password' });
    assert.throws(() => auth.changePassword(admin.id, accepted, tooLarge), { code: 'invalid_password' });
  } finally { store.close(); }
});

test('configured bootstrap accepts a short password without composition rules', () => {
  for (const password of ['a', '  ', 'x'.repeat(1025)]) {
    const store = new Store(':memory:');
    const auth = new AuthService({ store, bootstrapPassword: password });
    try {
      assert.equal(auth.bootstrap().created, true);
      assert.equal(auth.login('admin', password).user.role, 'admin');
    } finally { store.close(); }
  }
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

test('admin account operations manage local operators and revoke changed sessions', () => {
  const { store, auth } = makeAuth();
  const adminPassword = testBootstrapPassword();
  const firstPassword = testBootstrapPassword();
  const secondPassword = testBootstrapPassword();
  try {
    const admin = auth.createUser('admin', adminPassword, 'admin');
    const operator = auth.createOperator('floor.host', firstPassword);
    assert.equal(operator.authProvider, 'password');
    assert.deepEqual(auth.listOperators().map(user => user.username), ['floor.host']);
    const firstSession = auth.login('floor.host', firstPassword);
    const firstCookie = auth.cookie(firstSession.token).split(';')[0];
    assert.equal(auth.session(firstCookie).user.id, operator.id);
    auth.resetOperatorPassword(operator.id, secondPassword);
    assert.equal(auth.session(firstCookie), null);
    assert.throws(() => auth.login('floor.host', firstPassword), { code: 'invalid_credentials' });
    const secondSession = auth.login('floor.host', secondPassword);
    const secondCookie = auth.cookie(secondSession.token).split(';')[0];
    assert.equal(auth.session(secondCookie).user.role, 'operator');
    assert.throws(() => auth.resetOperatorPassword(admin.id, secondPassword), { code: 'not_found' });
    assert.throws(() => auth.deleteOperator(admin.id), { code: 'not_found' });
    auth.deleteOperator(operator.id);
    assert.equal(auth.session(secondCookie), null);
    assert.deepEqual(auth.listOperators(), []);
    assert.equal(auth.login('admin', adminPassword).user.role, 'admin');
  } finally { store.close(); }
});

test('primary local admin remains the oldest local account after a rename and updates atomically', () => {
  const { store, auth } = makeAuth();
  const oldPassword = testBootstrapPassword();
  const newPassword = testBootstrapPassword();
  const rejectedPassword = testBootstrapPassword();
  try {
    const primary = auth.createUser('admin', oldPassword, 'admin');
    const backup = auth.createUser('backupadmin', testBootstrapPassword(), 'admin');
    store.sql.prepare('UPDATE users SET created_at=? WHERE id=?').run('2025-01-01T00:00:00.000Z', primary.id);
    store.sql.prepare('UPDATE users SET created_at=? WHERE id=?').run('2026-01-01T00:00:00.000Z', backup.id);
    const google = auth.loginGoogleIdentity({ sub: 'admin-editor', email: 'editor@twilio.com', ...verifiedGoogle });
    const googleCookie = auth.cookie(google.token).split(';')[0];
    const local = auth.login('admin', oldPassword);
    const localCookie = auth.cookie(local.token).split(';')[0];
    assert.equal(auth.getPrimaryLocalAdmin().id, primary.id);
    assert.equal(auth.getPrimaryLocalAdmin().authProvider, 'password');
    const count = store.sql.prepare('SELECT COUNT(*) AS count FROM users').get().count;

    const updated = auth.updatePrimaryLocalAdmin({
      username: '  STAGE.ADMIN  ',
      password: newPassword,
      actorId: google.user.id,
    });
    assert.deepEqual({ id: updated.admin.id, username: updated.admin.username,
      usernameChanged: updated.usernameChanged, passwordChanged: updated.passwordChanged },
    { id: primary.id, username: 'stage.admin', usernameChanged: true, passwordChanged: true });
    assert.equal(auth.getPrimaryLocalAdmin().id, primary.id);
    assert.equal(store.sql.prepare('SELECT COUNT(*) AS count FROM users').get().count, count);
    assert.equal(auth.session(localCookie), null);
    assert.equal(auth.session(googleCookie).user.id, google.user.id);
    assert.throws(() => auth.login('admin', oldPassword), { code: 'invalid_credentials' });
    assert.equal(auth.login('stage.admin', newPassword).user.id, primary.id);

    const current = auth.login('stage.admin', newPassword);
    const currentCookie = auth.cookie(current.token).split(';')[0];
    assert.throws(() => auth.updatePrimaryLocalAdmin({
      expectedUsername: 'admin',
      username: 'admin',
      password: rejectedPassword,
      actorId: google.user.id,
    }), { status: 409, code: 'admin_changed' });
    assert.equal(auth.session(currentCookie).user.id, primary.id);
    assert.throws(() => auth.updatePrimaryLocalAdmin({
      username: 'backupadmin',
      password: rejectedPassword,
      actorId: google.user.id,
    }), { code: 'username_exists' });
    assert.equal(auth.session(currentCookie).user.id, primary.id);
    assert.equal(auth.getPrimaryLocalAdmin().username, 'stage.admin');
    assert.equal(auth.login('stage.admin', newPassword).user.id, primary.id);
    assert.throws(() => auth.login('stage.admin', rejectedPassword), { code: 'invalid_credentials' });
    const audits = store.sql.prepare("SELECT user_id,details_json FROM audit WHERE action='admin:local_credentials_changed'").all();
    assert.equal(audits.length, 1);
    assert.equal(audits[0].user_id, google.user.id);
    assert.deepEqual(JSON.parse(audits[0].details_json), {
      targetUserId: primary.id, usernameChanged: true, passwordChanged: true,
    });
    assert.ok(!audits[0].details_json.includes(newPassword));
  } finally { store.close(); }
});

test('Google-managed admins are never selected for local credential updates', () => {
  const { store, auth } = makeAuth();
  try {
    const google = auth.loginGoogleIdentity({ sub: 'google-only-admin', email: 'only@twilio.com', ...verifiedGoogle });
    const cookie = auth.cookie(google.token).split(';')[0];
    assert.throws(() => auth.getPrimaryLocalAdmin(), { status: 404, code: 'not_found' });
    assert.throws(() => auth.updatePrimaryLocalAdmin({ username: 'admin', actorId: google.user.id }),
      { status: 404, code: 'not_found' });
    assert.equal(auth.session(cookie).user.id, google.user.id);
    assert.equal(store.sql.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
    assert.equal(store.sql.prepare('SELECT COUNT(*) AS count FROM audit').get().count, 0);
  } finally { store.close(); }
});

test('changing a local password requires the current password and signs out every session', () => {
  const { store, auth } = makeAuth();
  const oldPassword = testBootstrapPassword();
  const newPassword = testBootstrapPassword();
  try {
    const admin = auth.createUser('admin', oldPassword, 'admin');
    const one = auth.login('admin', oldPassword);
    const two = auth.login('admin', oldPassword);
    const oneCookie = auth.cookie(one.token).split(';')[0];
    const twoCookie = auth.cookie(two.token).split(';')[0];
    assert.throws(() => auth.changePassword(admin.id, newPassword, oldPassword), { code: 'invalid_credentials' });
    assert.equal(auth.session(oneCookie).user.id, admin.id);
    auth.changePassword(admin.id, oldPassword, newPassword);
    assert.equal(auth.session(oneCookie), null);
    assert.equal(auth.session(twoCookie), null);
    assert.throws(() => auth.login('admin', oldPassword), { code: 'invalid_credentials' });
    assert.equal(auth.login('admin', newPassword).user.role, 'admin');
  } finally { store.close(); }
});

test('renaming the first admin validates the password, revokes sessions, and survives bootstrap', () => {
  const store = new Store(':memory:');
  const password = testBootstrapPassword();
  const auth = new AuthService({ store, bootstrapPassword: password });
  try {
    const first = auth.bootstrap();
    const adminId = first.user.id;
    const one = auth.login('admin', password);
    const two = auth.login('admin', password);
    const oneCookie = auth.cookie(one.token).split(';')[0];
    const twoCookie = auth.cookie(two.token).split(';')[0];
    assert.throws(() => auth.renameUsername(adminId, 'incorrect', 'booth.admin'),
      { code: 'invalid_credentials' });
    assert.throws(() => auth.renameUsername(adminId, password, 'not a username'),
      { code: 'invalid_username' });
    assert.equal(auth.session(oneCookie).user.username, 'admin');
    const newUsername = '  BOOTH.ADMIN  ';
    const renamed = auth.renameUsername(adminId, password, newUsername);
    assert.equal(renamed.username, 'booth.admin');
    assert.equal(renamed.id, adminId);
    assert.equal(renamed.role, 'admin');
    assert.equal(auth.session(oneCookie), null);
    assert.equal(auth.session(twoCookie), null);
    assert.throws(() => auth.login('admin', password), { code: 'invalid_credentials' });
    assert.equal(auth.login('booth.admin', password).user.id, adminId);
    assert.equal(auth.bootstrap().created, false);
    assert.equal(store.sql.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin'").get().count, 1);
    auth.createOperator('taken', testBootstrapPassword());
    assert.throws(() => auth.renameUsername(adminId, password, 'taken'),
      { code: 'username_exists' });
    assert.equal(store.sql.prepare('SELECT username FROM users WHERE id=?').get(adminId).username, 'booth.admin');
  } finally { store.close(); }
});

test('admin renames local operators without changing their identity or Google admin names', () => {
  const { store, auth } = makeAuth();
  const adminPassword = testBootstrapPassword();
  const operatorPassword = testBootstrapPassword();
  try {
    const admin = auth.createUser('admin', adminPassword, 'admin');
    const operator = auth.createOperator('floorhost', operatorPassword);
    const originalSession = auth.login('floorhost', operatorPassword);
    const originalCookie = auth.cookie(originalSession.token).split(';')[0];
    assert.throws(() => auth.renameOperatorUsername(operator.id, 'admin'), { code: 'username_exists' });
    assert.throws(() => auth.renameOperatorUsername(operator.id, 'not valid'), { code: 'invalid_username' });
    const renamed = auth.renameOperatorUsername(operator.id, '  SHIFT.LEAD  ');
    assert.equal(renamed.id, operator.id);
    assert.equal(renamed.username, 'shift.lead');
    assert.equal(renamed.role, 'operator');
    assert.equal(auth.session(originalCookie), null);
    assert.throws(() => auth.login('floorhost', operatorPassword), { code: 'invalid_credentials' });
    assert.equal(auth.login('shift.lead', operatorPassword).user.id, operator.id);
    assert.throws(() => auth.renameOperatorUsername(admin.id, 'renamed-admin'), { code: 'not_found' });
    const google = auth.loginGoogleIdentity({ sub: 'google-subject', email: 'person@twilio.com', ...verifiedGoogle });
    assert.throws(() => auth.renameOperatorUsername(google.user.id, 'renamed-google'),
      { code: 'not_found' });
    assert.throws(() => auth.renameUsername(google.user.id, 'anything', 'renamed-google'),
      { code: 'provider_managed' });
  } finally { store.close(); }
});

test('Google admin login requires verified email and Workspace claims at the auth boundary', () => {
  const { store, auth } = makeAuth();
  try {
    const identity = { sub: 'verified-google-subject', email: 'person@twilio.com' };
    for (const claims of [
      {},
      { emailVerified: false, hostedDomain: 'twilio.com' },
      { emailVerified: true, hostedDomain: 'other.com' },
    ]) {
      assert.throws(() => auth.loginGoogleIdentity({ ...identity, ...claims }), { code: 'google_domain' });
      assert.equal(store.sql.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
    }
    const login = auth.loginGoogleIdentity({ ...identity, emailVerified: true, hostedDomain: 'twilio.com' });
    assert.equal(login.user.role, 'admin');
  } finally { store.close(); }
});

test('Google identities are bound by subject, become admins, and reject local password actions', () => {
  const { store, auth } = makeAuth();
  try {
    auth.createUser('admin', testBootstrapPassword(), 'admin');
    const first = auth.loginGoogleIdentity({ sub: 'stable-google-subject', email: 'a@twilio.com', ...verifiedGoogle });
    const second = auth.loginGoogleIdentity({ sub: 'stable-google-subject', email: 'renamed@twilio.com', ...verifiedGoogle });
    assert.equal(first.user.id, second.user.id);
    assert.equal(first.user.role, 'admin');
    assert.equal(second.user.role, 'admin');
    assert.equal(second.user.username, 'renamed@twilio.com');
    assert.equal(second.user.authProvider, 'google');
    assert.equal(auth.listOperators().length, 0);
    const internalUsername = store.sql.prepare('SELECT username FROM users WHERE id=?').get(first.user.id).username;
    assert.throws(() => auth.login(internalUsername, testBootstrapPassword()), { code: 'invalid_credentials' });
    assert.throws(() => auth.resetOperatorPassword(first.user.id, testBootstrapPassword()), { code: 'not_found' });
    assert.throws(() => auth.deleteOperator(first.user.id), { code: 'not_found' });
    assert.throws(() => auth.changePassword(first.user.id, testBootstrapPassword(), testBootstrapPassword()), { code: 'provider_managed' });
    assert.throws(() => auth.loginGoogleIdentity({ sub: 'other', email: 'a@example.com', ...verifiedGoogle }), { code: 'google_domain' });
    const reservedUsername = 'google_' + createHash('sha256').update('collision-sub').digest('hex');
    auth.createOperator(reservedUsername, testBootstrapPassword());
    const collision = auth.loginGoogleIdentity({ sub: 'collision-sub', email: 'other@twilio.com', ...verifiedGoogle });
    assert.equal(collision.user.username, 'other@twilio.com');
    assert.notEqual(store.sql.prepare('SELECT username FROM users WHERE id=?').get(collision.user.id).username, reservedUsername);
  } finally { store.close(); }
});

test('existing Google operators are promoted only on a fresh eligible sign-in and old sessions end', () => {
  const { store, auth } = makeAuth();
  try {
    const local = auth.createOperator('localhost', 'x');
    const localLogin = auth.login('localhost', 'x');
    const localCookie = auth.cookie(localLogin.token).split(';')[0];
    const legacy = auth.loginGoogleIdentity({ sub: 'legacy-google-subject', email: 'legacy@twilio.com', ...verifiedGoogle });
    store.sql.prepare('UPDATE users SET role=? WHERE id=?').run('operator', legacy.user.id);
    const legacyCookie = auth.cookie(legacy.token).split(';')[0];
    assert.equal(auth.session(legacyCookie).user.role, 'operator');
    assert.throws(() => auth.loginGoogleIdentity({ sub: 'legacy-google-subject', email: 'legacy@example.com', ...verifiedGoogle }),
      { code: 'google_domain' });
    assert.equal(auth.session(legacyCookie).user.role, 'operator');
    const upgraded = auth.loginGoogleIdentity({ sub: 'legacy-google-subject', email: 'legacy@twilio.com', ...verifiedGoogle });
    assert.equal(upgraded.user.id, legacy.user.id);
    assert.equal(upgraded.user.role, 'admin');
    assert.equal(auth.session(legacyCookie), null);
    assert.equal(auth.session(auth.cookie(upgraded.token).split(';')[0]).user.role, 'admin');
    assert.equal(auth.session(localCookie).user.role, 'operator');
    assert.equal(auth.listOperators().length, 1);
    assert.equal(auth.listOperators()[0].id, local.id);
  } finally { store.close(); }
});

test('existing SQLite users migrate to the OAuth-capable schema without losing credentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'live-scavenger-hunt-migrate-'));
  const filename = join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec('CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL)');
  legacy.prepare('INSERT INTO users(id,username,role,password_hash,salt,created_at) VALUES(?,?,?,?,?,?)')
    .run('legacy-id', 'legacyoperator', 'operator', 'a'.repeat(128), 'b'.repeat(32), new Date().toISOString());
  legacy.close();
  try {
    const store = new Store(filename);
    try {
      const columns = store.sql.prepare('PRAGMA table_info(users)').all().map(column => column.name);
      assert.ok(columns.includes('auth_provider'));
      assert.ok(columns.includes('google_sub'));
      assert.ok(columns.includes('email'));
      assert.equal(store.sql.prepare("SELECT name FROM sqlite_master WHERE name='google_oauth_flows'").get().name, 'google_oauth_flows');
      const preserved = store.sql.prepare('SELECT username,password_hash,auth_provider FROM users WHERE id=?').get('legacy-id');
      assert.deepEqual({ ...preserved }, { username: 'legacyoperator', password_hash: 'a'.repeat(128), auth_provider: 'password' });
      const auth = new AuthService({ store });
      const password = testBootstrapPassword();
      auth.createUser('oldadmin', password, 'admin');
      assert.equal(auth.login('oldadmin', password).user.role, 'admin');
    } finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
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
