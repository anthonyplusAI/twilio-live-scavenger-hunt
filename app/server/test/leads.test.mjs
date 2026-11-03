import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db.mjs';
import { GameEngine } from '../engine.mjs';
import { submitLead, validateLead } from '../leads.mjs';

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

test('dynamic lead fields save their field snapshot and stay separate from joining or voting', async () => {
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
