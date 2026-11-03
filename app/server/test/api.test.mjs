import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { openDatabase } from '../db.mjs';
import { GameEngine } from '../engine.mjs';
import { AuthService } from '../auth.mjs';
import { GoogleAuthService } from '../google-auth.mjs';
import { MediaService } from '../media.mjs';
import { JudgeService } from '../judge.mjs';
import { Integrations } from '../integrations.mjs';
import { createHttpServer } from '../http.mjs';

async function fixture(changes = {}, options = {}) {
  const store = openDatabase();
  let event = store.seedDefault();
  if (Object.keys(changes).length) event = store.saveEvent(event.slug, { ...event, ...changes }, event.revision);
  let now = Date.UTC(2026, 10, 2, 12);
  const engine = new GameEngine({ store, now: () => now, randomIndex: () => 0 });
  const auth = new AuthService({ store });
  auth.createUser('admin', 'correct-password-123', 'admin');
  auth.createUser('operator', 'operator-password-123', 'operator');
  const media = new MediaService({ env: { REHEARSAL_MODE: 'on' }, now: () => now });
  const judge = new JudgeService({ engine, vision: { enabled: () => false }, now: () => now });
  const integrations = new Integrations({ store, engine, media, env: {} });
  engine.telemetry = integrations;
  const googleAuth = options.googleAuthFactory?.({ store, auth });
  const server = createHttpServer({ store, engine, auth, media, judge, integrations,
    defaultSlug: event.slug, googleAuth });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = 'GET', body, token, cookie, csrf, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };
    if (token) init.headers.Authorization = `Bearer ${token}`;
    if (cookie) init.headers.Cookie = cookie;
    if (csrf) init.headers['X-CSRF-Token'] = csrf;
    if (body !== undefined) {
      if (Buffer.isBuffer(body)) { init.body = body; init.headers['Content-Type'] = 'image/jpeg'; }
      else { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    }
    const response = await fetch(base + path, init);
    const contentType = response.headers.get('content-type') || '';
    const value = contentType.includes('application/json') ? await response.json()
      : contentType.includes('text/csv') ? Buffer.from(await response.arrayBuffer()).toString('utf8')
      : await response.text();
    return { response, value };
  }
  async function attemptLogin(username, password) {
    return request('/api/auth/login', { method: 'POST', body: { username, password } });
  }
  async function login(username = 'admin', password = 'correct-password-123') {
    const { response, value } = await attemptLogin(username, password);
    assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: value.csrfToken, user: value.user };
  }
  async function join(alias) {
    const result = await request(`/api/e/${event.slug}/join`, { method: 'POST', body: { alias, displayConsent: true } });
    assert.equal(result.response.status, 201);
    return result.value;
  }
  async function ready(player) {
    await request(`/api/e/${event.slug}/media-token`, { token: player.token });
    return request(`/api/e/${event.slug}/ready`, { method: 'POST', token: player.token });
  }
  return {
    store, event, engine, auth, media, integrations, base, request, attemptLogin, login, join, ready,
    get now() { return now; }, set now(value) { now = value; },
    async close() { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); store.close(); },
  };
}

test('public HTML/API/SSE seal the clue through countdown, and concurrent clients get distinct slots', async () => {
  const app = await fixture({ minPlayers: 2, maxPlayers: 2, startMode: 'capacity' });
  try {
    const initial = await app.request(`/api/e/${app.event.slug}`);
    assert.equal(initial.response.status, 200);
    assert.equal(Object.hasOwn(initial.value.event, 'prompts'), false);
    assert.equal(Object.hasOwn(initial.value.state, 'prompt'), false);
    const html = await app.request(`/e/${app.event.slug}/arena`);
    assert.equal(html.response.status, 200);
    assert.equal(html.value.includes('SHOW SOMETHING RED'), false);
    const qr = await app.request(`/api/e/${app.event.slug}/qr.svg?target=play`);
    assert.equal(qr.response.status, 200);
    assert.match(qr.value, /<svg/);
    const sse = await fetch(`${app.base}/api/e/${app.event.slug}/stream`);
    const reader = sse.body.getReader();
    const firstChunk = new TextDecoder().decode((await reader.read()).value);
    assert.match(firstChunk, /event: state/);
    assert.equal(firstChunk.includes('SHOW SOMETHING RED'), false);
    await reader.cancel().catch(() => {});
    const [a, b, c] = await Promise.all(['Ada', 'Bea', 'Cy'].map(app.join));
    assert.deepEqual([a.player.slot, b.player.slot, c.player.slot], [1, 2, null]);
    assert.equal((await app.ready(a)).response.status, 200);
    assert.equal((await app.ready(b)).response.status, 200);
    const countdown = await app.request(`/api/e/${app.event.slug}`);
    assert.equal(countdown.value.state.phase, 'countdown');
    assert.equal(JSON.stringify(countdown.value).includes('SHOW SOMETHING RED'), false);
    app.now += 3000;
    const hunt = await app.request(`/api/e/${app.event.slug}`);
    assert.equal(hunt.value.state.prompt.text, 'SHOW SOMETHING RED');
    const queuedReady = await app.request(`/api/e/${app.event.slug}/ready`, { method: 'POST', token: c.token });
    assert.equal(queuedReady.response.status, 409);
  } finally { await app.close(); }
});

