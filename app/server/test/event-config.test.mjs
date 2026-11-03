import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, resolveDatabasePath } from '../db.mjs';
import { defaultEvent, normalizeEvent } from '../config.mjs';

function withMessaging(event, { channel = 'sms', sender, code = '' }) {
  return {
    ...event,
    vote: {
      ...event.vote,
      enabled: true,
      channels: { ...event.vote.channels, [channel]: true },
      [channel === 'sms' ? 'smsSender' : 'whatsappSender']: sender,
      eventCode: code,
    },
  };
}

test('legacy default event adopts the new name and URL without losing saved settings or activity', () => {
  const store = openDatabase();
  try {
    const legacy = store.createEvent('SIGNAL STADIUM', 'signal-stadium');
    const configured = store.saveEvent(legacy.slug, { ...legacy, roundSeconds: 37 }, legacy.revision);
    store.recordActivity(legacy.id, 'player_joined', { playerId: 'sample-player' });

    const renamed = store.seedDefault();
    assert.equal(renamed.id, legacy.id);
    assert.equal(renamed.slug, 'live-scavenger-hunt');
    assert.equal(renamed.name, 'Live Scavenger Hunt');
    assert.equal(renamed.roundSeconds, 37);
    assert.equal(renamed.revision, configured.revision + 1);
    assert.equal(store.getEvent('signal-stadium'), null);
    assert.equal(store.listEvents().length, 1);
    assert.equal(store.listActivity(renamed.id).length, 1);
    assert.equal(store.seedDefault().revision, renamed.revision);
  } finally { store.close(); }
});

