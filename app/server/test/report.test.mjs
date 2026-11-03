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

test('join sessions and repeat browser visits are reported separately', () => {
  const store = new Store(':memory:');
  try {
    const event = eventInZone(store, 'Repeat Visitor Expo', 'repeat-visitor-expo', 'UTC');
    const at = '2026-11-02T12:00:00.000Z';
    store.recordActivity(event.id, 'player_joined', { playerId: 'first-join', sessionId: 'browser-one' }, at);
    store.recordActivity(event.id, 'player_joined', { playerId: 'second-join', sessionId: 'browser-one' }, at);
    store.recordActivity(event.id, 'player_joined', { playerId: 'third-join', sessionId: 'browser-two' }, at);
    const summary = buildReport(store, { event: event.slug }).summary;
    assert.equal(summary.joinSessions, 3);
    assert.equal(summary.uniqueVisitorSessions, 2);
    assert.equal(summary.totalParticipants, 3);
  } finally { store.close(); }
});

test('follow-up requests use request dates even when the lead was captured earlier', () => {
  const store = new Store(':memory:');
  try {
    const event = eventInZone(store, 'Follow-up Expo', 'follow-up-expo', 'UTC');
    addLead(store, event, { id: 'captured-early', at: '2026-11-02T12:00:00.000Z', intent: 'capture',
      values: { email: 'visitor@example.test' }, fields: [{ id: 'email', label: 'Email', type: 'email' }] });
    store.markLeadRequest('captured-early', 'guide', '2026-11-03T12:00:00.000Z');
    store.markLeadRequest('captured-early', 'expert', '2026-11-04T12:00:00.000Z');
    const day = value => buildReport(store, { event: event.slug, from: value, to: value });
    assert.deepEqual([day('2026-11-02').summary.leads, day('2026-11-02').summary.guideRequests], [1, 0]);
    assert.equal(day('2026-11-03').leads.length, 0);
    assert.deepEqual([day('2026-11-03').summary.guideRequests, day('2026-11-03').summary.expertRequests], [1, 0]);
    assert.deepEqual([day('2026-11-04').summary.guideRequests, day('2026-11-04').summary.expertRequests], [0, 1]);
    const all = buildReport(store, { event: 'all', from: '2026-11-03', to: '2026-11-03' });
    assert.equal(all.summary.byEvent[0].guideRequests, 1);
  } finally { store.close(); }
});

test('pending expert work remains visible across date filters while respecting the event filter', () => {
  const store = new Store(':memory:');
  try {
    const first = eventInZone(store, 'First Expo', 'first-expo', 'UTC');
    const second = eventInZone(store, 'Second Expo', 'second-expo', 'UTC');
    for (const [event, id] of [[first, 'first-lead'], [second, 'second-lead']]) {
      addLead(store, event, { id, at: '2026-11-01T12:00:00.000Z', intent: 'capture',
        values: { email: `${id}@example.test` }, fields: [{ id: 'email', label: 'Email', type: 'email' }] });
      store.markLeadRequest(id, 'expert', '2026-11-01T13:00:00.000Z');
    }

    const filters = { from: '2026-11-03', to: '2026-11-03' };
    const firstReport = buildReport(store, { ...filters, event: first.slug });
    assert.equal(firstReport.summary.leads, 0);
    assert.equal(firstReport.summary.expertRequests, 0);
    assert.equal(firstReport.summary.pendingExpertRequests, 1);
    assert.deepEqual(firstReport.expertQueue.map(row => row.id), ['first-lead']);
    assert.equal(firstReport.summary.byEvent[0].pendingExpertRequests, 1);

    const allReport = buildReport(store, { ...filters, event: 'all' });
    assert.equal(allReport.summary.pendingExpertRequests, 2);
    assert.deepEqual(allReport.expertQueue.map(row => row.id).sort(), ['first-lead', 'second-lead']);

    store.setExpertFollowupStatus('first-lead', 'contacted');
    const resolved = buildReport(store, { ...filters, event: first.slug });
    assert.equal(resolved.summary.pendingExpertRequests, 0);
    assert.deepEqual(resolved.expertQueue, []);
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
    assert.deepEqual(bothDay.summary.byEvent.map(row => [row.slug, row.twilioProductLinkClicks, row.githubRepoClicks])
      .sort((a, b) => a[0].localeCompare(b[0])), [
      ['east-expo', 1, 1], ['west-expo', 2, 1],
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