test('player replay reuses a finished session and leave ends it', async () => {
  const app = await fixture({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false });
  try {
    const first = await app.join('Ada'), second = await app.join('Bea');
    assert.equal((await app.ready(first)).response.status, 200);
    assert.equal((await app.ready(second)).response.status, 200);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    app.now += 3000;
    app.engine.tickAll();
    app.engine.command(app.event.slug, 'award', { winners: [first.player.id] }, { id: 'operator' });

    const replay = await app.request(`/api/e/${app.event.slug}/replay`, { method: 'POST', token: first.token });
    assert.equal(replay.response.status, 200);
    assert.equal(replay.value.player.id, first.player.id);
    assert.equal(replay.value.player.status, 'queued');
    assert.equal(replay.value.state.queuedCount, 1);
    assert.equal((await app.request(`/api/e/${app.event.slug}/replay`, { method: 'POST', token: first.token })).response.status, 200);
    assert.equal(app.store.listActivity(app.event.id).filter(row => row.type === 'player_joined').length, 3);

    app.engine.command(app.event.slug, 'nextHeat', {}, { id: 'operator' });
    const promoted = await app.request(`/api/e/${app.event.slug}/me`, { token: first.token });
    assert.equal(promoted.value.player.status, 'joined');
    assert.equal(promoted.value.player.slot, 1);
    assert.equal((await app.request(`/api/e/${app.event.slug}/leave`, { method: 'POST', token: first.token })).response.status, 200);
    assert.equal((await app.request(`/api/e/${app.event.slug}/replay`, { method: 'POST', token: first.token })).response.status, 401);
  } finally { await app.close(); }
});

test('old Signal Stadium links lead to the renamed event', async () => {
  const app = await fixture();
  try {
    const page = await fetch(`${app.base}/e/signal-stadium/arena?source=old-qr`, { redirect: 'manual' });
    assert.equal(page.status, 307);
    assert.equal(page.headers.get('location'), '/e/live-scavenger-hunt/arena?source=old-qr');
    const api = await fetch(`${app.base}/api/e/signal-stadium`, { redirect: 'manual' });
    assert.equal(api.status, 307);
    assert.equal(api.headers.get('location'), '/api/e/live-scavenger-hunt');
  } finally { await app.close(); }
});

