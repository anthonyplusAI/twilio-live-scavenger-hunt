import { randomUUID } from 'node:crypto';
import { promptBank } from './seed.mjs';

export const CATEGORIES = ['Color', 'Object', 'Shape', 'Text', 'Gesture', 'Count', 'Combination', 'Creative'];
export const START_MODES = ['flexible', 'capacity', 'deadline', 'manual'];
export const JUDGE_POLICIES = ['auto-with-override', 'operator-confirm', 'manual'];
export const JUDGE_MODES = ['rule', 'ai-assisted', 'audience', 'operator'];
export const LEAD_TYPES = ['text', 'email', 'tel'];

export class ValidationError extends Error {
  constructor(message, code = 'invalid_input') { super(message); this.name = 'ValidationError'; this.code = code; }
}

function fail(message) { throw new ValidationError(message); }
function integer(value, min, max, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) fail(`${name} must be ${min}–${max}.`);
  return number;
}
function text(value, max, name, required = true) {
  const result = String(value ?? '').trim();
  if ((required && !result) || result.length > max) fail(`${name} must be ${required ? `1–${max}` : `0–${max}`} characters.`);
  return result;
}
function choice(value, allowed, name) {
  if (!allowed.includes(value)) fail(`Choose a valid ${name}.`);
  return value;
}

export function slugify(value) {
  return String(value ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

export function defaultEvent(name = 'Live Scavenger Hunt', slug = 'live-scavenger-hunt') {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), slug, name, venue: '', timeZone: 'UTC',
    minPlayers: 2, maxPlayers: 6, roundSeconds: 20, joinSeconds: 30,
    resultSeconds: 8, tieWindowMs: 300, startMode: 'flexible',
    judgePolicy: 'auto-with-override', autoAdvance: true, retentionDays: 90,
    leadCapture: {
      enabled: true, guideEnabled: true, expertEnabled: true, marketingOptIn: true,
      fields: [
        { id: 'name', label: 'Name', type: 'text', required: true },
        { id: 'email', label: 'Work email', type: 'email', required: true },
        { id: 'company', label: 'Company', type: 'text', required: false },
      ],
    },
    vote: {
      enabled: true, windowSeconds: 12, creativeWindowSeconds: 10,
      categories: ['Color', 'Object', 'Text'],
      channels: { web: true, sms: false, whatsapp: false },
      smsSender: '', whatsappSender: '', eventCode: '',
    },
    prompts: promptBank(), revision: 1, createdAt: now, updatedAt: now,
  };
}

function normalizeLeadCapture(raw, previous) {
  const base = previous || defaultEvent().leadCapture;
  const value = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) };
  const fields = Array.isArray(value.fields) ? value.fields : [];
  if (fields.length > 8) fail('Use no more than eight lead fields.');
  const seenIds = new Set(), seenLabels = new Set();
  const normalized = fields.map((field, index) => {
    const id = text(field?.id, 80, `Lead field ${index + 1} ID`);
    const label = text(field?.label, 40, `Lead field ${index + 1} label`);
    if (!/^[a-z][a-z0-9-]{0,79}$/i.test(id)) fail('Lead field IDs must start with a letter and contain only letters, numbers, or hyphens.');
    if (seenIds.has(id.toLowerCase()) || seenLabels.has(label.toLowerCase())) fail('Lead fields need distinct IDs and labels.');
    seenIds.add(id.toLowerCase()); seenLabels.add(label.toLowerCase());
    return { id, label, type: choice(field?.type, LEAD_TYPES, 'lead field type'), required: Boolean(field?.required) };
  });
  const enabled = Boolean(value.enabled), guideEnabled = Boolean(value.guideEnabled), expertEnabled = Boolean(value.expertEnabled);
  if (enabled && !normalized.some(field => field.type === 'email' || field.type === 'tel'))
    fail('Add an email or phone field for lead capture.');
  if (enabled && guideEnabled && !normalized.some(field => field.type === 'email' && field.required))
    fail('The build guide needs a required email field.');
  if (enabled && expertEnabled && !normalized.some(field => field.type === 'email' || field.type === 'tel'))
    fail('Add an email or phone field for expert requests.');
  return { enabled, guideEnabled, expertEnabled, marketingOptIn: Boolean(value.marketingOptIn), fields: normalized };
}

