import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import twilio from 'twilio';
import { openDatabase } from '../db.mjs';
import { GameEngine } from '../engine.mjs';
import { Integrations } from '../integrations.mjs';

const authToken = 'a-secret-for-webhook-signing';
const base = 'https://booth.example';
function setup() {
  const store = openDatabase();
  let event = store.seedDefault();
  event = store.saveEvent(event.slug, { ...event, vote: {
    ...event.vote, channels: { web: true, sms: true, whatsapp: true },
    smsSender: '+15551234567', whatsappSender: 'whatsapp:+15551234567', eventCode: 'STADIUM',
  } }, event.revision);
  const engine = new GameEngine({ store });
  const media = { roomName: (item, heat) => `${item.id}:${heat}` };
  const integrations = new Integrations({ store, engine, media, publicBaseUrl: base,
    env: { TWILIO_AUTH_TOKEN: authToken } });
  return { store, event, engine, integrations, media };
}
function signature(path, params) { return twilio.getExpectedTwilioSignature(authToken, `${base}${path}`, params); }

test('signed SMS and WhatsApp ballots route by sender/code, dedupe, and never create leads or contact metrics', () => {
  const app = setup();
  app.engine.command(app.event.slug, 'openVote', { type: 'category' }, { id: 'operator' });
  const path = '/webhooks/twilio/messaging';
  const sms = { MessageSid: 'SM111', From: '+15550001111', To: '+15551234567', Body: 'STADIUM 2' };
  const rejected = app.integrations.messagingWebhook({ path, signature: 'invalid', params: sms });
  assert.equal(rejected.status, 403);
  assert.equal(app.store.listVotes(app.event.id).length, 0);
  const accepted = app.integrations.messagingWebhook({ path, signature: signature(path, sms), params: sms });
  assert.equal(accepted.status, 200);
  assert.match(accepted.body, /Vote counted/);
  assert.equal(app.store.listVotes(app.event.id).length, 1);
  app.integrations.messagingWebhook({ path, signature: signature(path, sms), params: sms });
  assert.equal(app.store.listVotes(app.event.id).length, 1);
  const repeatSender = { ...sms, MessageSid: 'SM112', Body: 'STADIUM 1' };
  const duplicate = app.integrations.messagingWebhook({ path, signature: signature(path, repeatSender), params: repeatSender });
  assert.match(duplicate.body, /already voted/);
  const whatsapp = { MessageSid: 'SM113', From: 'whatsapp:+15550002222', To: 'whatsapp:+15551234567', Body: 'STADIUM 1' };
  const other = app.integrations.messagingWebhook({ path, signature: signature(path, whatsapp), params: whatsapp });
  assert.match(other.body, /Vote counted/);
  assert.equal(app.store.listVotes(app.event.id).length, 2);
  const crossChannel = { MessageSid: 'SM114', From: 'whatsapp:+15550001111', To: 'whatsapp:+15551234567', Body: 'STADIUM 1' };
  const cross = app.integrations.messagingWebhook({ path, signature: signature(path, crossChannel), params: crossChannel });
  assert.match(cross.body, /already voted/);
  assert.equal(app.store.listVotes(app.event.id).length, 2);
  assert.equal(app.store.listLeads(app.event.id).length, 0);
  assert.equal(JSON.stringify(app.store.listActivity(app.event.id)).includes('+1555'), false);
  app.store.close();
});

test('paused open SMS and WhatsApp ballots do not count messages and invite a retry after resume', () => {
  const app = setup();
  const path = '/webhooks/twilio/messaging';
  const send = params => app.integrations.messagingWebhook({ path, signature: signature(path, params), params });
  app.engine.command(app.event.slug, 'openVote', { type: 'category' }, { id: 'operator' });
  app.engine.command(app.event.slug, 'pause', {}, { id: 'operator' });
  const sms = { MessageSid: 'SM-paused-sms', From: '+15550001111', To: '+15551234567', Body: 'STADIUM 1' };
  const whatsapp = { MessageSid: 'SM-paused-whatsapp', From: 'whatsapp:+15550002222',
    To: 'whatsapp:+15551234567', Body: 'STADIUM 2' };
  for (const params of [sms, whatsapp]) {
    const reply = send(params);
    assert.equal(reply.status, 200);
    assert.match(reply.body, /Voting is paused.*not counted.*send your choice again/i);
  }
  assert.equal(app.store.listVotes(app.event.id).length, 0);
  app.engine.command(app.event.slug, 'resume', {}, { id: 'operator' });
  assert.match(send({ ...sms, MessageSid: 'SM-resumed-sms' }).body, /Vote counted/);
  assert.match(send({ ...whatsapp, MessageSid: 'SM-resumed-whatsapp' }).body, /Vote counted/);
  assert.equal(app.store.listVotes(app.event.id).length, 2);
  app.store.close();
});