test('every screen links to valid Twilio bug favicons in ICO and PNG sizes', async () => {
  const app = await fixture();
  try {
    const response = await fetch(`${app.base}/favicon.ico?v=2`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /image\/x-icon/);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.readUInt16LE(0), 0);
    assert.equal(bytes.readUInt16LE(2), 1);
    assert.equal(bytes.readUInt16LE(4), 3);
    for (const [index, size] of [16, 32, 48].entries()) {
      const entry = 6 + index * 16;
      const width = bytes.readUInt8(entry);
      const height = bytes.readUInt8(entry + 1);
      const bitCount = bytes.readUInt16LE(entry + 6);
      const frameLength = bytes.readUInt32LE(entry + 8);
      const frameStart = bytes.readUInt32LE(entry + 12);
      const maskLength = Math.ceil(size / 32) * 4 * size;
      const pixelLength = size * size * 4;
      assert.deepEqual([width, height, bytes.readUInt16LE(entry + 4), bitCount], [size, size, 1, 32]);
      assert.equal(frameLength, 40 + pixelLength + maskLength);
      assert.ok(frameStart >= 6 + 3 * 16);
      assert.ok(frameStart + frameLength <= bytes.length);
      assert.equal(bytes.readUInt32LE(frameStart), 40);
      assert.equal(bytes.readInt32LE(frameStart + 4), size);
      assert.equal(bytes.readInt32LE(frameStart + 8), size * 2);
      assert.equal(bytes.readUInt16LE(frameStart + 12), 1);
      assert.equal(bytes.readUInt16LE(frameStart + 14), bitCount);
      assert.equal(bytes.readUInt32LE(frameStart + 16), 0);
      const mask = bytes.subarray(frameStart + 40 + pixelLength, frameStart + frameLength);
      assert.ok(mask.every(value => value === 0));
    }
    for (const size of [16, 32, 48]) {
      const png = await fetch(`${app.base}/assets/twilio-bug-favicon-${size}.png?v=2`);
      assert.equal(png.status, 200);
      assert.match(png.headers.get('content-type'), /image\/png/);
      const frame = Buffer.from(await png.arrayBuffer());
      assert.deepEqual([...frame.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.equal(frame.readUInt32BE(16), size);
      assert.equal(frame.readUInt32BE(20), size);
    }
    for (const path of ['/login', `/e/${app.event.slug}/arena`, `/e/${app.event.slug}/play`,
      `/e/${app.event.slug}/vote`, `/e/${app.event.slug}/operator`, `/e/${app.event.slug}/metrics`]) {
      const html = await app.request(path);
      assert.equal(html.response.status, 200);
      assert.ok(html.value.includes('/favicon.ico?v=2'), path);
      for (const size of [16, 32, 48]) {
        assert.ok(html.value.includes(`/assets/twilio-bug-favicon-${size}.png?v=2`), path);
      }
      assert.ok(html.value.includes('/assets/twilio-bug-official.png?v=2'), path);
    }
  } finally { await app.close(); }
});

test('arena GitHub QR and link redirect to the fixed repo and record their referral source', async () => {
  const app = await fixture();
  try {
    const slug = app.event.slug;
    const options = { type: 'svg', margin: 1, width: 320,
      color: { dark: '#161E46', light: '#FFFFFFFF' } };
    const trackedUrl = new URL(`/e/${encodeURIComponent(slug)}/github?source=arena_qr`, app.base).toString();
    const liveQr = await app.request(`/api/e/${slug}/qr.svg?target=github`);
    const previewQr = await app.request(`/api/e/${slug}/qr.svg?target=github&preview=1`);
    assert.equal(liveQr.response.status, 200);
    assert.equal(previewQr.response.status, 200);
    assert.equal(liveQr.value, await QRCode.toString(trackedUrl, options));
    assert.equal(previewQr.value, await QRCode.toString('https://github.com/anthonyplusAI/twilio-live-scavenger-hunt', options));
    assert.equal(app.store.listActivity(app.event.id).filter(row => row.type === 'github_cta_opened').length, 0);
    assert.equal((await app.request(`/api/e/${slug}/qr.svg?target=github&preview=0`)).response.status, 400);

    const invalidSource = await fetch(`${app.base}/e/${slug}/github?source=anything`, { redirect: 'manual' });
    assert.equal(invalidSource.status, 400);
    const qrScan = await fetch(trackedUrl, { redirect: 'manual' });
    assert.equal(qrScan.status, 302);
    assert.equal(qrScan.headers.get('location'), 'https://github.com/anthonyplusAI/twilio-live-scavenger-hunt');
    const visitorCookie = qrScan.headers.get('set-cookie').split(';')[0];
    const linkClick = await fetch(`${app.base}/e/${slug}/github?source=arena_link`, {
      redirect: 'manual', headers: { Cookie: visitorCookie },
    });
    assert.equal(linkClick.status, 302);
    assert.equal(linkClick.headers.get('location'), qrScan.headers.get('location'));
    const activity = app.store.listActivity(app.event.id).filter(row => row.type === 'github_cta_opened');
    assert.deepEqual(activity.map(row => row.properties.source), ['arena_qr', 'arena_link']);
    assert.match(activity[0].properties.sessionId, /^[a-f0-9]{20}$/);
    assert.equal(activity[0].properties.sessionId, activity[1].properties.sessionId);
    const admin = await app.login();
    const report = await app.request(`/api/admin/report?event=${slug}`, { cookie: admin.cookie });
    assert.equal(report.value.summary.githubRepoClicks, 2);
    assert.deepEqual(report.value.summary.githubRepoClicksBySource,
      { phone: 0, spectator: 0, arenaQr: 1, arenaLink: 1 });
  } finally { await app.close(); }
});

test('admin role, CSRF, and revision checks protect configuration, reports, and operator commands', async () => {
  const app = await fixture({ minPlayers: 2, maxPlayers: 2, startMode: 'manual' });
  try {
    assert.equal((await app.request('/api/admin/events')).response.status, 401);
    const admin = await app.login();
    const session = await app.request('/api/auth/session', { cookie: admin.cookie });
    assert.equal(session.value.user.role, 'admin');
    const operator = await app.login('operator', 'operator-password-123');
    assert.equal((await app.request('/api/admin/report?event=all', { cookie: operator.cookie })).response.status, 403);
    const draft = { ...app.event, roundSeconds: 26 };
    const denied = await app.request(`/api/admin/e/${app.event.slug}`, {
      method: 'PUT', cookie: admin.cookie, body: { event: draft, expectedRevision: app.event.revision },
    });
    assert.equal(denied.response.status, 403);
    const saved = await app.request(`/api/admin/e/${app.event.slug}`, {
      method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
      body: { event: draft, expectedRevision: app.event.revision },
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.value.event.roundSeconds, 26);
    const stale = await app.request(`/api/admin/e/${app.event.slug}`, {
      method: 'PUT', cookie: admin.cookie, csrf: admin.csrf,
      body: { event: draft, expectedRevision: app.event.revision },
    });
    assert.equal(stale.response.status, 409);
    const command = await app.request(`/api/admin/e/${app.event.slug}/command`, {
      method: 'POST', cookie: operator.cookie, csrf: operator.csrf,
      body: { type: 'queuePrompt', payload: { promptId: 'C01' } },
    });
    assert.equal(command.response.status, 200);
    const preflight = await app.request(`/api/admin/e/${app.event.slug}/preflight`, { cookie: operator.cookie });
    assert.ok(preflight.value.checks.some(check => check.name === 'Twilio Video'));
  } finally { await app.close(); }
});

test('admin API creates, resets, and removes local operators with CSRF and session revocation', async () => {
  const app = await fixture();
  const firstPassword = randomBytes(32).toString('hex');
  const secondPassword = randomBytes(32).toString('hex');
  try {
    assert.equal((await app.request('/api/auth/providers')).value.google.enabled, false);
    assert.equal((await app.request('/api/admin/operators')).response.status, 401);
    const admin = await app.login();
    const ordinary = await app.login('operator', 'operator-password-123');
    assert.equal((await app.request('/api/admin/operators', { cookie: ordinary.cookie })).response.status, 403);
    assert.equal((await app.request('/api/admin/operators', { method: 'POST', cookie: admin.cookie,
      body: { username: 'floorhost', password: firstPassword } })).response.status, 403);
    const created = await app.request('/api/admin/operators', { method: 'POST', cookie: admin.cookie,
      csrf: admin.csrf, body: { username: 'floorhost', password: firstPassword, role: 'admin' } });
    assert.equal(created.response.status, 201);
    assert.equal(created.value.operator.role, 'operator');
    assert.equal(created.value.operator.authProvider, 'password');
    assert.equal(JSON.stringify(created.value).includes(firstPassword), false);
    const operatorId = created.value.operator.id;
    const listing = await app.request('/api/admin/operators', { cookie: admin.cookie });
    assert.ok(listing.value.operators.some(operator => operator.id === operatorId));
    const firstSession = await app.login('floorhost', firstPassword);
    assert.equal((await app.request(`/api/admin/operators/${operatorId}/password`, { method: 'POST',
      cookie: ordinary.cookie, csrf: ordinary.csrf, body: { password: secondPassword } })).response.status, 403);
    const reset = await app.request(`/api/admin/operators/${operatorId}/password`, { method: 'POST',
      cookie: admin.cookie, csrf: admin.csrf, body: { password: secondPassword } });
    assert.equal(reset.response.status, 200);
    assert.equal((await app.request('/api/auth/session', { cookie: firstSession.cookie })).response.status, 401);
    const secondSession = await app.login('floorhost', secondPassword);
    const removed = await app.request(`/api/admin/operators/${operatorId}`, { method: 'DELETE',
      cookie: admin.cookie, csrf: admin.csrf });
    assert.equal(removed.response.status, 204);
    assert.equal((await app.request('/api/auth/session', { cookie: secondSession.cookie })).response.status, 401);
    assert.equal((await app.request('/api/admin/operators', { cookie: admin.cookie })).value.operators
      .some(operator => operator.id === operatorId), false);
    assert.equal((await app.request(`/api/admin/operators/${admin.user.id}`, { method: 'DELETE',
      cookie: admin.cookie, csrf: admin.csrf })).response.status, 404);
  } finally { await app.close(); }
});

test('a verified Google admin can reset the existing local admin password and rename its login', async () => {
  const app = await fixture();
  const replacementPassword = randomBytes(32).toString('hex');
  const stalePassword = randomBytes(32).toString('hex');
  try {
    const resetBody = {
      expectedUsername: 'admin',
      username: 'admin',
      password: replacementPassword,
    };
    const oldLocalSession = await app.login();
    const otherLocalSession = await app.login();
    const google = app.auth.loginGoogleIdentity({ sub: 'credential-editor', email: 'editor@twilio.com',
      emailVerified: true, hostedDomain: 'twilio.com' });
    const googleCookie = app.auth.cookie(google.token).split(';')[0];
    const before = app.store.sql.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    const path = '/api/admin/local-admin';
    const initial = await app.request(path, { cookie: googleCookie });
    assert.equal(initial.response.status, 200);
    assert.deepEqual(initial.value.admin, { id: oldLocalSession.user.id,
      username: 'admin', role: 'admin', authProvider: 'password' });

    const reset = await app.request(path, { method: 'POST', cookie: googleCookie,
      csrf: google.csrfToken, body: resetBody });
    assert.equal(reset.response.status, 200);
    assert.equal(reset.value.admin.id, oldLocalSession.user.id);
    assert.equal(reset.value.admin.username, 'admin');
    assert.equal(reset.value.usernameChanged, false);
    assert.equal(reset.value.passwordChanged, true);
    assert.equal(reset.value.signedOut, false);
    assert.equal(JSON.stringify(reset.value).includes(replacementPassword), false);
    assert.equal(app.store.sql.prepare('SELECT COUNT(*) AS count FROM users').get().count, before);
    assert.equal((await app.request('/api/auth/session', { cookie: oldLocalSession.cookie })).response.status, 401);
    assert.equal((await app.request('/api/auth/session', { cookie: otherLocalSession.cookie })).response.status, 401);
    assert.equal((await app.request('/api/auth/session', { cookie: googleCookie })).response.status, 200);
    assert.equal((await app.attemptLogin('admin', 'correct-password-123')).response.status, 401);
    const freshLocalSession = await app.login('admin', replacementPassword);

    const rename = await app.request(path, { method: 'POST', cookie: googleCookie,
      csrf: google.csrfToken, body: { expectedUsername: 'admin', username: 'newadmin' } });
    assert.equal(rename.response.status, 200);
    assert.equal(rename.value.admin.id, oldLocalSession.user.id);
    assert.equal(rename.value.admin.username, 'newadmin');
    assert.equal(rename.value.usernameChanged, true);
    assert.equal(rename.value.passwordChanged, false);
    assert.equal(rename.value.signedOut, false);
    assert.equal((await app.request('/api/auth/session', { cookie: freshLocalSession.cookie })).response.status, 401);
    assert.equal((await app.request('/api/auth/session', { cookie: googleCookie })).response.status, 200);
    assert.equal((await app.attemptLogin('admin', replacementPassword)).response.status, 401);
    assert.equal((await app.attemptLogin('newadmin', replacementPassword)).response.status, 200);
    assert.equal(app.store.sql.prepare('SELECT COUNT(*) AS count FROM users').get().count, before);

    const stale = await app.request(path, { method: 'POST', cookie: googleCookie,
      csrf: google.csrfToken, body: {
        expectedUsername: 'admin',
        username: 'admin',
        password: stalePassword,
      } });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.value.code, 'admin_changed');
    assert.equal((await app.attemptLogin('newadmin', replacementPassword)).response.status, 200);
    assert.equal((await app.attemptLogin('newadmin', stalePassword)).response.status, 401);
    assert.equal((await app.request('/api/auth/session', { cookie: googleCookie })).response.status, 200);

    const audits = app.store.sql.prepare("SELECT user_id,details_json FROM audit WHERE action='admin:local_credentials_changed' ORDER BY at").all();
    assert.equal(audits.length, 2);
    assert.ok(audits.every(entry => entry.user_id === google.user.id));
    assert.deepEqual(audits.map(entry => JSON.parse(entry.details_json)), [
      { targetUserId: oldLocalSession.user.id, usernameChanged: false, passwordChanged: true },
      { targetUserId: oldLocalSession.user.id, usernameChanged: true, passwordChanged: false },
    ]);
    assert.equal(audits.some(entry => entry.details_json.includes(replacementPassword)), false);
  } finally { await app.close(); }
});

test('editing the local admin requires an admin session and CSRF, rejects collisions, and signs out a local caller', async () => {
  const app = await fixture();
  const replacementPassword = 'x';
  try {
    const resetBody = {
      expectedUsername: 'admin',
      username: 'admin',
      password: replacementPassword,
    };
    const collisionBody = {
      expectedUsername: 'admin',
      username: 'operator',
      password: replacementPassword,
    };
    const path = '/api/admin/local-admin';
    const admin = await app.login();
    const operator = await app.login('operator', 'operator-password-123');
    assert.equal((await app.request(path)).response.status, 401);
    assert.equal((await app.request(path, { cookie: operator.cookie })).response.status, 403);
    assert.equal((await app.request(path, { method: 'POST', body: resetBody })).response.status, 401);
    assert.equal((await app.request(path, { method: 'POST', cookie: operator.cookie, csrf: operator.csrf,
      body: resetBody })).response.status, 403);
    assert.equal((await app.request(path, { method: 'POST', cookie: admin.cookie,
      body: resetBody })).response.status, 403);
    const noChanges = await app.request(path, { method: 'POST', cookie: admin.cookie,
      csrf: admin.csrf, body: { username: ' ADMIN ' } });
    assert.equal(noChanges.response.status, 400);
    assert.equal(noChanges.value.code, 'no_changes');
    const blankPassword = await app.request(path, { method: 'POST', cookie: admin.cookie,
      csrf: admin.csrf, body: { username: 'admin', password: '' } });
    assert.equal(blankPassword.response.status, 400);
    assert.equal(blankPassword.value.code, 'invalid_password');
    const collision = await app.request(path, { method: 'POST', cookie: admin.cookie,
      csrf: admin.csrf, body: collisionBody });
    assert.equal(collision.response.status, 409);
    assert.equal(collision.value.code, 'username_exists');
    assert.equal((await app.request('/api/auth/session', { cookie: admin.cookie })).response.status, 200);
    assert.equal((await app.attemptLogin('admin', 'correct-password-123')).response.status, 200);
    assert.equal(app.store.sql.prepare("SELECT COUNT(*) AS count FROM audit WHERE action='admin:local_credentials_changed'").get().count, 0);

    const updated = await app.request(path, { method: 'POST', cookie: admin.cookie,
      csrf: admin.csrf, body: resetBody });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.value.signedOut, true);
    assert.match(updated.response.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await app.request('/api/auth/session', { cookie: admin.cookie })).response.status, 401);
    assert.equal((await app.attemptLogin('admin', replacementPassword)).response.status, 200);
  } finally { await app.close(); }
});

