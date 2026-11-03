import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db.mjs';
import { GameEngine } from '../engine.mjs';
import { submitLead, submitSpectatorLead, validateLead } from '../leads.mjs';
import { buildReport } from '../report.mjs';

function setup() {
  const store = openDatabase();
  const event = store.seedDefault();
  const engine = new GameEngine({ store });
  const joined = engine.join(event.slug, { alias: 'Visitor', displayConsent: true });
  const tracked = [];
  const integrations = {
    track(item) { tracked.push(item); },
    async sendGuide(lead) { return lead.intent === 'expert' ? 'operator-follow-up' : 'pending-configuration'; },
  };
  return { store, event, engine, joined, tracked, integrations };
}

test('existing lead rows survive the follow-up timestamp migration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'scavenger-leads-migration-'));
  const filename = join(directory, 'legacy.sqlite');
  try {
    const old = new DatabaseSync(filename);
    old.exec('CREATE TABLE leads (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, created_at TEXT NOT NULL, intent TEXT NOT NULL, participant_id TEXT NOT NULL, heat_id TEXT, field_values_json TEXT NOT NULL, field_snapshot_json TEXT NOT NULL, name TEXT, email TEXT, phone TEXT, company TEXT, marketing_opt_in INTEGER NOT NULL, consent_version TEXT NOT NULL, delivery_status TEXT NOT NULL)');
    old.prepare('INSERT INTO leads(id,event_id,created_at,intent,participant_id,field_values_json,field_snapshot_json,marketing_opt_in,consent_version,delivery_status) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('legacy-guide', 'old-event', '2026-11-01T12:00:00.000Z', 'guide', 'old-player', '{}', '[]', 0, 'v1', 'pending');
    old.close();
    const store = openDatabase(filename);
    try {
      const columns = new Set(store.sql.prepare('PRAGMA table_info(leads)').all().map(column => column.name));
      assert.ok(columns.has('guide_requested_at'));
      assert.ok(columns.has('expert_requested_at'));
      assert.equal(store.getLead('legacy-guide').guideRequestedAt, '2026-11-01T12:00:00.000Z');
      store.markLeadRequest('legacy-guide', 'expert', '2026-11-02T12:00:00.000Z');
      assert.equal(store.getLead('legacy-guide').expertRequestedAt, '2026-11-02T12:00:00.000Z');
    } finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('legacy player sessions can still request a guide with a saved field snapshot', async () => {
  const app = setup();
  assert.equal(app.store.listLeads().length, 0);
  let current = app.store.saveEvent(app.event.slug, { ...app.event, leadCapture: {
    ...app.event.leadCapture, fields: [
      { id: 'name', label: 'Name', type: 'text', required: true },
      { id: 'email', label: 'Work email', type: 'email', required: true },
      { id: 'favorite-tool', label: 'Favorite tool', type: 'text', required: false },
    ],
  } }, app.event.revision);
  const result = await submitLead({ store: app.store, engine: app.engine, integrations: app.integrations,
    slug: app.event.slug, token: app.joined.token, input: {
      intent: 'guide', fieldValues: { name: 'A Visitor', email: 'a@example.com', 'favorite-tool': 'Studio' },
    } });
  assert.equal(result.deliveryStatus, 'pending-configuration');
  const lead = app.store.getLead(result.leadId);
  assert.equal(lead.fieldValues['favorite-tool'], 'Studio');
  assert.ok(lead.fieldSnapshot.some(field => field.id === 'favorite-tool'));
  assert.equal(lead.marketingOptIn, false);
  assert.equal(app.tracked.length, 1);
  current = app.store.saveEvent(app.event.slug, { ...current, leadCapture: {
    ...current.leadCapture, fields: [
      { id: 'name', label: 'Name', type: 'text', required: true },
      { id: 'email', label: 'Work email', type: 'email', required: true },
    ],
  } }, current.revision);
  assert.equal(app.store.getLead(result.leadId).fieldSnapshot.length, 3);
  assert.equal(current.leadCapture.fields.length, 2);
  app.store.close();
});

test('lead validation rejects unknown fields, missing contact, invalid email, and legacy marketing opt-in', () => {
  const app = setup();
  const state = app.store.getRuntime(app.event.id);
  const player = app.engine.player(app.event.slug, app.joined.token);
  const base = { intent: 'expert', fieldValues: { name: 'A Visitor', email: 'a@example.com' } };
  assert.throws(() => validateLead(app.event, player, { ...base, fieldValues: { ...base.fieldValues, secret: 'no' } }, state),
    error => error.code === 'lead_form_changed');
  assert.throws(() => validateLead(app.event, player, { ...base, fieldValues: { name: 'A Visitor', email: 'bad' } }, state),
    error => error.code === 'invalid_lead');
  assert.throws(() => validateLead(app.event, player, { ...base, fieldValues: { name: 'A Visitor', email: '' } }, state),
    error => error.code === 'invalid_lead');
  const phoneEvent = { ...app.event, leadCapture: { ...app.event.leadCapture,
    fields: [{ id: 'phone', label: 'Phone', type: 'tel', required: true }] } };
  assert.throws(() => validateLead(phoneEvent, player, { intent: 'expert', fieldValues: { phone: '+1 555 222 3333' }, marketingOptIn: true }, state),
    error => error.code === 'invalid_lead');
  assert.throws(() => validateLead(app.event, player, { ...base, marketingOptIn: true }, state),
    error => error.code === 'invalid_lead');
  assert.throws(() => validateLead(app.event, player, { ...base, intent: 'capture', marketingOptIn: true }, state),
    error => error.code === 'invalid_lead');
  assert.equal(validateLead(app.event, player, { ...base, intent: 'capture' }, state).marketingOptIn, false);
  assert.throws(() => validateLead(app.event, player, { ...base, marketingOptIn: 'false' }, state),
    error => error.code === 'invalid_lead');
  assert.throws(() => validateLead(phoneEvent, player, { intent: 'guide', fieldValues: { phone: '+1 555 222 3333' }, marketingOptIn: false }, state),
    error => error.code === 'invalid_lead');
  app.store.close();
});

test('a configured build guide always has a required email field', () => {
  const app = setup();
  assert.throws(() => app.store.saveEvent(app.event.slug, { ...app.event, leadCapture: {
    ...app.event.leadCapture,
    fields: [{ id: 'phone', label: 'Phone', type: 'tel', required: true }],
  } }, app.event.revision), error => error.code === 'invalid_input');
  const expertOnly = app.store.saveEvent(app.event.slug, { ...app.event, leadCapture: {
    ...app.event.leadCapture, guideEnabled: false,
    fields: [{ id: 'phone', label: 'Phone', type: 'tel', required: true }],
  } }, app.event.revision);
  assert.equal(expertOnly.leadCapture.guideEnabled, false);
  app.store.close();
});

test('lead capture can be turned off and repeated submission does not duplicate a lead', async () => {
  const app = setup();
  const input = { intent: 'expert', fieldValues: { name: 'A Visitor', email: 'a@example.com', company: 'Acme' } };
  const first = await submitLead({ store: app.store, engine: app.engine, integrations: app.integrations,
    slug: app.event.slug, token: app.joined.token, input });
  const second = await submitLead({ store: app.store, engine: app.engine, integrations: app.integrations,
    slug: app.event.slug, token: app.joined.token, input });
  assert.equal(second.leadId, first.leadId);
  assert.equal(app.store.listLeads().length, 1);
  const disabled = app.store.saveEvent(app.event.slug, { ...app.event,
    leadCapture: { ...app.event.leadCapture, enabled: false } }, app.event.revision);
  await assert.rejects(submitLead({ store: app.store, engine: app.engine, integrations: app.integrations,
    slug: disabled.slug, token: app.joined.token, input }), error => error.code === 'lead_disabled');
  app.store.close();
});

test('spectators can voluntarily request one guide and join the staff expert queue', async () => {
  const app = setup();
  const sessionId = 'b0a024f596bf04fd393d';
  const fields = { name: 'Spectator', email: 'spectator@example.com' };
  const guideInput = { intent: 'guide', fieldValues: fields, marketingOptIn: false };
  const guide = await submitSpectatorLead({ store: app.store, engine: app.engine,
    integrations: app.integrations, slug: app.event.slug, sessionId, input: guideInput });
  const repeated = await submitSpectatorLead({ store: app.store, engine: app.engine,
    integrations: app.integrations, slug: app.event.slug, sessionId, input: guideInput });
  assert.equal(guide.leadId, repeated.leadId);
  assert.ok(app.store.getDeliveryJobForLead(guide.leadId));
  const expert = await submitSpectatorLead({ store: app.store, engine: app.engine,
    integrations: app.integrations, slug: app.event.slug, sessionId,
    input: { intent: 'expert', fieldValues: fields, marketingOptIn: false } });
  assert.equal(app.store.getLead(expert.leadId).expertStatus, 'pending');
  const report = buildReport(app.store, { event: app.event.slug });
  assert.equal(report.summary.pendingExpertRequests, 1);
  assert.deepEqual(report.expertQueue.map(lead => lead.id), [expert.leadId]);
  assert.equal(app.store.setExpertFollowupStatus(expert.leadId, 'contacted').expertStatus, 'contacted');
  assert.equal(buildReport(app.store, { event: app.event.slug }).summary.pendingExpertRequests, 0);
  app.store.close();
});

test('previously unconfigured guide requests enter the durable queue once', () => {
  const app = setup();
  app.store.insertLead({ id: 'old-pending-guide', eventId: app.event.id,
    createdAt: new Date().toISOString(), intent: 'guide', participantId: 'old-visitor',
    fieldValues: { email: 'old@example.com' }, fieldSnapshot: [{ id: 'email', label: 'Email', type: 'email' }],
    email: 'old@example.com', marketingOptIn: false, consentVersion: 'v1',
    deliveryStatus: 'pending-configuration' });
  assert.equal(app.store.enqueuePreviouslyUnsentGuides(), 1);
  assert.equal(app.store.enqueuePreviouslyUnsentGuides(), 0);
  assert.equal(app.store.getDeliveryJobForLead('old-pending-guide').status, 'queued');
  app.store.close();
});

test('post-play expert and guide requests reuse one player lead in either order', async () => {
  for (const order of [['expert', 'guide'], ['guide', 'expert']]) {
    const app = setup();
    let sends = 0;
    app.integrations.sendGuide = async () => { sends++; return 'accepted'; };
    const first = await submitLead({ store: app.store, engine: app.engine,
      integrations: app.integrations, slug: app.event.slug, token: app.joined.token,
      input: { intent: order[0], fieldValues: { name: 'Visitor', email: 'visitor@example.com' }, marketingOptIn: false } });
    const second = await submitLead({ store: app.store, engine: app.engine,
      integrations: app.integrations, slug: app.event.slug, token: app.joined.token,
      input: { intent: order[1] } });
    const repeat = await submitLead({ store: app.store, engine: app.engine,
      integrations: app.integrations, slug: app.event.slug, token: app.joined.token,
      input: { intent: order[1], fieldValues: { name: 'Visitor', email: 'visitor@example.com' }, marketingOptIn: false } });
    assert.equal(second.leadId, first.leadId);
    assert.equal(repeat.leadId, first.leadId);
    assert.equal(app.store.listLeads(app.event.id).length, 1);
    assert.equal(app.store.getLead(first.leadId).expertStatus, 'pending');
    assert.equal(sends, 1);
    assert.equal(app.store.listActivity(app.event.id).filter(row => row.type === 'lead_submitted').length, 2);
    app.store.close();
  }
});

test('changed player contact details create a separate follow-up lead', async () => {
  const app = setup();
  const first = await submitLead({ store: app.store, engine: app.engine,
    integrations: app.integrations, slug: app.event.slug, token: app.joined.token,
    input: { intent: 'expert', fieldValues: { name: 'Visitor', email: 'visitor@example.com' }, marketingOptIn: false } });
  const second = await submitLead({ store: app.store, engine: app.engine,
    integrations: app.integrations, slug: app.event.slug, token: app.joined.token,
    input: { intent: 'guide', fieldValues: { name: 'Visitor', email: 'corrected@example.com' } } });
  assert.notEqual(second.leadId, first.leadId);
  assert.equal(app.store.getLead(first.leadId).email, 'visitor@example.com');
  assert.equal(app.store.getLead(second.leadId).email, 'corrected@example.com');
  assert.equal(app.store.getLead(second.leadId).marketingOptIn, false);
  app.store.close();
});

test('spectator dedupe preserves corrected contact details and changed form answers', async () => {
  const app = setup();
  const sessionId = 'b0a024f596bf04fd393d';
  const original = await submitSpectatorLead({ store: app.store, engine: app.engine,
    integrations: app.integrations, slug: app.event.slug, sessionId,
    input: { intent: 'expert', fieldValues: { name: 'Spectator', email: 'mistyped@example.com' }, marketingOptIn: false } });
  const corrected = await submitSpectatorLead({ store: app.store, engine: app.engine,
    integrations: app.integrations, slug: app.event.slug, sessionId,
    input: { intent: 'expert', fieldValues: { name: 'Spectator', email: 'correct@example.com' }, marketingOptIn: false } });
  const revised = await submitSpectatorLead({ store: app.store, engine: app.engine,
    integrations: app.integrations, slug: app.event.slug, sessionId,
    input: { intent: 'expert', fieldValues: { name: 'Spectator', email: 'correct@example.com', company: 'Second Company' } } });
  assert.notEqual(original.leadId, corrected.leadId);
  assert.notEqual(corrected.leadId, revised.leadId);
  assert.equal(app.store.getLead(corrected.leadId).email, 'correct@example.com');
  assert.equal(app.store.getLead(revised.leadId).fieldValues.company, 'Second Company');
  assert.equal(app.store.getLead(revised.leadId).marketingOptIn, false);
  app.store.close();
});

test('guide cooldown follows the event and recipient across spectator cookies and player sessions', async () => {
  const app = setup();
  let sends = 0;
  app.integrations.sendGuide = async () => { sends++; return 'accepted'; };
  const request = (sessionId, email) => submitSpectatorLead({ store: app.store, engine: app.engine,
    integrations: app.integrations, slug: app.event.slug, sessionId,
    input: { intent: 'guide', fieldValues: { name: 'Visitor', email }, marketingOptIn: false } });
  const first = await request('b0a024f596bf04fd393d', 'recipient@example.com');
  const second = await request('b0a024f596bf04fd393e', 'recipient@example.com');
  const player = await submitLead({ store: app.store, engine: app.engine,
    integrations: app.integrations, slug: app.event.slug, token: app.joined.token,
    input: { intent: 'guide', fieldValues: { name: 'Visitor', email: 'recipient@example.com' }, marketingOptIn: false } });
  const freshRecipient = await request('b0a024f596bf04fd393f', 'other@example.com');
  assert.equal(first.deliveryStatus, 'accepted');
  assert.equal(second.deliveryStatus, 'recent-request');
  assert.equal(player.deliveryStatus, 'recent-request');
  assert.equal(freshRecipient.deliveryStatus, 'accepted');
  assert.equal(sends, 2);
  assert.ok(app.store.getDeliveryJobForLead(first.leadId));
  assert.equal(app.store.getDeliveryJobForLead(second.leadId), null);
  assert.equal(app.store.getDeliveryJobForLead(player.leadId), null);
  app.store.close();
});