test('database path uses the new name for fresh installs and reuses an existing legacy file', () => {
  const root = mkdtempSync(join(tmpdir(), 'live-scavenger-hunt-data-'));
  const directory = join(root, 'app', 'data');
  const current = join(directory, 'live-scavenger-hunt.sqlite');
  const legacy = join(directory, 'signal-stadium.sqlite');
  try {
    mkdirSync(directory, { recursive: true });
    assert.equal(resolveDatabasePath(root, {}), current);
    writeFileSync(legacy, '');
    assert.equal(resolveDatabasePath(root, {}), legacy);
    writeFileSync(current, '');
    assert.equal(resolveDatabasePath(root, {}), current);
    assert.equal(resolveDatabasePath(root, { LIVE_SCAVENGER_HUNT_DB: 'custom.sqlite' }), join(root, 'custom.sqlite'));
    assert.equal(resolveDatabasePath(root, { SIGNAL_STADIUM_DB: 'old-custom.sqlite' }), join(root, 'old-custom.sqlite'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('untouched legacy prompts adopt AI defaults while saved judging choices remain intact', () => {
  const store = openDatabase();
  try {
    const original = store.seedDefault();
    assert.ok(original.prompts.every(prompt => prompt.judgeMode === 'ai-assisted'));
    const oldPrompts = original.prompts.map(prompt => prompt.id === 'C01'
      ? { ...prompt, judgeMode: 'rule', detector: 'color:red' }
      : prompt.id === 'V01'
        ? { ...prompt, judgeMode: 'audience', detector: 'manual' } : prompt);
    store.sql.prepare('UPDATE events SET config_json=? WHERE id=?')
      .run(JSON.stringify({ ...original, prompts: oldPrompts }), original.id);
    const customized = store.createEvent('Customized event', 'customized-event');
    const customPrompts = customized.prompts.map(prompt => prompt.id === 'C01'
      ? { ...prompt, judgeMode: 'rule', detector: 'color:red' } : prompt);
    const savedCustom = store.saveEvent(customized.slug,
      { ...customized, prompts: customPrompts }, customized.revision);

    assert.equal(store.migratePromptJudgingToAi(), 1);
    const migrated = store.getEvent(original.slug);
    assert.equal(migrated.revision, original.revision + 1);
    assert.ok(migrated.prompts.every(prompt => prompt.judgeMode === 'ai-assisted'));
    assert.equal(migrated.prompts.find(prompt => prompt.id === 'C01').detector, 'visual:SHOW SOMETHING RED');
    assert.equal(migrated.prompts.find(prompt => prompt.id === 'V01').detector,
      `visual:${migrated.prompts.find(prompt => prompt.id === 'V01').text}`);
    assert.equal(store.getEvent(savedCustom.slug).revision, savedCustom.revision);
    assert.equal(store.getEvent(savedCustom.slug).prompts.find(prompt => prompt.id === 'C01').judgeMode, 'rule');
    assert.equal(store.migratePromptJudgingToAi(), 0);

    const manualPrompts = migrated.prompts.map(prompt => prompt.id === 'C01'
      ? { ...prompt, judgeMode: 'rule', detector: 'color:red' } : prompt);
    const later = store.saveEvent(migrated.slug, { ...migrated, prompts: manualPrompts }, migrated.revision);
    assert.equal(store.migratePromptJudgingToAi(), 0);
    assert.equal(store.getEvent(later.slug).prompts.find(prompt => prompt.id === 'C01').judgeMode, 'rule');
  } finally { store.close(); }
});

test('old untouched timers migrate after AI while admin-saved 20-second rounds remain intact', () => {
  const store = openDatabase();
  try {
    const original = store.seedDefault();
    assert.equal(original.roundSeconds, 45);
    assert.ok(original.prompts.filter(prompt => prompt.category === 'Creative').every(prompt => prompt.seconds === 60));
    const oldPrompts = original.prompts.map(prompt => prompt.id === 'V01'
      ? { ...prompt, seconds: 30 } : prompt.id === 'C01'
        ? { ...prompt, judgeMode: 'rule', detector: 'color:red' } : prompt);
    store.sql.prepare('UPDATE events SET config_json=? WHERE id=?')
      .run(JSON.stringify({ ...original, roundSeconds: 20, prompts: oldPrompts }), original.id);
    const custom = store.createEvent('Custom event', 'custom-event');
    const customPrompts = custom.prompts.map(prompt => prompt.id === 'V01'
      ? { ...prompt, seconds: 30 } : prompt);
    const customSaved = store.saveEvent(custom.slug,
      { ...custom, roundSeconds: 20, prompts: customPrompts }, custom.revision);

    assert.equal(store.migratePromptJudgingToAi(), 1);
    assert.equal(store.migrateRoundDurationDefaults(), 1);
    const updated = store.getEvent(original.slug);
    assert.equal(updated.roundSeconds, 45);
    assert.equal(updated.prompts.find(prompt => prompt.id === 'V01').seconds, 60);
    assert.equal(updated.revision, original.revision + 2);
    assert.equal(store.getEvent(customSaved.slug).revision, customSaved.revision);
    assert.equal(store.getEvent(customSaved.slug).roundSeconds, 20);
    assert.equal(store.getEvent(customSaved.slug).prompts.find(prompt => prompt.id === 'V01').seconds, 30);
    assert.equal(store.migrateRoundDurationDefaults(), 0);
    const later = store.saveEvent(updated.slug, { ...updated, roundSeconds: 25 }, updated.revision);
    assert.equal(store.migrateRoundDurationDefaults(), 0);
    assert.equal(store.getEvent(later.slug).roundSeconds, 25);
  } finally { store.close(); }
});

test('legacy event email-update setting is removed once', () => {
  const store = openDatabase();
  try {
    const original = store.seedDefault();
    assert.equal(Object.hasOwn(original.leadCapture, 'marketingOptIn'), false);
    const legacy = { ...original, leadCapture: { ...original.leadCapture, marketingOptIn: true } };
    store.sql.prepare('UPDATE events SET config_json=? WHERE id=?').run(JSON.stringify(legacy), original.id);
    assert.equal(store.migrateEmailUpdatesOff(), 1);
    const updated = store.getEvent(original.slug);
    assert.equal(Object.hasOwn(updated.leadCapture, 'marketingOptIn'), false);
    assert.equal(updated.revision, original.revision + 1);
    assert.equal(store.migrateEmailUpdatesOff(), 0);
  } finally { store.close(); }
});

test('events sharing an SMS sender need distinct explicit codes, and failed saves keep their revisions', () => {
  const store = openDatabase();
  try {
    const first = store.createEvent('First expo', 'first-expo');
    const second = store.createEvent('Second expo', 'second-expo');
    store.saveEvent(first.slug, withMessaging(first, { sender: '+15551234567', code: 'HUNT' }), first.revision);

    assert.throws(() => store.saveEvent(second.slug,
      withMessaging(second, { sender: '+15551234567', code: 'HUNT' }), second.revision),
    error => error.code === 'duplicate_event_code');
    assert.equal(store.getEvent(second.slug).revision, second.revision);

    const saved = store.saveEvent(second.slug,
      withMessaging(second, { sender: '+15551234567', code: 'RACE' }), second.revision);
    assert.equal(saved.vote.eventCode, 'RACE');
  } finally { store.close(); }
});

test('fallback slug codes and case-insensitive WhatsApp senders cannot collide', () => {
  const store = openDatabase();
  try {
    const first = store.createEvent('First', 'twilio-foo');
    const second = store.createEvent('Second', 'twiliofoo');
    store.saveEvent(first.slug, withMessaging(first, {
      channel: 'whatsapp', sender: 'whatsapp:+15551234567',
    }), first.revision);
    assert.throws(() => store.saveEvent(second.slug, withMessaging(second, {
      channel: 'whatsapp', sender: 'WHATSAPP:+15551234567',
    }), second.revision), error => error.code === 'duplicate_event_code');
    assert.equal(store.getEvent(second.slug).revision, second.revision);

    const saved = store.saveEvent(second.slug, withMessaging(second, {
      channel: 'whatsapp', sender: 'WHATSAPP:+15551234567', code: 'TWILIOFOO2',
    }), second.revision);
    assert.equal(saved.vote.eventCode, 'TWILIOFOO2');
  } finally { store.close(); }
});

test('an SMS number with or without its leading plus is one sender for collision checks', () => {
  const store = openDatabase();
  try {
    const first = store.createEvent('First', 'first');
    const second = store.createEvent('Second', 'second');
    store.saveEvent(first.slug, withMessaging(first, { sender: '+15551234567', code: 'SAME' }), first.revision);
    assert.throws(() => store.saveEvent(second.slug,
      withMessaging(second, { sender: '15551234567', code: 'SAME' }), second.revision),
    error => error.code === 'duplicate_event_code');
  } finally { store.close(); }
});

test('a fast color detector must match the edited clue and category', () => {
  const store = openDatabase();
  try {
    const event = store.seedDefault();
    const fastPrompts = event.prompts.map(prompt => prompt.id === 'C01'
      ? { ...prompt, judgeMode: 'rule', detector: 'color:red' } : prompt);
    const prompts = fastPrompts.map(prompt => prompt.id === 'C01'
      ? { ...prompt, text: 'SHOW SOMETHING BLUE' } : prompt);
    assert.throws(() => store.saveEvent(event.slug, { ...event, prompts }, event.revision),
      error => error.code === 'invalid_input');
    assert.equal(store.getEvent(event.slug).revision, event.revision);
    const overSpecific = prompts.map(prompt => prompt.id === 'C01'
      ? { ...prompt, text: 'SHOW A BLUE DEVICE', detector: 'color:blue' } : prompt);
    assert.throws(() => store.saveEvent(event.slug, { ...event, prompts: overSpecific }, event.revision),
      error => error.code === 'invalid_input');
    const matching = prompts.map(prompt => prompt.id === 'C01'
      ? { ...prompt, detector: 'color:blue' } : prompt);
    const saved = store.saveEvent(event.slug, { ...event, prompts: matching }, event.revision);
    assert.equal(saved.prompts.find(prompt => prompt.id === 'C01').detector, 'color:blue');
  } finally { store.close(); }
});

test('color-only clues default to low rotation priority and admins can save an override', () => {
  const store = openDatabase();
  try {
    const event = store.seedDefault();
    assert.equal(event.prompts.find(prompt => prompt.id === 'C01').priority, 'low');
    assert.equal(event.prompts.find(prompt => prompt.id === 'O01').priority, 'standard');

    const legacyPrompts = event.prompts.map(({ priority, ...prompt }) => prompt);
    const legacy = normalizeEvent({ ...event, prompts: legacyPrompts }, event);
    assert.equal(legacy.prompts.find(prompt => prompt.id === 'C01').priority, 'low');
    assert.equal(legacy.prompts.find(prompt => prompt.id === 'O01').priority, 'standard');

    const customized = legacy.prompts.map(prompt => prompt.id === 'C01'
      ? { ...prompt, priority: 'standard' } : prompt);
    const saved = store.saveEvent(event.slug, { ...event, prompts: customized }, event.revision);
    assert.equal(store.getEvent(event.slug).prompts.find(prompt => prompt.id === 'C01').priority, 'standard');
    assert.equal(saved.prompts.find(prompt => prompt.id === 'C01').priority, 'standard');
    assert.throws(() => store.saveEvent(event.slug, {
      ...saved, prompts: saved.prompts.map(prompt => prompt.id === 'C01'
        ? { ...prompt, priority: 'urgent' } : prompt),
    }, saved.revision), error => error.code === 'invalid_input');
  } finally { store.close(); }
});

test('new and existing events default to post-play leads and GitHub CTA', () => {
  const fresh = normalizeEvent(defaultEvent('New Expo', 'new-expo'));
  assert.equal(fresh.leadCapture.timing, 'after-play');
  assert.equal(fresh.cta.primary, 'github');
  const legacy = structuredClone(fresh);
  delete legacy.leadCapture.timing;
  delete legacy.cta;
  const updated = normalizeEvent({ ...legacy, name: 'Updated Expo' }, legacy);
  assert.equal(updated.leadCapture.timing, 'after-play');
  assert.equal(updated.cta.primary, 'github');
  const join = normalizeEvent({ ...legacy, leadCapture: { ...legacy.leadCapture, timing: 'join' } }, legacy);
  assert.equal(join.leadCapture.timing, 'join');
});

test('primary CTA only accepts an enabled follow-up action', () => {
  const event = normalizeEvent(defaultEvent());
  assert.equal(normalizeEvent({ ...event, cta: { primary: 'guide' } }, event).cta.primary, 'guide');
  assert.throws(() => normalizeEvent({ ...event, cta: { primary: 'guide' },
    leadCapture: { ...event.leadCapture, guideEnabled: false } }, event),
  error => error.code === 'invalid_input');
  assert.throws(() => normalizeEvent({ ...event, cta: { primary: 'expert' },
    leadCapture: { ...event.leadCapture, enabled: false } }, event),
  error => error.code === 'invalid_input');
});