test('local admin credential edits are rate limited per admin account', async () => {
  const app = await fixture();
  try {
    const admin = await app.login();
    const path = '/api/admin/local-admin';
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await app.request(path, { method: 'POST', cookie: admin.cookie,
        csrf: admin.csrf, body: { username: 'admin' } });
      assert.equal(result.response.status, 400);
      assert.equal(result.value.code, 'no_changes');
    }
    const limited = await app.request(path, { method: 'POST', cookie: admin.cookie,
      csrf: admin.csrf, body: { username: 'admin' } });
    assert.equal(limited.response.status, 429);
    assert.equal(limited.value.code, 'rate_limited');
    assert.ok(Number(limited.response.headers.get('retry-after')) > 0);
  } finally { await app.close(); }
});

test('self-service password rotation verifies the old password and clears every session', async () => {
  const app = await fixture();
  const newPassword = randomBytes(32).toString('hex');
  try {
    const admin = await app.login();
    const secondSession = await app.login();
    assert.equal((await app.request('/api/auth/password', { method: 'POST', cookie: admin.cookie,
      body: { currentPassword: 'correct-password-123', newPassword } })).response.status, 403);
    assert.equal((await app.request('/api/auth/password', { method: 'POST', cookie: admin.cookie,
      csrf: admin.csrf, body: { currentPassword: 'wrong-password', newPassword } })).response.status, 403);
    const changed = await app.request('/api/auth/password', { method: 'POST', cookie: admin.cookie,
      csrf: admin.csrf, body: { currentPassword: 'correct-password-123', newPassword } });
    assert.equal(changed.response.status, 200);
    assert.match(changed.response.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await app.request('/api/auth/session', { cookie: admin.cookie })).response.status, 401);
    assert.equal((await app.request('/api/auth/session', { cookie: secondSession.cookie })).response.status, 401);
    assert.equal((await app.request('/api/auth/login', { method: 'POST', body: {
      username: 'admin', password: 'correct-password-123',
    } })).response.status, 401);
    assert.equal((await app.request('/api/auth/login', { method: 'POST', body: {
      username: 'admin', password: newPassword,
    } })).response.status, 200);
  } finally { await app.close(); }
});

