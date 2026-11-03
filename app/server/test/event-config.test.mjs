import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, resolveDatabasePath } from '../db.mjs';

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

test('existing event prompts switch to AI once and later admin choices remain saved', () => {
  const store = openDatabase();
  try {
    const original = store.seedDefault();
    assert.ok(original.prompts.every(prompt => prompt.judgeMode === 'ai-assisted'));
    const oldPrompts = original.prompts.map(prompt => prompt.id === 'C01'
      ? { ...prompt, judgeMode: 'rule', detector: 'color:red' }
      : prompt.id === 'V01'
        ? { ...prompt, judgeMode: 'audience', detector: 'manual' } : prompt);
    const saved = store.saveEvent(original.slug, { ...original, prompts: oldPrompts }, original.revision);

    assert.equal(store.migratePromptJudgingToAi(), 1);
    const migrated = store.getEvent(saved.slug);
    assert.equal(migrated.revision, saved.revision + 1);
    assert.ok(migrated.prompts.every(prompt => prompt.judgeMode === 'ai-assisted'));
    assert.equal(migrated.prompts.find(prompt => prompt.id === 'C01').detector, 'visual:SHOW SOMETHING RED');
    assert.equal(migrated.prompts.find(prompt => prompt.id === 'V01').detector,
      `visual:${migrated.prompts.find(prompt => prompt.id === 'V01').text}`);
    assert.equal(store.migratePromptJudgingToAi(), 0);

    const manualPrompts = migrated.prompts.map(prompt => prompt.id === 'C01'
      ? { ...prompt, judgeMode: 'rule', detector: 'color:red' } : prompt);
    const later = store.saveEvent(migrated.slug, { ...migrated, prompts: manualPrompts }, migrated.revision);
    assert.equal(store.migratePromptJudgingToAi(), 0);
    assert.equal(store.getEvent(later.slug).prompts.find(prompt => prompt.id === 'C01').judgeMode, 'rule');
  } finally { store.close(); }
});

test('old standard and seeded creative timers move to longer defaults once', () => {
  const store = openDatabase();
  try {
    const original = store.seedDefault();
    assert.equal(original.roundSeconds, 45);
    assert.ok(original.prompts.filter(prompt => prompt.category === 'Creative').every(prompt => prompt.seconds === 60));
    const oldPrompts = original.prompts.map(prompt => prompt.id === 'V01'
      ? { ...prompt, seconds: 30 } : prompt);
    const old = store.saveEvent(original.slug, { ...original, roundSeconds: 20, prompts: oldPrompts }, original.revision);
    const custom = store.createEvent('Custom event', 'custom-event');
    const customSaved = store.saveEvent(custom.slug, { ...custom, roundSeconds: 52 }, custom.revision);

    assert.equal(store.migrateRoundDurationDefaults(), 1);
    const updated = store.getEvent(old.slug);
    assert.equal(updated.roundSeconds, 45);
    assert.equal(updated.prompts.find(prompt => prompt.id === 'V01').seconds, 60);
    assert.equal(updated.revision, old.revision + 1);
    assert.equal(store.getEvent(customSaved.slug).roundSeconds, 52);
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