test('SMS vote reply distinguishes a pause or final close racing after the initial snapshot', () => {
  const app = setup();
  const path = '/webhooks/twilio/messaging';
  const send = sid => {
    const params = { MessageSid: sid, From: '+15550003333', To: '+15551234567', Body: 'STADIUM 1' };
    return app.integrations.messagingWebhook({ path, signature: signature(path, params), params });
  };
  const castVote = app.engine.castVote.bind(app.engine);
  app.engine.command(app.event.slug, 'openVote', { type: 'category' }, { id: 'operator' });
  app.engine.castVote = (slug, input) => {
    app.engine.command(slug, 'pause', {}, { id: 'operator' });
    return castVote(slug, input);
  };
  assert.match(send('SM-racing-pause').body, /Voting is paused.*not counted.*send your choice again/i);
  assert.equal(app.store.listVotes(app.event.id).length, 0);

  app.engine.command(app.event.slug, 'resume', {}, { id: 'operator' });
  app.engine.castVote = (slug, input) => {
    app.engine.command(slug, 'closeVote', {}, { id: 'operator' });
    return castVote(slug, input);
  };
  assert.match(send('SM-racing-close').body, /That ballot closed/);
  assert.equal(app.store.listVotes(app.event.id).length, 0);
  app.store.close();
});

test('inbound ballots require exactly the effective event code and a displayed option number', () => {
  const app = setup();
  const event = app.store.saveEvent(app.event.slug, {
    ...app.event, vote: { ...app.event.vote, eventCode: '' },
  }, app.event.revision);
  app.engine.command(event.slug, 'openVote', { type: 'category' }, { id: 'operator' });
  const path = '/webhooks/twilio/messaging';
  const send = (sid, body) => {
    const params = { MessageSid: sid, From: '+15550003333', To: '+15551234567', Body: body };
    return app.integrations.messagingWebhook({ path, signature: signature(path, params), params });
  };
  const code = event.slug.replace(/-/g, '').toUpperCase();
  for (const [index, body] of ['2', 'WRONG 2', `${code} 2 EXTRA`, `${code} OBJECT`].entries()) {
    assert.match(send(`SM-invalid-${index}`, body).body, /event code|ballot number/i);
    assert.equal(app.store.listVotes(event.id).length, 0);
  }
  assert.match(send('SM-valid', `${code} 2`).body, /Vote counted/);
  assert.equal(app.store.listVotes(event.id).length, 1);
  app.store.close();
});

test('SMS sender matching accepts an optional plus and keeps short codes usable', () => {
  for (const [configured, inbound] of [['15551234567', '+15551234567'], ['12345', '12345']]) {
    const app = setup();
    const event = app.store.saveEvent(app.event.slug, {
      ...app.event, vote: { ...app.event.vote, smsSender: configured },
    }, app.event.revision);
    app.engine.command(event.slug, 'openVote', { type: 'category' }, { id: 'operator' });
    const path = '/webhooks/twilio/messaging';
    const params = { MessageSid: `SM-${configured}`, From: '+15550004444', To: inbound, Body: 'STADIUM 1' };
    const result = app.integrations.messagingWebhook({ path, signature: signature(path, params), params });
    assert.match(result.body, /Vote counted/);
    assert.equal(app.store.listVotes(event.id).length, 1);
    app.store.close();
  }
});

test('signed Video callbacks change only the matching player and deduplicate receipts', () => {
  const app = setup();
  const player = app.engine.join(app.event.slug, { alias: 'Ada', displayConsent: true }).player;
  const path = '/webhooks/twilio/video';
  const params = { StatusCallbackEvent: 'participant-connected', ParticipantIdentity: `p:${player.id}`,
    RoomName: app.media.roomName(app.event, player.heat), RoomSid: 'RM123',
    ParticipantSid: 'PA123', Timestamp: '2026-11-03T12:00:00.000Z', SequenceNumber: '1' };
  assert.equal(app.integrations.videoWebhook({ path, signature: 'bad', params }).status, 403);
  const signed = signature(path, params);
  assert.equal(app.integrations.videoWebhook({ path, signature: signed, params }).status, 200);
  assert.equal(app.store.getPlayer(player.id).mediaConnected, true);
  app.integrations.videoWebhook({ path, signature: signed, params });
  assert.equal(app.store.listActivity(app.event.id).filter(row => row.type === 'media_connected').length, 1);
  app.store.close();
});