test('passwords above the old HTTP limit work across create, reset, change, rename, and login', async () => {
  const app = await fixture();
  const first = 'p'.repeat(9_000);
  const second = 'q'.repeat(9_000);
  try {
    const admin = await app.login();
    const created = await app.request('/api/admin/operators', { method: 'POST', cookie: admin.cookie,
      csrf: admin.csrf, body: { username: 'longpass', password: first } });
    assert.equal(created.response.status, 201);
    assert.equal((await app.request('/api/auth/login', { method: 'POST',
      body: { username: 'longpass', password: first } })).response.status, 200);
    assert.equal((await app.request(`/api/admin/operators/${created.value.operator.id}/password`, {
      method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { password: second },
    })).response.status, 200);
    assert.equal((await app.request('/api/auth/login', { method: 'POST',
      body: { username: 'longpass', password: second } })).response.status, 200);
    const changed = await app.request('/api/auth/password', { method: 'POST', cookie: admin.cookie,
      csrf: admin.csrf, body: { currentPassword: 'correct-password-123', newPassword: first } });
    assert.equal(changed.response.status, 200);
    const relogged = await app.login('admin', first);
    const renamed = await app.request('/api/auth/username', { method: 'POST', cookie: relogged.cookie,
      csrf: relogged.csrf, body: { currentPassword: first, username: 'long.admin' } });
    assert.equal(renamed.response.status, 200);
    assert.equal((await app.request('/api/auth/login', { method: 'POST',
      body: { username: 'long.admin', password: first } })).response.status, 200);
  } finally { await app.close(); }
});

