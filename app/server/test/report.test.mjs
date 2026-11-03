import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../db.mjs';
import { buildReport, exportCsv } from '../report.mjs';

function eventInZone(store, name, slug, timeZone) {
  const created = store.createEvent(name, slug);
  return store.saveEvent(slug, { ...created, timeZone }, created.revision);
}

function addLead(store, event, { id, at, intent = 'guide', values = {}, fields = [], marketingOptIn = false }) {
  store.insertLead({
    id, eventId: event.id, createdAt: at, intent, participantId: `player-${id}`,
    heatId: `heat-${id}`, fieldValues: values, fieldSnapshot: fields,
    name: values.name || '', email: values.email || '', phone: values.phone || '', company: values.company || '',
    marketingOptIn, consentVersion: 'v1', deliveryStatus: 'pending',
  });
}

test('event date filters use each event time zone, including a daylight-saving transition; all-events use UTC', () => {
  const store = new Store(':memory:');
  try {
    const la = eventInZone(store, 'Los Angeles Expo', 'la-expo', 'America/Los_Angeles');
    const ny = eventInZone(store, 'New York Expo', 'ny-expo', 'America/New_York');
    const timestamps = [
      '2026-03-08T07:59:00.000Z', // Mar 7, 23:59 in LA
      '2026-03-08T08:01:00.000Z', // Mar 8, 00:01 in LA
      '2026-03-09T06:59:00.000Z', // Mar 8, 23:59 in LA after the DST jump
      '2026-03-09T07:01:00.000Z', // Mar 9, 00:01 in LA
    ];
    timestamps.forEach((at, index) => store.recordActivity(la.id, 'landing_opened', { sessionId: `la-${index}` }, at));
    store.recordActivity(ny.id, 'landing_opened', { sessionId: 'ny-1' }, '2026-03-08T08:01:00.000Z');
    addLead(store, la, { id: 'lead-early', at: timestamps[0], values: { email: 'early@example.com' }, fields: [{ id: 'email', label: 'Email', type: 'email' }] });
    addLead(store, la, { id: 'lead-mid', at: timestamps[2], values: { email: 'mid@example.com' }, fields: [{ id: 'email', label: 'Email', type: 'email' }] });

    const laDay = buildReport(store, { event: la.slug, from: '2026-03-08', to: '2026-03-08' });
    assert.deepEqual(laDay.activity.map(item => item.at), timestamps.slice(1, 3));
    assert.deepEqual(laDay.leads.map(item => item.id), ['lead-mid']);
    assert.equal(laDay.summary.events, 1);
    assert.equal(laDay.summary.byEvent[0].timeZone, 'America/Los_Angeles');

    const utcDay = buildReport(store, { event: 'all', from: '2026-03-08', to: '2026-03-08' });
    assert.equal(utcDay.activity.length, 3); // two LA records and one NY record
    assert.equal(utcDay.leads.length, 1);
    assert.equal(utcDay.summary.events, 2);
  } finally { store.close(); }
});

test('invalid events, dates, ranges, and export kinds are rejected', () => {
  const store = new Store(':memory:');
  try {
    store.createEvent('Expo', 'expo');
    assert.throws(() => buildReport(store, { event: 'missing' }), { code: 'not_found' });
    assert.throws(() => buildReport(store, { event: 'expo', from: '2026-02-30' }), { code: 'invalid_input' });
    assert.throws(() => buildReport(store, { event: 'expo', from: '2026/02/01' }), { code: 'invalid_input' });
    assert.throws(() => buildReport(store, { event: 'expo', from: '2026-11-10', to: '2026-11-09' }), { code: 'invalid_input' });
    assert.throws(() => exportCsv(store, { kind: 'unknown', event: 'expo' }), { code: 'invalid_input' });
  } finally { store.close(); }
});