test('Video callback timestamps and participant SIDs ignore a late old disconnect after camera reconnection', () => {
  const app = setup();
  const player = app.engine.join(app.event.slug, { alias: 'Ada', displayConsent: true }).player;
  const path = '/webhooks/twilio/video';
  const common = { ParticipantIdentity: `p:${player.id}`,
    RoomName: app.media.roomName(app.event, player.heat), RoomSid: 'RM-reconnect' };
  const deliver = params => app.integrations.videoWebhook({ path, signature: signature(path, params), params });
  deliver({ ...common, StatusCallbackEvent: 'participant-connected', ParticipantSid: 'PA-old',
    Timestamp: '2026-11-03T12:00:01.000Z', SequenceNumber: '10' });
  deliver({ ...common, StatusCallbackEvent: 'participant-connected', ParticipantSid: 'PA-new',
    Timestamp: '2026-11-03T12:00:03.000Z', SequenceNumber: '2' });
  deliver({ ...common, StatusCallbackEvent: 'participant-disconnected', ParticipantSid: 'PA-old',
    Timestamp: '2026-11-03T12:00:02.000Z', SequenceNumber: '99' });
  assert.equal(app.store.getPlayer(player.id).mediaConnected, true);
  deliver({ ...common, StatusCallbackEvent: 'participant-disconnected', ParticipantSid: 'PA-new',
    Timestamp: '2026-11-03T12:00:04.000Z', SequenceNumber: '1' });
  assert.equal(app.store.getPlayer(player.id).mediaConnected, false);
  deliver({ ...common, StatusCallbackEvent: 'participant-connected', ParticipantSid: 'PA-old',
    Timestamp: '2026-11-03T12:00:01.000Z', SequenceNumber: '11' });
  assert.equal(app.store.getPlayer(player.id).mediaConnected, false);
  app.store.close();
});

test('Segment adapter mirrors safe metrics without dynamic contact data and guide delivery stays unconfigured', async () => {
  const store = openDatabase();
  const event = store.seedDefault();
  const sent = [];
  const segmentClient = { on() {}, track(item) { sent.push(item); } };
  const integrations = new Integrations({ store, engine: null, media: null, segmentClient,
    env: {}, publicBaseUrl: base });
  integrations.track({ eventId: event.id, type: 'lead_submitted', at: new Date().toISOString(),
    properties: { playerId: 'player-1', email: 'person@example.com', fieldValues: { phone: '+1555123' }, intent: 'guide' } });
  assert.equal(sent.length, 1);
  assert.equal(JSON.stringify(sent).includes('person@example.com'), false);
  assert.equal(JSON.stringify(sent).includes('+1555123'), false);
  assert.equal(await integrations.sendGuide({ intent: 'guide', email: 'person@example.com' }, event), 'pending-configuration');
  store.close();
});