test('password rotation accepts two maximum-size passwords after JSON escaping', async () => {
  const app = await fixture();
  const currentPassword = '\0'.repeat(16_384);
  const newPassword = '\u0001'.repeat(16_384);
  try {
    const adminId = app.store.sql.prepare('SELECT id FROM users WHERE username=?').get('admin').id;
    app.auth.changePassword(adminId, 'correct-password-123', currentPassword);
    const admin = await app.login('admin', currentPassword);
    const changed = await app.request('/api/auth/password', { method: 'POST', cookie: admin.cookie,
      csrf: admin.csrf, body: { currentPassword, newPassword } });
    assert.equal(changed.response.status, 200);
    assert.equal((await app.request('/api/auth/login', { method: 'POST',
      body: { username: 'admin', password: currentPassword } })).response.status, 401);
    assert.equal((await app.request('/api/auth/login', { method: 'POST',
      body: { username: 'admin', password: newPassword } })).response.status, 200);
  } finally { await app.close(); }
});

test('self-service username change verifies password and revokes every active session', async () => {
  const app = await fixture();
  try {
    const admin = await app.login();
    const secondSession = await app.login();
    assert.equal((await app.request('/api/auth/username', { method: 'POST', cookie: admin.cookie,
      body: { currentPassword: 'correct-password-123', username: 'booth.admin' } })).response.status, 403);
    assert.equal((await app.request('/api/auth/username', { method: 'POST', cookie: admin.cookie,
      csrf: admin.csrf, body: { currentPassword: 'wrong-password', username: 'booth.admin' } })).response.status, 403);
    assert.equal((await app.request('/api/auth/username', { method: 'POST', cookie: admin.cookie,
      csrf: admin.csrf, body: { currentPassword: 'correct-password-123', username: 'operator' } })).response.status, 409);
    const changed = await app.request('/api/auth/username', { method: 'POST', cookie: admin.cookie,
      csrf: admin.csrf, body: { currentPassword: 'correct-password-123', username: ' BOOTH.ADMIN ' } });
    assert.equal(changed.response.status, 200);
    assert.equal(changed.value.user.id, admin.user.id);
    assert.equal(changed.value.user.username, 'booth.admin');
    assert.equal(changed.value.user.role, 'admin');
    assert.match(changed.response.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await app.request('/api/auth/session', { cookie: admin.cookie })).response.status, 401);
    assert.equal((await app.request('/api/auth/session', { cookie: secondSession.cookie })).response.status, 401);
    assert.equal((await app.request('/api/auth/login', { method: 'POST', body: {
      username: 'admin', password: 'correct-password-123',
    } })).response.status, 401);
    assert.equal((await app.request('/api/auth/login', { method: 'POST', body: {
      username: 'booth.admin', password: 'correct-password-123',
    } })).response.status, 200);
    const audit = app.store.sql.prepare("SELECT details_json FROM audit WHERE action='account:username_changed'").get();
    assert.ok(audit);
    assert.ok(!audit.details_json.includes('correct-password-123'));
  } finally { await app.close(); }
});

test('only admins can rename local operators and the old username stops working', async () => {
  const app = await fixture();
  try {
    const admin = await app.login();
    const operator = await app.login('operator', 'operator-password-123');
    const path = `/api/admin/operators/${operator.user.id}/username`;
    assert.equal((await app.request(path, { method: 'POST', body: { username: 'stagehost' } })).response.status, 401);
    assert.equal((await app.request(path, { method: 'POST', cookie: operator.cookie,
      csrf: operator.csrf, body: { username: 'stagehost' } })).response.status, 403);
    assert.equal((await app.request(path, { method: 'POST', cookie: admin.cookie,
      body: { username: 'stagehost' } })).response.status, 403);
    assert.equal((await app.request(path, { method: 'POST', cookie: admin.cookie,
      csrf: admin.csrf, body: { username: 'admin' } })).response.status, 409);
    const changed = await app.request(path, { method: 'POST', cookie: admin.cookie,
      csrf: admin.csrf, body: { username: ' STAGEHOST ' } });
    assert.equal(changed.response.status, 200);
    assert.equal(changed.value.operator.id, operator.user.id);
    assert.equal(changed.value.operator.username, 'stagehost');
    assert.equal((await app.request('/api/auth/session', { cookie: operator.cookie })).response.status, 401);
    assert.equal((await app.request('/api/auth/session', { cookie: admin.cookie })).response.status, 200);
    assert.equal((await app.request('/api/auth/login', { method: 'POST', body: {
      username: 'operator', password: 'operator-password-123',
    } })).response.status, 401);
    assert.equal((await app.request('/api/auth/login', { method: 'POST', body: {
      username: 'stagehost', password: 'operator-password-123',
    } })).response.status, 200);
    assert.equal((await app.request(`/api/admin/operators/${admin.user.id}/username`, { method: 'POST',
      cookie: admin.cookie, csrf: admin.csrf, body: { username: 'new-admin' } })).response.status, 404);
    const google = app.auth.loginGoogleIdentity({ sub: 'fixture-google', email: 'visitor@twilio.com',
      emailVerified: true, hostedDomain: 'twilio.com' });
    assert.equal((await app.request(`/api/admin/operators/${google.user.id}/username`, { method: 'POST',
      cookie: admin.cookie, csrf: admin.csrf, body: { username: 'new-google' } })).response.status, 404);
    const audit = app.store.sql.prepare("SELECT details_json FROM audit WHERE action='operator:username_changed'").get();
    assert.ok(audit);
    assert.ok(!audit.details_json.includes('operator-password-123'));
  } finally { await app.close(); }
});

