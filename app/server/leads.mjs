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
  if (input.marketingOptIn != null && input.marketingOptIn !== false)
    fail('Email product updates are not offered on this form.');
  return {
    id: randomUUID(), eventId: event.id, createdAt: now.toISOString(), intent,
    participantId: player.id, heatId: state.heatId || null,
    fieldValues, fieldSnapshot: structuredClone(settings.fields),
    name, email, phone, company, marketingOptIn: false,
    consentVersion: intent === 'capture' ? 'live-scavenger-hunt-join-v3' : 'live-scavenger-hunt-leads-v2',
    deliveryStatus: intent === 'capture' ? 'not-requested' : intent === 'expert' ? 'operator-follow-up' : 'queued',
    expertStatus: intent === 'expert' ? 'pending' : 'not-requested',
  };
}

async function deliverGuide({ store, integrations, lead, event }) {
  const job = store.getDeliveryJobForLead(lead.id) || store.createDeliveryJob(lead.id, event.id);
  if (typeof integrations.dispatchDeliveryJob === 'function') {
    return await integrations.dispatchDeliveryJob(job.id);
  }
  // Small local integration stubs may implement only sendGuide. Production uses the durable dispatcher.
  try {
    const status = await integrations.sendGuide({ ...lead, intent: 'guide' }, event, job.id);
    store.updateDeliveryJob(job.id, { status: status === 'accepted' ? 'accepted' : 'waiting-config' });
    store.updateLeadDelivery(lead.id, status);
    return status;
  } catch {
    store.updateDeliveryJob(job.id, { status: 'needs-review', lastError: 'Guide request outcome is unknown.' });
    store.updateLeadDelivery(lead.id, 'needs-review');
    return 'needs-review';
  }
}

function canReuseLead(lead, intent, supplied) {
  if (intent === 'guide' ? !lead.email : !lead.email && !lead.phone) return false;
  if (!supplied) return true;
  if (lead.email !== supplied.email || lead.phone !== supplied.phone) return false;
  if (Object.keys(lead.fieldValues || {}).length !== Object.keys(supplied.fieldValues).length) return false;
  return Object.entries(supplied.fieldValues).every(([id, value]) =>
    String(lead.fieldValues?.[id] || '') === value);
}

export async function submitLead({ store, engine, integrations, slug, token, input }) {
  const event = engine.event(slug);
  const player = engine.player(slug, token);
  const intent = String(input?.intent || '');
  if (!['guide', 'expert'].includes(intent)) fail('Choose a follow-up option.');
  if (input?.marketingOptIn != null && input.marketingOptIn !== false)
    fail('Email product updates are not offered on this form.');
  if (!event.leadCapture?.enabled ||
      (intent === 'guide' && !event.leadCapture.guideEnabled) ||
      (intent === 'expert' && !event.leadCapture.expertEnabled))
    fail('This follow-up option is unavailable.', 'lead_disabled');
  const runtime = store.getRuntime(event.id) || { heatId: null };
  const supplied = Object.hasOwn(input || {}, 'fieldValues') ? validateLead(event, player, input, runtime) : null;
  const result = store.transaction(() => {
    const previous = store.listParticipantLeads(event.id, player.id);
    const candidates = previous.filter(lead => canReuseLead(lead, intent, supplied));
    const reusable = candidates.find(lead => intent === 'guide' ? lead.guideRequestedAt : lead.expertRequestedAt)
      || candidates[0];
    if (!reusable && !supplied && previous.length) {
      if (intent === 'guide') fail('The build guide needs an email address.');
      fail('Enter contact details for expert follow-up.');
    }
    const lead = reusable || supplied || validateLead(event, player, input, runtime);
    if (reusable && (intent === 'guide' ? lead.guideRequestedAt : lead.expertRequestedAt))
      return { lead, activity: null, inserted: false };
    const recentGuide = intent === 'guide' && store.hasRecentGuideRecipient(event.id, lead.email);
    const updated = reusable
      ? store.markLeadRequest(lead.id, intent, new Date().toISOString(), runtime.heatId)
      : (store.insertLead(lead), lead);
    if (intent === 'guide') {
      if (recentGuide) {
        store.updateLeadDelivery(updated.id, 'recent-request');
        updated.deliveryStatus = 'recent-request';
      } else store.createDeliveryJob(updated.id, event.id);
    }
    const activity = store.recordActivity(event.id, 'lead_submitted', {
      playerId: player.id, heatId: updated.heatId, intent,
      ...(player.analyticsSessionId ? { sessionId: player.analyticsSessionId } : {}),
    });
    return { lead: updated, activity, inserted: !reusable, recentGuide };
  });
  if (result.activity) integrations.track(result.activity);
  if (!result.activity) return { leadId: result.lead.id,
    deliveryStatus: intent === 'expert' ? 'operator-follow-up' : result.lead.deliveryStatus };
  if (intent === 'expert') return { leadId: result.lead.id, deliveryStatus: 'operator-follow-up' };
  if (result.recentGuide) return { leadId: result.lead.id, deliveryStatus: 'recent-request' };
  const status = await deliverGuide({ store, integrations, lead: result.lead, event });
  return { leadId: result.lead.id, deliveryStatus: status };
}

/** Voluntary spectator follow-up, keyed only by a server-derived browser session ID. */
export async function submitSpectatorLead({ store, engine, integrations, slug, sessionId, input }) {
  const event = engine.event(slug);
  if (!/^[a-f0-9]{20,64}$/i.test(String(sessionId || '')))
    fail('Spectator session required.', 'unauthorized');
  const intent = String(input?.intent || '');
  if (!['guide', 'expert'].includes(intent)) fail('Choose a follow-up option.');
  const runtime = store.getRuntime(event.id) || { heatId: null };
  const participantId = `spectator:${sessionId}`;
  const lead = validateLead(event, { id: participantId }, input, runtime);
  const stored = store.transaction(() => {
    const previous = store.findRecentLead(event.id, intent, participantId,
      { email: lead.email, phone: lead.phone }, 24 * 60 * 60);
    if (previous && canReuseLead(previous, intent, lead))
      return { lead: previous, duplicate: true, activity: null };
    const recentGuide = intent === 'guide' && store.hasRecentGuideRecipient(event.id, lead.email);
    if (recentGuide) lead.deliveryStatus = 'recent-request';
    store.insertLead(lead);
    if (intent === 'guide' && !recentGuide) store.createDeliveryJob(lead.id, event.id);
    const activity = store.recordActivity(event.id, 'lead_submitted', {
      sessionId, heatId: lead.heatId, intent, source: 'spectator',
    });
    return { lead, duplicate: false, activity, recentGuide };
  });
  if (stored.duplicate) return { leadId: stored.lead.id, deliveryStatus: stored.lead.deliveryStatus };
  integrations.track(stored.activity);
  const status = intent === 'expert' ? 'operator-follow-up' : stored.recentGuide ? 'recent-request'
    : await deliverGuide({ store, integrations, lead, event });
  return { leadId: lead.id, deliveryStatus: status };
}