function normalizeVote(raw, previous) {
  const base = previous || defaultEvent().vote;
  const value = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) };
  const categories = Array.isArray(value.categories) ? [...new Set(value.categories)] : [];
  if (categories.some(item => !CATEGORIES.includes(item)) || categories.length > CATEGORIES.length) fail('Choose valid voting categories.');
  const channels = { ...base.channels, ...(value.channels && typeof value.channels === 'object' ? value.channels : {}) };
  if (Boolean(value.enabled) && !channels.web && !channels.sms && !channels.whatsapp) fail('Enable at least one voting channel.');
  const smsSender = text(value.smsSender, 60, 'SMS sender', false);
  const whatsappSender = text(value.whatsappSender, 60, 'WhatsApp sender', false);
  const eventCode = text(value.eventCode, 20, 'Event code', false).toUpperCase();
  if (smsSender && !/^\+?\d{5,20}$/.test(smsSender)) fail('SMS sender must be a Twilio number or short code.');
  if (whatsappSender && !/^whatsapp:\+\d{8,15}$/i.test(whatsappSender)) fail('WhatsApp sender must use whatsapp:+ followed by its registered number.');
  if (eventCode && !/^[A-Z0-9]{2,20}$/.test(eventCode)) fail('Event code must be 2–20 letters or numbers.');
  return {
    enabled: Boolean(value.enabled),
    windowSeconds: integer(value.windowSeconds, 5, 180, 'Category vote window'),
    creativeWindowSeconds: integer(value.creativeWindowSeconds, 5, 180, 'Creative vote window'),
    categories,
    channels: { web: Boolean(channels.web), sms: Boolean(channels.sms), whatsapp: Boolean(channels.whatsapp) },
    smsSender, whatsappSender, eventCode,
  };
}

function normalizePrompts(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 100) fail('Keep 1–100 prompts in the event deck.');
  const ids = new Set();
  const prompts = raw.map((item, index) => {
    const id = text(item?.id || `prompt-${randomUUID()}`, 80, `Prompt ${index + 1} ID`);
    if (!/^[a-z0-9-]{1,80}$/i.test(id) || ids.has(id.toLowerCase())) fail('Prompt IDs must be unique letters, numbers, or hyphens.');
    ids.add(id.toLowerCase());
    const seconds = item?.seconds == null || item.seconds === '' ? null : integer(item.seconds, 5, 180, 'Prompt timer');
    const promptText = text(item?.text, 55, `Prompt ${index + 1} text`);
    const category = choice(item?.category, CATEGORIES, 'prompt category');
    const judgeMode = choice(item?.judgeMode, JUDGE_MODES, 'prompt judging mode');
    const detector = text(item?.detector ?? 'manual', 200, 'Prompt detector');
    if (judgeMode === 'rule') {
      const target = detector.match(/^color:(red|blue|yellow|green|orange|purple)$/i)?.[1]?.toLowerCase();
      const colorClue = promptText.match(/^(?:SHOW|FIND) SOMETHING (RED|BLUE|YELLOW|GREEN|ORANGE|PURPLE)[.!]?$/i)?.[1]?.toLowerCase();
      if (category !== 'Color' || !target || colorClue !== target)
        fail('Fast detector prompts must ask to show or find something in one supported color.');
    }
    return {
      id, text: promptText, category, judgeMode, detector,
      enabled: Boolean(item?.enabled), seconds,
      tier: text(item?.tier ?? '', 40, 'Prompt tier', false),
      accessNote: text(item?.accessNote ?? '', 400, 'Prompt access note', false),
    };
  });
  if (!prompts.some(prompt => prompt.enabled)) fail('Enable at least one prompt.');
  return prompts;
}

export function normalizeEvent(raw, previous = null) {
  const base = previous || defaultEvent(raw?.name || 'Live Scavenger Hunt', slugify(raw?.slug || raw?.name || 'live-scavenger-hunt'));
  const source = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) };
  const slug = previous ? previous.slug : slugify(source.slug || source.name);
  if (!slug || slug.length > 60) fail('Enter a valid event slug.');
  const maxPlayers = integer(source.maxPlayers, 2, 6, 'Maximum players');
  const minPlayers = integer(source.minPlayers, 2, maxPlayers, 'Minimum players');
  const timeZone = text(source.timeZone, 80, 'Event time zone');
  try { new Intl.DateTimeFormat('en-US', { timeZone }); }
  catch { fail('Choose a valid IANA event time zone.'); }
  return {
    id: previous?.id || String(source.id || randomUUID()), slug,
    name: text(source.name, 50, 'Event name'), venue: text(source.venue, 120, 'Venue', false), timeZone,
    minPlayers, maxPlayers,
    roundSeconds: integer(source.roundSeconds, 5, 180, 'Round timer'),
    joinSeconds: integer(source.joinSeconds, 5, 180, 'Join window'),
    resultSeconds: integer(source.resultSeconds, 3, 30, 'Result duration'),
    tieWindowMs: integer(source.tieWindowMs, 0, 1500, 'Tie window'),
    startMode: choice(source.startMode, START_MODES, 'start mode'),
    judgePolicy: choice(source.judgePolicy, JUDGE_POLICIES, 'judge policy'),
    autoAdvance: Boolean(source.autoAdvance),
    retentionDays: integer(source.retentionDays, 1, 365, 'Lead retention'),
    leadCapture: normalizeLeadCapture(source.leadCapture, base.leadCapture),
    vote: normalizeVote(source.vote, base.vote),
    prompts: normalizePrompts(source.prompts),
    revision: previous?.revision ?? (Number(source.revision) || 1),
    createdAt: previous?.createdAt || source.createdAt || new Date().toISOString(),
    updatedAt: source.updatedAt || new Date().toISOString(),
  };
}