test('Google callback creates an admin session only with matching browser state and verified claims', async () => {
  const fake = { options: null };
  const app = await fixture({}, { googleAuthFactory: ({ store, auth }) => new GoogleAuthService({
    store, auth, publicBaseUrl: 'http://127.0.0.1:12345', clientId: 'fixture-client', clientSecret: 'fixture-secret',
    client: {
      async generateCodeVerifierAsync() { return { codeVerifier: 'fixture-verifier', codeChallenge: 'fixture-challenge' }; },
      generateAuthUrl(options) {
        fake.options = options;
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.searchParams.set('state', options.state);
        return url.toString();
      },
      async getToken() { return { tokens: { id_token: 'fixture-id-token' } }; },
      async verifyIdToken() { return { getPayload: () => ({ iss: 'https://accounts.google.com',
        sub: 'fixture-google-sub', email: 'booth@twilio.com', email_verified: true, hd: 'twilio.com',
        nonce: fake.options.nonce }) }; },
    },
  }) });
  try {
    assert.equal((await app.request('/api/auth/providers')).value.google.enabled, true);
    const start = await fetch(`${app.base}/api/auth/google/start?next=%2Fe%2Flive-scavenger-hunt%2Foperator%23team`,
      { redirect: 'manual' });
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const flowCookie = start.headers.get('set-cookie').split(';')[0];
    const rejected = await fetch(`${app.base}/api/auth/google/callback?state=${state}&code=fixture`,
      { redirect: 'manual' });
    assert.equal(rejected.status, 302);
    assert.match(rejected.headers.get('location'), /error=google_failed/);
    const callback = await fetch(`${app.base}/api/auth/google/callback?state=${state}&code=fixture`,
      { redirect: 'manual', headers: { Cookie: flowCookie } });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/e/live-scavenger-hunt/operator#team');
    const sessionCookie = callback.headers.getSetCookie().find(cookie => cookie.startsWith('signal_stadium_session='))?.split(';')[0];
    assert.ok(sessionCookie);
    const session = await app.request('/api/auth/session', { cookie: sessionCookie });
    assert.equal(session.value.user.role, 'admin');
    assert.equal(session.value.user.username, 'booth@twilio.com');
    assert.equal((await app.request('/api/admin/operators', { cookie: sessionCookie })).response.status, 200);
    assert.equal((await app.request('/api/admin/report?event=all', { cookie: sessionCookie })).response.status, 200);
    const replay = await fetch(`${app.base}/api/auth/google/callback?state=${state}&code=fixture`,
      { redirect: 'manual', headers: { Cookie: flowCookie } });
    assert.match(replay.headers.get('location'), /error=google_failed/);
    assert.equal(app.store.sql.prepare("SELECT COUNT(*) AS count FROM users WHERE auth_provider='google'").get().count, 1);
  } finally { await app.close(); }
});

test('only authenticated booth staff can kick a player and the phone receives a distinct removal error', async () => {
  const app = await fixture({ minPlayers: 2, maxPlayers: 2, startMode: 'manual' });
  try {
    const removed = [];
    const disconnect = app.media.disconnectPlayer.bind(app.media);
    app.media.disconnectPlayer = async (event, player) => {
      removed.push(player.id);
      return disconnect(event, player);
    };
    const player = await app.join('Ada');
    const operator = await app.login('operator', 'operator-password-123');
    const path = `/api/admin/e/${app.event.slug}/command`;
    const body = { type: 'kickPlayer', payload: { playerId: player.player.id } };
    assert.equal((await app.request(path, { method: 'POST', body })).response.status, 401);
    assert.equal((await app.request(path, { method: 'POST', body, cookie: operator.cookie })).response.status, 403);
    const kicked = await app.request(path, { method: 'POST', body, cookie: operator.cookie, csrf: operator.csrf });
    assert.equal(kicked.response.status, 200);
    assert.equal(kicked.value.state.roster.length, 0);
    assert.equal(kicked.value.mediaDisconnect.status, 'ok');
    const me = await app.request(`/api/e/${app.event.slug}/me`, { token: player.token });
    assert.equal(me.response.status, 403);
    assert.equal(me.value.code, 'player_kicked');
    assert.equal((await app.request(`/api/e/${app.event.slug}/media-token`, { token: player.token })).response.status, 403);
    assert.deepEqual(removed, [player.player.id]);
  } finally { await app.close(); }
});

test('kick reports a Video disconnect failure while preserving the local removal', async () => {
  const app = await fixture({ startMode: 'manual' });
  const previousError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    app.media.disconnectPlayer = async () => { throw new Error('Twilio unavailable'); };
    const player = await app.join('Ada');
    const operator = await app.login('operator', 'operator-password-123');
    const result = await app.request(`/api/admin/e/${app.event.slug}/command`, {
      method: 'POST', cookie: operator.cookie, csrf: operator.csrf,
      body: { type: 'kickPlayer', payload: { playerId: player.player.id } },
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.value.mediaDisconnect.status, 'failed');
    assert.equal(app.store.getPlayer(player.player.id).status, 'kicked');
    assert.ok(logged.some(message => message.includes('Video disconnect for removed player')));
  } finally { console.error = previousError; await app.close(); }
});