test('valid SendGrid credentials keep guide jobs queued until email delivery is explicitly enabled', async () => {
  for (const disabledValue of [undefined, '0']) {
    const store = openDatabase();
    const event = store.seedDefault();
    const leadId = `lead-paused-${disabledValue ?? 'unset'}`;
    store.insertLead({ id: leadId, eventId: event.id, createdAt: new Date().toISOString(),
      intent: 'guide', participantId: `player-${leadId}`, fieldValues: {}, fieldSnapshot: [],
      email: 'paused@example.com', marketingOptIn: false, consentVersion: 'v1', deliveryStatus: 'queued' });
    const job = store.createDeliveryJob(leadId, event.id);
    const env = { SENDGRID_API_KEY: 'test-key', SENDGRID_FROM_EMAIL: 'booth@example.com' };
    if (disabledValue !== undefined) env.SENDGRID_EMAIL_ENABLED = disabledValue;
    let calls = 0;
    const integrations = new Integrations({ store, engine: null, media: null, publicBaseUrl: base, env,
      fetchImpl: async () => { calls++; return { status: 202 }; } });

    assert.equal(await integrations.sendGuide({ intent: 'guide', email: 'paused@example.com' }, event),
      'pending-configuration');
    assert.equal(await integrations.dispatchDeliveryJob(job.id), 'pending-configuration');
    assert.equal(store.getDeliveryJob(job.id).status, 'waiting-config');
    assert.equal(store.getDeliveryJob(job.id).attempts, 0);
    assert.equal(store.getLead(leadId).deliveryStatus, 'pending-configuration');
    const updateLeadDelivery = store.updateLeadDelivery.bind(store);
    let redundantLeadUpdates = 0;
    store.updateLeadDelivery = (...args) => {
      redundantLeadUpdates++;
      return updateLeadDelivery(...args);
    };
    await integrations.processDueDeliveryJobs();
    assert.equal(redundantLeadUpdates, 0);
    store.updateLeadDelivery = updateLeadDelivery;
    assert.equal(calls, 0);
    const guideCheck = integrations.preflight(event).find(check => check.name === 'SendGrid guide');
    assert.equal(guideCheck.status, 'warning');
    assert.match(guideCheck.detail, /paused/i);

    env.SENDGRID_EMAIL_ENABLED = '1';
    await integrations.processDueDeliveryJobs();
    assert.equal(calls, 1);
    assert.equal(store.getDeliveryJob(job.id).status, 'accepted');
    assert.equal(store.getLead(leadId).deliveryStatus, 'accepted');
    assert.equal(integrations.preflight(event).find(check => check.name === 'SendGrid guide').status, 'ready');
    store.close();
  }
});

test('configured SendGrid guide delivery uses the Mail Send API with a verified sender address', async () => {
  const store = openDatabase();
  const event = store.seedDefault();
  let sent;
  const integrations = new Integrations({ store, engine: null, media: null, publicBaseUrl: base,
    env: { SENDGRID_EMAIL_ENABLED: '1', SENDGRID_API_KEY: 'test-key', SENDGRID_FROM_EMAIL: 'booth@example.com', SENDGRID_REGION: 'eu' },
    fetchImpl: async (url, options) => { sent = { url, options, body: JSON.parse(options.body) }; return { ok: true, status: 202 }; } });
  const status = await integrations.sendGuide({ intent: 'guide', name: 'Ada', email: 'ada@example.com' }, event, 'job-123');
  assert.equal(status, 'accepted');
  assert.equal(sent.url, 'https://api.eu.sendgrid.com/v3/mail/send');
  assert.equal(sent.options.headers.Authorization, 'Bearer test-key');
  assert.equal(sent.body.personalizations[0].to[0].email, 'ada@example.com');
  assert.equal(sent.body.from.email, 'booth@example.com');
  assert.deepEqual(sent.body.personalizations[0].custom_args, { lsh_job_id: 'job-123' });
  store.close();
});

test('Segment uses browser identity across anonymous activity without contact data', () => {
  const store = openDatabase();
  const event = store.seedDefault();
  const calls = [];
  const client = { on() {}, track(value) { calls.push(['track', value]); },
    identify() { assert.fail('new activity must remain anonymous'); } };
  const integrations = new Integrations({ store, engine: null, media: null, segmentClient: client,
    env: {}, publicBaseUrl: base });
  store.insertPlayer({ id: 'visitor-player', eventId: event.id, alias: 'Visitor', heat: 1, slot: 1,
    status: 'joined', mediaConnected: false, joinedAt: new Date().toISOString(),
    analyticsSessionId: 'anonymous-browser-1' }, 'token-hash-visitor');
  integrations.track({ id: 'a1', eventId: event.id, type: 'landing_opened', at: new Date().toISOString(),
    properties: { sessionId: 'anonymous-browser-1' } });
  integrations.track({ id: 'a2', eventId: event.id, type: 'player_joined', at: new Date().toISOString(),
    properties: { playerId: 'visitor-player' } });
  assert.equal(calls[0][1].anonymousId, 'anonymous-browser-1');
  assert.equal(calls[1][1].anonymousId, 'anonymous-browser-1');
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(calls.slice(0, 2)).includes('visitor@example.com'), false);
  store.close();
});