test('summary counts play, votes, lead intent, and safe activity properties', () => {
  const store = new Store(':memory:');
  try {
    const event = eventInZone(store, 'Developer Expo', 'developer-expo', 'UTC');
    const at = '2026-11-02T12:00:00.000Z';
    const record = (type, properties = {}) => store.recordActivity(event.id, type, properties, at);
    record('landing_opened', { sessionId: 'visitor-1' });
    record('landing_opened', { sessionId: 'visitor-2' });
    record('player_joined', { playerId: 'player-1' });
    record('player_joined', { playerId: 'player-2' });
    record('player_ready', { playerId: 'player-1' });
    record('heat_started', { heatId: 'heat-1', playerCount: 2 });
    record('heat_completed', { heatId: 'heat-1' });
    record('player_kicked', { playerId: 'player-1', heat: 1 });
    record('player_timed_out', { playerId: 'player-2', heat: 1 });
    record('player_left', { playerId: 'player-3', heat: 1 });
    record('cta_opened', { sessionId: 'visitor-1' });
    record('lead_form_opened', { sessionId: 'visitor-1' });
    record('vote_page_opened', { sessionId: 'visitor-2' });
    record('vote_accepted', { voterId: 'voter-1', windowId: 'window-1', windowType: 'category', channel: 'web', choice: 'Color', choiceLabel: 'Color', email: 'should-not-appear@example.com' });
    record('vote_accepted', { voterId: 'voter-1', windowId: 'window-2', windowType: 'creative', channel: 'sms', choice: 'player-1', choiceLabel: 'Ada' });
    addLead(store, event, { id: 'lead-guide', at, intent: 'guide', marketingOptIn: true,
      values: { name: 'Ada', email: 'ada@example.com' },
      fields: [{ id: 'name', label: 'Name', type: 'text' }, { id: 'email', label: 'Email', type: 'email' }],
    });
    addLead(store, event, { id: 'lead-expert', at, intent: 'expert', values: { name: 'Grace', email: 'grace@example.com' },
      fields: [{ id: 'name', label: 'Name', type: 'text' }, { id: 'email', label: 'Email', type: 'email' }],
    });
    const report = buildReport(store, { event: event.slug, from: '2026-11-02', to: '2026-11-02' });
    assert.equal(report.summary.totalParticipants, 2);
    assert.equal(report.summary.uniquePlayers, 2);
    assert.equal(report.summary.totalPlays, 2);
    assert.equal(report.summary.heatsStarted, 1);
    assert.equal(report.summary.heatsCompleted, 1);
    assert.equal(report.summary.readyPlayers, 1);
    assert.equal(report.summary.kickedPlayers, 1);
    assert.equal(report.summary.timedOutPlayers, 1);
    assert.equal(report.summary.playerLeaves, 1);
    assert.equal(report.summary.votes, 2);
    assert.equal(report.summary.uniqueVoters, 1);
    assert.equal(report.summary.categoryVotes, 1);
    assert.equal(report.summary.creativeVotes, 1);
    assert.equal(report.summary.leads, 2);
    assert.equal(report.summary.guideRequests, 1);
    assert.equal(report.summary.expertRequests, 1);
    assert.equal(report.summary.marketingOptIns, 1);
    assert.equal(report.summary.ctaClicks, 1);
    assert.equal(report.summary.avgPlayersPerHeat, 2);
    assert.equal(report.summary.ballotVisitors, 1);
    assert.equal(report.activity.find(item => item.type === 'vote_accepted').properties.email, undefined);
  } finally { store.close(); }
});

