import { randomUUID } from 'node:crypto';
import { ValidationError } from './config.mjs';

function fail(message, code = 'invalid_lead') { throw new ValidationError(message, code); }
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9() .-]{7,40}$/;

export function validateLead(event, player, input, state, now = new Date()) {
  const settings = event.leadCapture;
  if (!settings?.enabled) fail('Lead requests are turned off for this event.', 'lead_disabled');
  const intent = String(input?.intent || '');
  if (!['capture', 'guide', 'expert'].includes(intent) ||
      (intent === 'guide' && !settings.guideEnabled) ||
      (intent === 'expert' && !settings.expertEnabled))
    fail('This follow-up option is unavailable.', 'lead_disabled');
  const supplied = input?.fieldValues;
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) fail('Enter the requested fields.');
  const allowed = new Set(settings.fields.map(field => field.id));
  if (Object.keys(supplied).some(key => !allowed.has(key))) fail('The lead form changed. Reload and try again.', 'lead_form_changed');
  const fieldValues = {};
  let email = '', phone = '', name = '', company = '';
  for (const field of settings.fields) {
    const raw = supplied[field.id];
    if (raw != null && typeof raw !== 'string') fail(`${field.label} must be text.`);
    const value = String(raw || '').trim().replace(/\s+/g, ' ');
    const limit = field.type === 'email' ? 254 : field.type === 'tel' ? 40 : 160;
    if (value.length > limit || /[\x00-\x1f\x7f]/.test(value)) fail(`${field.label} is too long or contains invalid characters.`);
    if (field.required && !value) fail(`${field.label} is required.`);
    if (value && field.type === 'email' && !EMAIL.test(value)) fail(`Enter a valid ${field.label.toLowerCase()}.`);
    if (value && field.type === 'tel' && (!PHONE.test(value) || value.replace(/\D/g, '').length < 7)) fail(`Enter a valid ${field.label.toLowerCase()}.`);
    fieldValues[field.id] = value;
    if (field.type === 'email' && value && !email) email = value.toLowerCase();
    if (field.type === 'tel' && value && !phone) phone = value;
    if (/^(name|full-name)$/i.test(field.id)) name = value;
    if (/^company$/i.test(field.id)) company = value;
  }
  if (!email && !phone) fail('Provide an email or phone number for your request.');
  if (intent === 'guide' && !email) fail('Enter an email address to receive the build guide.');
  if (input.marketingOptIn != null && typeof input.marketingOptIn !== 'boolean')
    fail('Choose yes or no for product updates.');
  const marketingOptIn = input.marketingOptIn === true;
  if (marketingOptIn && (!settings.marketingOptIn || !email)) fail('Product updates require an email and an enabled opt-in.');
  return {
    id: randomUUID(), eventId: event.id, createdAt: now.toISOString(), intent,
    participantId: player.id, heatId: state.heatId || null,
    fieldValues, fieldSnapshot: structuredClone(settings.fields),
    name, email, phone, company, marketingOptIn,
    consentVersion: intent === 'capture' ? 'live-scavenger-hunt-join-v2' : 'signal-stadium-leads-v1',
    deliveryStatus: intent === 'capture' ? 'not-requested' : intent === 'expert' ? 'operator-follow-up' : 'pending-configuration',
  };
}

export async function submitLead({ store, engine, integrations, slug, token, input }) {
  const event = engine.event(slug);
  const player = engine.player(slug, token);
  const intent = String(input?.intent || '');
  if (!['guide', 'expert'].includes(intent)) fail('Choose a follow-up option.');
  if (!event.leadCapture?.enabled ||
      (intent === 'guide' && !event.leadCapture.guideEnabled) ||
      (intent === 'expert' && !event.leadCapture.expertEnabled))
    fail('This follow-up option is unavailable.', 'lead_disabled');
  const runtime = store.getRuntime(event.id) || { heatId: null };
  const captured = store.findCapturedLead(event.id, player.id);
  if (captured) {
    if (intent === 'guide' && !captured.email) fail('The build guide needs an email address.');
    let activity = null, updated = captured;
    store.transaction(() => {
      const current = store.getLead(captured.id);
      if (intent === 'guide' ? current.guideRequestedAt : current.expertRequestedAt) {
        updated = current;
        return;
      }
      updated = store.markLeadRequest(current.id, intent, new Date().toISOString(), runtime.heatId);
      activity = store.recordActivity(event.id, 'lead_submitted', {
        playerId: player.id, heatId: runtime.heatId, intent,
        marketingOptIn: updated.marketingOptIn,
      });
    });
    if (activity) integrations.track(activity);
    if (!activity) return {
      leadId: updated.id,
      deliveryStatus: intent === 'expert' ? 'operator-follow-up' : updated.deliveryStatus,
    };
    if (intent === 'expert') return { leadId: updated.id, deliveryStatus: 'operator-follow-up' };
    const status = await integrations.sendGuide({ ...updated, intent: 'guide' }, event);
    store.updateLeadDelivery(updated.id, status);
    return { leadId: updated.id, deliveryStatus: status };
  }

  // Sessions opened before the join form changed can still submit the old request form.
  const lead = validateLead(event, player, input, runtime);
  const stored = store.transaction(() => {
    const previous = store.findRecentLead(event.id, lead.intent, player.id, { email: lead.email, phone: lead.phone });
    if (previous) return { lead: previous, duplicate: true, activity: null };
    store.insertLead(lead);
    const activity = store.recordActivity(event.id, 'lead_submitted', {
      playerId: player.id, heatId: lead.heatId, intent: lead.intent, marketingOptIn: lead.marketingOptIn,
    });
    return { lead, duplicate: false, activity };
  });
  if (stored.activity) integrations.track(stored.activity);
  if (!stored.duplicate) {
    integrations.identifyOptedInLead(lead);
    const status = await integrations.sendGuide(lead, event);
    store.updateLeadDelivery(lead.id, status);
    return { leadId: lead.id, deliveryStatus: status };
  }
  return { leadId: stored.lead.id, deliveryStatus: stored.lead.deliveryStatus };
}