test('public activity has a server-derived session, vote dedupes, and leads stay private in reports', async () => {
  const app = await fixture();
  try {
    const p = `/api/e/${app.event.slug}`;
    const malicious = await app.request(`${p}/activity`, { method: 'POST', body: { type: 'landing_opened', email: 'secret@example.com' } });
    assert.equal(malicious.response.status, 400);
    const opened = await app.request(`${p}/activity`, { method: 'POST', body: { type: 'landing_opened' } });
    assert.equal(opened.response.status, 200);
    const visitorCookie = opened.response.headers.get('set-cookie').split(';')[0];
    const productClick = await app.request(`${p}/activity`, { method: 'POST', cookie: visitorCookie, body: { type: 'twilio_product_link_opened', product: 'video' } });
    const githubClick = await app.request(`${p}/activity`, { method: 'POST', cookie: visitorCookie, body: { type: 'github_cta_opened' } });
    const phoneClick = await app.request(`${p}/activity`, { method: 'POST', cookie: visitorCookie, body: { type: 'github_cta_opened', source: 'phone' } });
    const spectatorClick = await app.request(`${p}/activity`, { method: 'POST', cookie: visitorCookie, body: { type: 'github_cta_opened', source: 'spectator' } });
    assert.equal(productClick.response.status, 200);
    assert.equal(githubClick.response.status, 200);
    assert.equal(phoneClick.response.status, 200);
    assert.equal(spectatorClick.response.status, 200);
    assert.equal((await app.request(`${p}/activity`, { method: 'POST', cookie: visitorCookie, body: { type: 'twilio_product_link_opened', product: 'email' } })).response.status, 400);
    assert.equal((await app.request(`${p}/activity`, { method: 'POST', cookie: visitorCookie, body: { type: 'github_cta_opened', product: 'video' } })).response.status, 400);
    assert.equal((await app.request(`${p}/activity`, { method: 'POST', cookie: visitorCookie, body: { type: 'github_cta_opened', source: 'arena_qr' } })).response.status, 400);
    const player = await app.join('Visitor');
    const lead = await app.request(`${p}/leads`, { method: 'POST', token: player.token,
      body: { intent: 'expert', fieldValues: { name: 'A Visitor', email: 'visitor@example.com', company: 'Example' }, marketingOptIn: false } });
    assert.equal(lead.response.status, 201);
    app.engine.command(app.event.slug, 'openVote', { type: 'category' }, { id: 'operator' });
    const vote = (await app.request(p)).value.state.vote;
    const first = await app.request(`${p}/votes`, { method: 'POST', cookie: visitorCookie,
      body: { windowId: vote.id, choice: vote.options[0].id } });
    assert.equal(first.response.status, 200);
    const duplicate = await app.request(`${p}/votes`, { method: 'POST', cookie: visitorCookie,
      body: { windowId: vote.id, choice: vote.options[1].id } });
    assert.equal(duplicate.response.status, 409);
    const publicState = JSON.stringify((await app.request(p)).value);
    assert.equal(publicState.includes('visitor@example.com'), false);
    const admin = await app.login();
    const report = await app.request(`/api/admin/report?event=${app.event.slug}`, { cookie: admin.cookie });
    assert.equal(report.response.status, 200);
    assert.equal(report.value.leads.length, 1);
    assert.equal(report.value.summary.votes, 1);
    assert.equal(report.value.summary.twilioProductLinkClicks, 1);
    assert.deepEqual(report.value.summary.twilioProductLinkClicksByProduct, { video: 1, messaging: 0, segment: 0 });
    assert.equal(report.value.summary.githubRepoClicks, 3);
    assert.deepEqual(report.value.summary.githubRepoClicksBySource,
      { phone: 2, spectator: 1, arenaQr: 0, arenaLink: 0 });
    assert.ok(report.value.activity.find(row => row.type === 'landing_opened')?.properties.sessionId);
    const exportResult = await app.request(`/api/admin/export?kind=leads&event=${app.event.slug}`, { cookie: admin.cookie });
    assert.equal(exportResult.response.status, 200);
    assert.ok(exportResult.value.startsWith('\ufeff'));
    assert.ok(exportResult.value.includes('visitor@example.com'));
  } finally { await app.close(); }
});

test('camera snapshots are available to a signed-in wall but not to an anonymous event visitor', async () => {
  const app = await fixture();
  try {
    const player = await app.join('Camera player');
    app.media.storeFrame(app.event.id, player.player.id, Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9]));
    const path = `/api/e/${app.event.slug}/frame/${player.player.id}`;
    assert.equal((await app.request(path)).response.status, 401);
    const operator = await app.login('operator', 'operator-password-123');
    const frame = await app.request(path, { cookie: operator.cookie });
    assert.equal(frame.response.status, 200);
    assert.match(frame.response.headers.get('content-type'), /image\/jpeg/);
  } finally { await app.close(); }
});

test('operator event stream stops exposing private state after logout', async () => {
  const app = await fixture();
  try {
    const operator = await app.login('operator', 'operator-password-123');
    const controller = new AbortController();
    const stream = await fetch(`${app.base}/api/admin/e/${app.event.slug}/stream`, {
      headers: { Cookie: operator.cookie }, signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    assert.match(initial, /event: state/);
    assert.match(initial, /"prompts"/);
    const logout = await app.request('/api/auth/logout', {
      method: 'POST', cookie: operator.cookie, csrf: operator.csrf,
    });
    assert.equal(logout.response.status, 200);
    app.engine.command(app.event.slug, 'queuePrompt', { promptId: 'C01' }, { id: 'operator' });
    const next = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Private stream did not close.')), 1500)),
    ]);
    assert.equal(next.done, true);
    controller.abort();
  } finally { await app.close(); }
});

test('a shared booth network can admit and count more than sixty visitors in a minute', async () => {
  const app = await fixture({ startMode: 'manual' });
  try {
    const path = `/api/e/${app.event.slug}`;
    const cookies = Array.from({ length: 80 }, (_, index) =>
      `signal_stadium_voter=${String(index).padStart(32, 'a')}`);
    const joined = await Promise.all(cookies.map((cookie, index) => app.request(`${path}/join`, {
      method: 'POST', cookie, body: { alias: `Guest ${index}`, displayConsent: true },
    })));
    assert.ok(joined.every(result => result.response.status === 201));
    app.engine.command(app.event.slug, 'openVote', { type: 'category' }, { id: 'operator' });
    const vote = (await app.request(path)).value.state.vote;
    const ballots = await Promise.all(cookies.map(cookie => app.request(`${path}/votes`, {
      method: 'POST', cookie, body: { windowId: vote.id, choice: vote.options[0].id },
    })));
    assert.ok(ballots.every(result => result.response.status === 200));
    assert.equal(app.store.listVotes(app.event.id, vote.id).length, 80);
  } finally { await app.close(); }
});