test('outbound product and repository clicks follow event and date filters', () => {
  const store = new Store(':memory:');
  try {
    const west = eventInZone(store, 'West Expo', 'west-expo', 'UTC');
    const east = eventInZone(store, 'East Expo', 'east-expo', 'UTC');
    const record = (event, type, at, product, source) => store.recordActivity(event.id, type,
      { sessionId: 'visitor-session', ...(product ? { product } : {}), ...(source ? { source } : {}) }, at);
    record(west, 'twilio_product_link_opened', '2026-11-02T12:00:00.000Z', 'video');
    record(west, 'twilio_product_link_opened', '2026-11-02T12:05:00.000Z', 'messaging');
    record(west, 'github_cta_opened', '2026-11-02T12:10:00.000Z', null, 'arena_qr');
    record(west, 'github_cta_opened', '2026-11-03T12:00:00.000Z', null, 'arena_link');
    record(east, 'twilio_product_link_opened', '2026-11-02T13:00:00.000Z', 'segment');
    record(east, 'github_cta_opened', '2026-11-02T13:05:00.000Z', null, 'spectator');

    const westDay = buildReport(store, { event: west.slug, from: '2026-11-02', to: '2026-11-02' });
    assert.equal(westDay.summary.twilioProductLinkClicks, 2);
    assert.deepEqual(westDay.summary.twilioProductLinkClicksByProduct, { video: 1, messaging: 1, segment: 0 });
    assert.equal(westDay.summary.githubRepoClicks, 1);
    assert.deepEqual(westDay.summary.githubRepoClicksBySource,
      { phone: 0, spectator: 0, arenaQr: 1, arenaLink: 0 });
    assert.equal(westDay.summary.engagementActions, 3);
    assert.equal(westDay.activity.find(row => row.type === 'twilio_product_link_opened').properties.product, 'video');

    const bothDay = buildReport(store, { event: 'all', from: '2026-11-02', to: '2026-11-02' });
    assert.equal(bothDay.summary.twilioProductLinkClicks, 3);
    assert.deepEqual(bothDay.summary.twilioProductLinkClicksByProduct, { video: 1, messaging: 1, segment: 1 });
    assert.equal(bothDay.summary.githubRepoClicks, 2);
    assert.deepEqual(bothDay.summary.githubRepoClicksBySource,
      { phone: 0, spectator: 1, arenaQr: 1, arenaLink: 0 });
    assert.deepEqual(bothDay.summary.byEvent.map(row => [row.slug, row.twilioProductLinkClicks, row.githubRepoClicks]), [
      ['west-expo', 2, 1], ['east-expo', 1, 1],
    ]);
  } finally { store.close(); }
});

test('CSV exports retain historical custom lead fields, escape formulas, and keep activity free of contact data', () => {
  const store = new Store(':memory:');
  try {
    const event = eventInZone(store, 'Formula Expo', 'formula-expo', 'UTC');
    const at = '2026-11-02T12:00:00.000Z';
    store.recordActivity(event.id, 'prompt_revealed', { promptId: 'p1', promptText: '=cmd()', email: 'hidden@example.com', phone: '+15550001111' }, at);
    store.recordActivity(event.id, 'vote_accepted', { windowType: 'creative', choice: 'player-1', choiceLabel: 'Ada Visitor', channel: 'web' }, at);
    addLead(store, event, { id: 'lead-custom', at, values: { name: '=HYPERLINK("https://example.com")', email: 'ada@example.com', project: ' +SUM(1,2)' },
      fields: [{ id: 'name', label: 'Name', type: 'text' }, { id: 'email', label: 'Work email', type: 'email' }, { id: 'project', label: 'Project idea', type: 'text' }],
    });
    const leadCsv = exportCsv(store, { kind: 'leads', event: event.slug, from: '2026-11-02', to: '2026-11-02' });
    assert.ok(leadCsv.startsWith('\ufeff'));
    assert.match(leadCsv, /field:project/);
    assert.match(leadCsv, /field_snapshot_json/);
    assert.match(leadCsv, /'=HYPERLINK/);
    assert.match(leadCsv, /' \+SUM/);
    assert.match(leadCsv, /\r\n/);
    const eventsCsv = exportCsv(store, { kind: 'events', event: event.slug, from: '2026-11-02', to: '2026-11-02' });
    assert.ok(eventsCsv.startsWith('\ufeff'));
    assert.match(eventsCsv, /prompt_revealed/);
    assert.match(eventsCsv, /'=cmd\(\)/);
    assert.doesNotMatch(eventsCsv, /hidden@example\.com|15550001111|Ada Visitor/);
  } finally { store.close(); }
});
