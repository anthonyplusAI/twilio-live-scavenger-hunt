import test from 'node:test';
import assert from 'node:assert/strict';
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
    RoomName: app.media.roomName(app.event, player.heat), RoomSid: 'RM123', SequenceNumber: '1' };
  assert.equal(app.integrations.videoWebhook({ path, signature: 'bad', params }).status, 403);
  const signed = signature(path, params);
  assert.equal(app.integrations.videoWebhook({ path, signature: signed, params }).status, 200);
  assert.equal(app.store.getPlayer(player.id).mediaConnected, true);
  app.integrations.videoWebhook({ path, signature: signed, params });
  assert.equal(app.store.listActivity(app.event.id).filter(row => row.type === 'media_connected').length, 1);
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

test('configured SendGrid guide delivery uses the Mail Send API with a verified sender address', async () => {
  const store = openDatabase();
  const event = store.seedDefault();
  let sent;
  const integrations = new Integrations({ store, engine: null, media: null, publicBaseUrl: base,
    env: { SENDGRID_API_KEY: 'test-key', SENDGRID_FROM_EMAIL: 'booth@example.com', SENDGRID_REGION: 'eu' },
    fetchImpl: async (url, options) => { sent = { url, options, body: JSON.parse(options.body) }; return { ok: true, status: 202 }; } });
  const status = await integrations.sendGuide({ intent: 'guide', name: 'Ada', email: 'ada@example.com' }, event);
  assert.equal(status, 'sent');
  assert.equal(sent.url, 'https://api.eu.sendgrid.com/v3/mail/send');
  assert.equal(sent.options.headers.Authorization, 'Bearer test-key');
  assert.equal(sent.body.personalizations[0].to[0].email, 'ada@example.com');
  assert.equal(sent.body.from.email, 'booth@example.com');
  store.close();
});