test('signed SendGrid events confirm delivery once and reject invalid signatures', () => {
  const store = openDatabase();
  const event = store.seedDefault();
  store.insertLead({ id: 'lead-1', eventId: event.id, createdAt: new Date().toISOString(),
    intent: 'guide', participantId: 'player-1', fieldValues: {}, fieldSnapshot: [],
    email: 'visitor@example.com', marketingOptIn: false, consentVersion: 'v1', deliveryStatus: 'accepted' });
  const job = store.createDeliveryJob('lead-1', event.id);
  store.updateDeliveryJob(job.id, { status: 'accepted' });
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const integrations = new Integrations({ store, engine: null, media: null, publicBaseUrl: base,
    env: { SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: publicKey } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = Buffer.from(JSON.stringify([{ sg_event_id: `signed-delivered-${'x'.repeat(150)}`, event: 'delivered',
    timestamp: Number(timestamp), custom_args: { lsh_job_id: job.id } }]));
  const signature = sign('sha256', Buffer.concat([Buffer.from(timestamp), rawBody]), pair.privateKey).toString('base64');
  assert.throws(() => integrations.handleSendGridEvents({ rawBody, timestamp, signature: 'bad' }),
    error => error.code === 'forbidden');
  const result = integrations.handleSendGridEvents({ rawBody, timestamp, signature });
  assert.equal(result.accepted, 1);
  assert.equal(store.getLead('lead-1').deliveryStatus, 'delivered');
  assert.equal(store.getDeliveryJob(job.id).status, 'delivered');
  const replay = integrations.handleSendGridEvents({ rawBody, timestamp, signature });
  assert.equal(replay.accepted, 0);
  store.close();
});

test('signed SendGrid bounce is terminal and a later processed callback cannot erase it', () => {
  const store = openDatabase();
  const event = store.seedDefault();
  store.insertLead({ id: 'lead-bounced', eventId: event.id, createdAt: new Date().toISOString(),
    intent: 'guide', participantId: 'player-bounced', fieldValues: {}, fieldSnapshot: [],
    email: 'bounced@example.com', marketingOptIn: false, consentVersion: 'v1', deliveryStatus: 'accepted' });
  const job = store.createDeliveryJob('lead-bounced', event.id);
  store.updateDeliveryJob(job.id, { status: 'accepted' });
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const integrations = new Integrations({ store, engine: null, media: null, publicBaseUrl: base,
    env: { SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: publicKey } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const deliver = (id, type) => {
    const rawBody = Buffer.from(JSON.stringify([{ sg_event_id: id, event: type,
      timestamp: Number(timestamp), email: 'bounced@example.com', lsh_job_id: job.id }]));
    const signature = sign('sha256', Buffer.concat([Buffer.from(timestamp), rawBody]), pair.privateKey).toString('base64');
    return integrations.handleSendGridEvents({ rawBody, timestamp, signature });
  };
  assert.equal(deliver('bounce-1', 'bounce').accepted, 1);
  assert.equal(store.getLead('lead-bounced').deliveryStatus, 'bounced');
  assert.equal(deliver('processed-late', 'processed').ignored, 1);
  assert.equal(store.getLead('lead-bounced').deliveryStatus, 'bounced');
  store.close();
});

test('guide delivery retries a rejected 429 and never calls Mail Send twice for one accepted job', async () => {
  const store = openDatabase();
  const event = store.seedDefault();
  store.insertLead({ id: 'lead-retry', eventId: event.id, createdAt: new Date().toISOString(),
    intent: 'guide', participantId: 'player-retry', fieldValues: {}, fieldSnapshot: [],
    email: 'retry@example.com', marketingOptIn: false, consentVersion: 'v1', deliveryStatus: 'queued' });
  const job = store.createDeliveryJob('lead-retry', event.id);
  let calls = 0;
  const integrations = new Integrations({ store, engine: null, media: null, publicBaseUrl: base,
    env: { SENDGRID_EMAIL_ENABLED: '1', SENDGRID_API_KEY: 'test-key', SENDGRID_FROM_EMAIL: 'booth@example.com' },
    fetchImpl: async () => ({ status: ++calls === 1 ? 429 : 202 }) });
  assert.equal(await integrations.dispatchDeliveryJob(job.id), 'retrying');
  const retry = store.getDeliveryJob(job.id);
  assert.equal(retry.status, 'retry');
  assert.equal(retry.attempts, 1);
  await integrations.processDueDeliveryJobs({ now: new Date(Date.parse(retry.nextAttemptAt) + 1) });
  assert.equal(store.getDeliveryJob(job.id).status, 'accepted');
  assert.equal(store.getLead('lead-retry').deliveryStatus, 'accepted');
  await integrations.processDueDeliveryJobs({ now: new Date(Date.now() + 86400_000) });
  assert.equal(calls, 2);
  store.close();
});

test('a SendGrid 503 waits for review and a signed callback can reconcile delivery without retry', async () => {
  const store = openDatabase();
  const event = store.seedDefault();
  store.insertLead({ id: 'lead-503', eventId: event.id, createdAt: new Date().toISOString(),
    intent: 'guide', participantId: 'player-503', fieldValues: {}, fieldSnapshot: [],
    email: 'ambiguous@example.com', marketingOptIn: false, consentVersion: 'v1', deliveryStatus: 'queued' });
  const job = store.createDeliveryJob('lead-503', event.id);
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  let calls = 0;
  const integrations = new Integrations({ store, engine: null, media: null, publicBaseUrl: base,
    env: { SENDGRID_EMAIL_ENABLED: '1', SENDGRID_API_KEY: 'test-key', SENDGRID_FROM_EMAIL: 'booth@example.com',
      SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: publicKey },
    fetchImpl: async () => { calls++; return { status: 503 }; } });

  assert.equal(await integrations.dispatchDeliveryJob(job.id), 'needs-review');
  assert.equal(store.getDeliveryJob(job.id).status, 'needs-review');
  assert.equal(store.getDeliveryJob(job.id).nextAttemptAt, null);
  assert.equal(store.getLead('lead-503').deliveryStatus, 'needs-review');
  await integrations.processDueDeliveryJobs({ now: new Date(Date.now() + 86400_000) });
  assert.equal(calls, 1);

  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = Buffer.from(JSON.stringify([{ sg_event_id: '503-delivered', event: 'delivered',
    email: 'ambiguous@example.com', custom_args: { lsh_job_id: job.id } }]));
  const signature = sign('sha256', Buffer.concat([Buffer.from(timestamp), rawBody]), pair.privateKey).toString('base64');
  assert.equal(integrations.handleSendGridEvents({ rawBody, timestamp, signature }).accepted, 1);
  assert.equal(store.getDeliveryJob(job.id).status, 'delivered');
  assert.equal(store.getLead('lead-503').deliveryStatus, 'delivered');
  store.close();
});

test('an ambiguous network outcome waits for staff review instead of risking a duplicate guide', async () => {
  const store = openDatabase();
  const event = store.seedDefault();
  store.insertLead({ id: 'lead-uncertain', eventId: event.id, createdAt: new Date().toISOString(),
    intent: 'guide', participantId: 'player-uncertain', fieldValues: {}, fieldSnapshot: [],
    email: 'uncertain@example.com', marketingOptIn: false, consentVersion: 'v1', deliveryStatus: 'queued' });
  const job = store.createDeliveryJob('lead-uncertain', event.id);
  let calls = 0;
  const integrations = new Integrations({ store, engine: null, media: null, publicBaseUrl: base,
    env: { SENDGRID_EMAIL_ENABLED: '1', SENDGRID_API_KEY: 'test-key', SENDGRID_FROM_EMAIL: 'booth@example.com' },
    fetchImpl: async () => { calls++; throw new Error('socket closed after write'); } });
  assert.equal(await integrations.dispatchDeliveryJob(job.id), 'needs-review');
  await integrations.processDueDeliveryJobs({ now: new Date(Date.now() + 86400_000) });
  assert.equal(calls, 1);
  assert.equal(store.getDeliveryJob(job.id).status, 'needs-review');
  store.close();
});

test('a process interruption during SendGrid dispatch is marked for review without replaying', async () => {
  const store = openDatabase();
  const event = store.seedDefault();
  store.insertLead({ id: 'lead-interrupted', eventId: event.id, createdAt: new Date().toISOString(),
    intent: 'guide', participantId: 'player-interrupted', fieldValues: {}, fieldSnapshot: [],
    email: 'interrupted@example.com', marketingOptIn: false, consentVersion: 'v1', deliveryStatus: 'queued' });
  const job = store.createDeliveryJob('lead-interrupted', event.id);
  store.claimDeliveryJob(job.id);
  let calls = 0;
  const integrations = new Integrations({ store, engine: null, media: null, publicBaseUrl: base,
    env: { SENDGRID_EMAIL_ENABLED: '1', SENDGRID_API_KEY: 'test-key', SENDGRID_FROM_EMAIL: 'booth@example.com' },
    fetchImpl: async () => { calls++; return { status: 202 }; } });
  await integrations.processDueDeliveryJobs({ now: new Date(Date.now() + 180_000) });
  assert.equal(store.getDeliveryJob(job.id).status, 'needs-review');
  assert.equal(store.getLead('lead-interrupted').deliveryStatus, 'needs-review');
  assert.equal(calls, 0);
  store.close();
});
