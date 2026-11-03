import { ValidationError } from './config.mjs';

const SAFE_ACTIVITY_KEYS = new Set([
  'sessionId', 'participantId', 'playerId', 'heatId', 'heat', 'playerCount', 'queued',
  'promptId', 'promptText', 'category', 'winners', 'isOverride', 'source',
  'timeToMatchMs', 'candidateCount', 'windowId', 'windowType', 'voterId',
  'channel', 'choice', 'choiceLabel', 'votes', 'promoted',
  'product',
]);
const PRODUCT_LINK_KEYS = ['video', 'messaging', 'segment'];
const ENGAGEMENT_TYPES = new Set([
  'player_joined', 'result_viewed', 'cta_opened', 'guide_cta_opened',
  'expert_cta_opened', 'twilio_product_link_opened', 'github_cta_opened',
  'lead_form_opened', 'lead_submitted', 'vote_accepted',
]);

function validateDate(value, label) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError(`${label} must be a YYYY-MM-DD date.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ValidationError(`${label} is not a valid date.`);
  }
  return value;
}

function resolveFilters(store, filters = {}) {
  const requested = filters.event ?? 'all';
  if (typeof requested !== 'string' || !requested) throw new ValidationError('Choose a valid event.');
  const allEvents = store.listEvents();
  let selectedEvents;
  if (requested === 'all') selectedEvents = allEvents;
  else {
    const selected = store.getEvent(requested);
    if (!selected) throw new ValidationError('Event not found.', 'not_found');
    selectedEvents = [selected];
  }
  const from = validateDate(filters.from, 'From date'), to = validateDate(filters.to, 'To date');
  if (from && to && from > to) throw new ValidationError('From date must be on or before to date.');
  const timeZone = requested === 'all' ? 'UTC' : selectedEvents[0].timeZone || 'UTC';
  let formatter;
  try { formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', calendar: 'gregory' }); }
  catch { throw new ValidationError('The selected event has an invalid time zone.'); }
  return { requested, allEvents, selectedEvents, eventId: requested === 'all' ? null : selectedEvents[0].id, from, to, timeZone, formatter };
}

function localDateKey(timestamp, formatter) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(formatter.formatToParts(date).filter(part => ['year', 'month', 'day'].includes(part.type)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function insideRange(timestamp, context) {
  if (!context.from && !context.to) return Number.isFinite(Date.parse(timestamp));
  const day = localDateKey(timestamp, context.formatter);
  return Boolean(day && (!context.from || day >= context.from) && (!context.to || day <= context.to));
}

function safeProperties(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!SAFE_ACTIVITY_KEYS.has(key)) continue;
    if (key === 'product' && !PRODUCT_LINK_KEYS.includes(value)) continue;
    if (typeof value === 'string') result[key] = value.slice(0, 200);
    else if (typeof value === 'boolean') result[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (Array.isArray(value)) result[key] = value.filter(item => typeof item === 'string' || typeof item === 'number').slice(0, 12).map(item => typeof item === 'string' ? item.slice(0, 80) : item);
  }
  return result;
}
function publicActivity(row) {
  return { id: row.id, eventId: row.eventId, type: row.type, at: row.at, properties: safeProperties(row.properties) };
}
function countDistinct(rows, keys) {
  const found = new Set();
  rows.forEach(row => {
    const id = keys.map(key => row.properties?.[key]).find(Boolean) || row.id;
    found.add(`${row.eventId}:${id}`);
  });
  return found.size;
}
function summaryFor(activity, leads) {
  const byType = type => activity.filter(row => row.type === type);
  const joins = byType('player_joined'), starts = byType('heat_started'), ends = byType('heat_completed'), votes = byType('vote_accepted');
  const cta = byType('cta_opened'), specificCta = [...byType('guide_cta_opened'), ...byType('expert_cta_opened')];
  const productLinks = byType('twilio_product_link_opened');
  const twilioProductLinkClicksByProduct = Object.fromEntries(PRODUCT_LINK_KEYS.map(product => [product, productLinks.filter(row => row.properties?.product === product).length]));
  const totalPlays = starts.reduce((sum, row) => sum + (Number(row.properties?.playerCount) || 0), 0);
  const heatsStarted = new Set(starts.map(row => `${row.eventId}:${row.properties?.heatId || row.id}`)).size;
  const voterIds = votes.map(row => row.properties?.voterId);
  return {
    totalEvents: activity.length,
    totalParticipants: joins.length,
    uniquePlayers: countDistinct(joins, ['playerId', 'participantId']),
    totalPlays,
    heatsStarted,
    heatsCompleted: new Set(ends.map(row => `${row.eventId}:${row.properties?.heatId || row.id}`)).size,
    readyPlayers: countDistinct(byType('player_ready'), ['playerId', 'participantId']),
    kickedPlayers: byType('player_kicked').length,
    timedOutPlayers: byType('player_timed_out').length,
    playerLeaves: byType('player_left').length,
    votes: votes.length,
    uniqueVoters: voterIds.every(Boolean) ? countDistinct(votes, ['voterId']) : null,
    categoryVotes: votes.filter(row => row.properties?.windowType === 'category').length,
    creativeVotes: votes.filter(row => row.properties?.windowType === 'creative').length,
    ballotVisitors: countDistinct(byType('vote_page_opened'), ['sessionId', 'participantId']),
    leads: leads.length,
    guideRequests: leads.filter(row => row.intent === 'guide').length,
    expertRequests: leads.filter(row => row.intent === 'expert').length,
    marketingOptIns: leads.filter(row => row.marketingOptIn === true).length,
    ctaClicks: cta.length || specificCta.length,
    twilioProductLinkClicks: productLinks.length,
    twilioProductLinkClicksByProduct,
    githubRepoClicks: byType('github_cta_opened').length,
    engagementActions: activity.filter(row => ENGAGEMENT_TYPES.has(row.type)).length,
    avgPlayersPerHeat: heatsStarted ? totalPlays / heatsStarted : 0,
  };
}

/** Return a private, filtered report. Date boundaries use the selected event's IANA time zone, or UTC for all events. */
export function buildReport(store, filters = {}) {
  const context = resolveFilters(store, filters);
  const activity = store.listActivity(context.eventId).filter(row => insideRange(row.at, context)).map(publicActivity);
  const leads = store.listLeads(context.eventId).filter(row => insideRange(row.createdAt, context));
  const eventRows = context.allEvents.map(event => ({
    id: event.id, slug: event.slug, name: event.name,
    revision: event.revision, timeZone: event.timeZone || 'UTC',
    leadCaptureEnabled: Boolean(event.leadCapture?.enabled),
    leadFieldCount: Array.isArray(event.leadCapture?.fields) ? event.leadCapture.fields.length : 0,
  }));
  const byEvent = context.selectedEvents.map(event => ({
    id: event.id, slug: event.slug, name: event.name, timeZone: event.timeZone || 'UTC',
    ...summaryFor(activity.filter(row => row.eventId === event.id), leads.filter(row => row.eventId === event.id)),
  }));
  const summary = { events: context.selectedEvents.length, ...summaryFor(activity, leads), byEvent };
  return { summary, activity, leads, events: eventRows };
}

function csvCell(value) {
  let text = value == null ? '' : typeof value === 'string' ? value : String(value);
  if (/^\s*[=+@-]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
function csvRows(headers, rows) { return `\ufeff${[headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`; }
function dynamicFieldIds(leads) {
  const ids = new Set();
  leads.forEach(lead => {
    for (const field of Array.isArray(lead.fieldSnapshot) ? lead.fieldSnapshot : []) if (typeof field?.id === 'string') ids.add(field.id);
    for (const id of Object.keys(lead.fieldValues || {})) ids.add(id);
  });
  return [...ids].sort((a, b) => a.localeCompare(b));
}
function valueForField(lead, id) {
  if (Object.hasOwn(lead.fieldValues || {}, id)) return lead.fieldValues[id];
  return lead[id] ?? '';
}

/** Export a UTF-8 BOM CSV with formula-safe cells; kind is `events` or `leads`. */
export function exportCsv(store, filters = {}) {
  if (!['events', 'leads'].includes(filters.kind)) throw new ValidationError('Choose a valid export kind.');
  const report = buildReport(store, filters), eventById = new Map(report.events.map(event => [event.id, event]));
  if (filters.kind === 'events') {
    const headers = [
      'timestamp', 'event_id', 'event_slug', 'event_name', 'type', 'engagement_action',
      'participant_id', 'player_id', 'session_id', 'heat_id', 'prompt_id', 'prompt_text',
      'category', 'window_id', 'window_type', 'choice', 'choice_label', 'channel', 'source', 'properties_json',
    ];
    const rows = report.activity.map(item => {
      const event = eventById.get(item.eventId) || {}, p = { ...(item.properties || {}) };
      // Creative choices are player IDs. Their display aliases can be real names,
      // so keep the alias in the private report but omit it from the activity CSV.
      if (p.windowType === 'creative') delete p.choiceLabel;
      return [
        item.at, item.eventId, event.slug, event.name, item.type, ENGAGEMENT_TYPES.has(item.type) ? 'yes' : 'no',
        p.participantId, p.playerId, p.sessionId, p.heatId, p.promptId, p.promptText,
        p.category, p.windowId, p.windowType, p.choice, p.choiceLabel, p.channel, p.source,
        JSON.stringify(p),
      ];
    });
    return csvRows(headers, rows);
  }
  const fieldIds = dynamicFieldIds(report.leads);
  const headers = [
    'created_at', 'event_id', 'event_slug', 'event_name', 'lead_id', 'intent',
    'participant_id', 'heat_id', 'name', 'email', 'phone', 'company',
    'marketing_opt_in', 'consent_version', 'delivery_status',
    'field_snapshot_json', 'field_values_json', ...fieldIds.map(id => `field:${id}`),
  ];
  const rows = report.leads.map(lead => {
    const event = eventById.get(lead.eventId) || {};
    return [
      lead.createdAt, lead.eventId, event.slug, event.name, lead.id, lead.intent,
      lead.participantId, lead.heatId, lead.name, lead.email, lead.phone, lead.company,
      lead.marketingOptIn ? 'yes' : 'no', lead.consentVersion, lead.deliveryStatus,
      JSON.stringify(lead.fieldSnapshot || []), JSON.stringify(lead.fieldValues || {}),
      ...fieldIds.map(id => valueForField(lead, id)),
    ];
  });
  return csvRows(headers, rows);
}
