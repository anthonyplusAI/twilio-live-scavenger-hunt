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
    const prompts = event.prompts.map(prompt => prompt.id === 'C01'
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
