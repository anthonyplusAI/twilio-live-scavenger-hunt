import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { openDatabase } from '../db.mjs';
import { GameEngine } from '../engine.mjs';
import { AuthService } from '../auth.mjs';
import { MediaService } from '../media.mjs';
import { JudgeService } from '../judge.mjs';
import { Integrations } from '../integrations.mjs';
import { createHttpServer } from '../http.mjs';

async function fixture(changes = {}) {
  const store = openDatabase();
  let event = store.seedDefault();
  if (Object.keys(changes).length) event = store.saveEvent(event.slug, { ...event, ...changes }, event.revision);
  let now = Date.UTC(2026, 10, 2, 12);
  const engine = new GameEngine({ store, now: () => now });
  const auth = new AuthService({ store });
  auth.createUser('admin', 'correct-password-123', 'admin');
  auth.createUser('operator', 'operator-password-123', 'operator');
  const media = new MediaService({ env: { REHEARSAL_MODE: 'on' }, now: () => now });
  const judge = new JudgeService({ engine, vision: { enabled: () => false }, now: () => now });
  const integrations = new Integrations({ store, engine, media, env: {} });
  engine.telemetry = integrations;
  const server = createHttpServer({ store, engine, auth, media, judge, integrations, defaultSlug: event.slug });
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
  async function login(username = 'admin', password = 'correct-password-123') {
    const { response, value } = await request('/api/auth/login', { method: 'POST', body: { username, password } });
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
    store, event, engine, auth, media, integrations, base, request, login, join, ready,
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
