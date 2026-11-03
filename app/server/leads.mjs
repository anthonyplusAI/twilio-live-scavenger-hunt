import { randomUUID } from 'node:crypto';
import { ValidationError } from './config.mjs';

function fail(message, code = 'invalid_lead') { throw new ValidationError(message, code); }
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9() .-]{7,40}$/;

export function validateLead(event, player, input, state, now = new Date()) {
  const settings = event.leadCapture;
  if (!settings?.enabled) fail('Lead requests are turned off for this event.', 'lead_disabled');
  const intent = String(input?.intent || '');
  if ((intent !== 'guide' || !settings.guideEnabled) && (intent !== 'expert' || !settings.expertEnabled))
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
  if (input.marketingOptIn != null && input.marketingOptIn !== false)
    fail('Email product updates are not offered on this form.');
  return {
    id: randomUUID(), eventId: event.id, createdAt: now.toISOString(), intent,
    participantId: player.id, heatId: state.heatId || null,
    fieldValues, fieldSnapshot: structuredClone(settings.fields),
    name, email, phone, company, marketingOptIn: false,
    consentVersion: 'live-scavenger-hunt-leads-v2',
    deliveryStatus: intent === 'expert' ? 'operator-follow-up' : 'pending-configuration',
  };
}

export async function submitLead({ store, engine, integrations, slug, token, input }) {
  const event = engine.event(slug);
  const player = engine.player(slug, token);
  const runtime = store.getRuntime(event.id) || { heatId: null };
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
    const status = await integrations.sendGuide(lead, event);
    store.updateLeadDelivery(lead.id, status);
    return { leadId: lead.id, deliveryStatus: status };
  }
  return { leadId: stored.lead.id, deliveryStatus: stored.lead.deliveryStatus };
}
