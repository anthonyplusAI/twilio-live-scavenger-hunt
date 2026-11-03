import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db.mjs';
import { GameEngine } from '../engine.mjs';

function setup(changes = {}) {
  const store = openDatabase();
  let event = store.seedDefault();
  if (Object.keys(changes).length) event = store.saveEvent(event.slug, { ...event, ...changes }, event.revision);
  let now = Date.UTC(2026, 0, 1, 12);
  const engine = new GameEngine({ store, now: () => now, randomIndex: () => 0 });
  const advance = milliseconds => { now += milliseconds; engine.tickAll(); };
  const join = alias => {
    const response = engine.join(event.slug, { alias, displayConsent: true });
    if (response.player.slot) engine.setTransport(event.slug, response.token, 'rehearsal');
    return response;
  };
  const ready = response => engine.ready(event.slug, response.token);
  return { store, event, engine, advance, join, ready, get now() { return now; }, set now(value) { now = value; } };
}

test('automatic prompt draws are random without repeats, with category and manual overrides', () => {
  const app = setup();
  try {
    const event = { ...app.event, prompts: app.event.prompts.filter(prompt => ['C01', 'O01', 'T01'].includes(prompt.id)) };
    const state = { usedPromptIds: [], queuedPromptId: null, preferredCategory: null };
    app.engine.randomIndex = max => max - 1;
    const draw = () => app.engine._choosePrompt(event, state).id;

    assert.deepEqual([draw(), draw(), draw()], ['T01', 'O01', 'C01']);
    assert.equal(draw(), 'T01'); // A new cycle cannot immediately repeat C01.
    assert.deepEqual(state.usedPromptIds, ['T01']);

    state.preferredCategory = 'Text'; // Its only prompt is used; keep the no-repeat rule.
    assert.equal(draw(), 'O01');
    state.queuedPromptId = 'O01'; // Staff can intentionally repeat a prompt.
    assert.equal(draw(), 'O01');
    assert.equal(state.queuedPromptId, null);

    const categoryState = { usedPromptIds: [], queuedPromptId: null, preferredCategory: 'Object' };
    assert.equal(app.engine._choosePrompt(event, categoryState).id, 'O01');
  } finally { app.store.close(); }
});

test('atomic slot assignment caps an event at its configured capacity and queues late arrivals', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2 });
  const [first, second, third] = ['Ada', 'Bea', 'Cy'].map(app.join);
  assert.deepEqual([first.player.slot, second.player.slot, third.player.slot], [1, 2, null]);
  assert.equal(third.player.status, 'queued');
  assert.equal(app.engine.snapshot(app.event.slug).state.queuedCount, 1);
  app.store.close();
});

test('public event state seals prompt ID and text until GO, then reveals the snapshotted timer', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 3, startMode: 'manual', roundSeconds: 13 });
  const a = app.join('Ada'), b = app.join('Bea');
  app.ready(a); app.ready(b);
  const lobby = JSON.stringify(app.engine.snapshot(app.event.slug));
  assert.equal(lobby.includes('SHOW SOMETHING RED'), false);
  app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
  const countdown = JSON.stringify(app.engine.snapshot(app.event.slug));
  assert.equal(countdown.includes('SHOW SOMETHING RED'), false);
  assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'countdown');
  app.advance(3000);
  const hunt = app.engine.snapshot(app.event.slug).state;
  assert.equal(hunt.prompt.text, 'SHOW SOMETHING RED');
  assert.equal(Date.parse(hunt.roundEndsAt) - app.now, 13_000);
  app.store.close();
});

test('capacity and deadline starts follow the saved event mode; manual requires the operator', () => {
  const capacity = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'capacity' });
  const a = capacity.join('Ada'), b = capacity.join('Bea');
  capacity.ready(a); assert.equal(capacity.engine.snapshot(capacity.event.slug).state.phase, 'lobby');
  capacity.ready(b); assert.equal(capacity.engine.snapshot(capacity.event.slug).state.phase, 'countdown');
  capacity.store.close();

  const deadline = setup({ minPlayers: 2, maxPlayers: 4, startMode: 'deadline', joinSeconds: 5 });
  const c = deadline.join('Cy'), d = deadline.join('Dee');
  deadline.ready(c); deadline.ready(d);
  deadline.advance(4999); assert.equal(deadline.engine.snapshot(deadline.event.slug).state.phase, 'lobby');
  deadline.advance(1); assert.equal(deadline.engine.snapshot(deadline.event.slug).state.phase, 'countdown');
  deadline.store.close();

  const manual = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual' });
  const e = manual.join('Eli'), f = manual.join('Flo');
  manual.ready(e); manual.ready(f); manual.advance(40_000);
  assert.equal(manual.engine.snapshot(manual.event.slug).state.phase, 'lobby');
  manual.store.close();
});

test('saving live lobby settings moves overflow players into the queue and applies a changed start mode', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 4, startMode: 'manual', autoAdvance: false });
  const players = ['Ada', 'Bea', 'Cy'].map(app.join);
  players.forEach(app.ready);
  const smaller = app.store.saveEvent(app.event.slug, {
    ...app.event, maxPlayers: 2, startMode: 'manual',
  }, app.event.revision);
  app.engine.configChanged(app.event.slug, app.event, smaller);
  const lobby = app.engine.snapshot(app.event.slug).state;
  assert.deepEqual(lobby.roster.map(player => player.slot), [1, 2]);
  assert.equal(lobby.queuedCount, 1);
  assert.equal(app.store.getPlayer(players[2].player.id).status, 'queued');
  assert.equal(lobby.phase, 'lobby');

  const capacity = app.store.saveEvent(app.event.slug, {
    ...smaller, startMode: 'capacity',
  }, smaller.revision);
  app.engine.configChanged(app.event.slug, smaller, capacity);
  assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'countdown');
  app.store.close();
});

test('late players move into the next heat, while a completed heat keeps its original rule snapshot', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false });
  const a = app.join('Ada'), b = app.join('Bea');
  app.ready(a); app.ready(b);
  app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
  const c = app.join('Cy');
  assert.equal(c.player.status, 'queued');
  app.advance(3000);
  app.engine.command(app.event.slug, 'award', { winners: [a.player.id] }, { id: 'operator' });
  const changed = app.store.saveEvent(app.event.slug, { ...app.event, roundSeconds: 55 }, app.event.revision);
  assert.equal(app.store.listHeats(app.event.id)[0].rules.roundSeconds, 45);
  assert.equal(changed.roundSeconds, 55);
  app.engine.command(app.event.slug, 'nextHeat', {}, { id: 'operator' });
  const next = app.engine.snapshot(app.event.slug).state;
  assert.equal(next.heat, 2);
  assert.equal(next.roster[0].id, c.player.id);
  assert.equal(next.roster[0].slot, 1);
  app.store.close();
});

test('a finished player can replay with the same token, queue once, and leave when done', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false });
  try {
    const first = app.join('Ada'), second = app.join('Bea');
    app.ready(first); app.ready(second);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    assert.throws(() => app.engine.replay(app.event.slug, first.token),
      error => error.code === 'replay_unavailable');
    app.advance(3000);
    app.engine.command(app.event.slug, 'award', { winners: [first.player.id] }, { id: 'operator' });
    const replayed = app.engine.replay(app.event.slug, first.token);
    assert.equal(replayed.player.id, first.player.id);
    assert.equal(replayed.player.alias, 'Ada');
    assert.equal(replayed.player.status, 'queued');
    assert.equal(replayed.player.heat, 2);
    assert.equal(replayed.player.slot, null);
    assert.equal(replayed.state.queuedCount, 1);
    assert.equal(replayed.state.roster.find(player => player.id === first.player.id)?.status, 'finished');
    assert.equal(app.engine.replay(app.event.slug, first.token).player.id, first.player.id);
    assert.equal(app.store.listActivity(app.event.id).filter(row => row.type === 'player_joined').length, 3);

    app.engine.command(app.event.slug, 'nextHeat', {}, { id: 'operator' });
    const promoted = app.engine.me(app.event.slug, first.token);
    assert.equal(promoted.player.status, 'joined');
    assert.equal(promoted.player.slot, 1);
    app.engine.leave(app.event.slug, first.token);
    assert.throws(() => app.engine.me(app.event.slug, first.token), error => error.code === 'unauthorized');
  } finally { app.store.close(); }
});

test('restart advances absolute deadlines once and never duplicates heat completion', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false, roundSeconds: 5 });
  const a = app.join('Ada'), b = app.join('Bea');
  app.ready(a); app.ready(b);
  app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
  app.now += 50_000;
  const restarted = new GameEngine({ store: app.store, now: () => app.now });
  assert.equal(restarted.snapshot(app.event.slug).state.phase, 'review');
  app.now += 6000;
  assert.equal(restarted.snapshot(app.event.slug).state.phase, 'result');
  restarted.snapshot(app.event.slug);
  assert.equal(app.store.listActivity(app.event.id).filter(row => row.type === 'heat_completed').length, 1);
  app.store.close();
});

test('verified near-simultaneous matches become a tie; the operator can override once without replaying the heat', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false, tieWindowMs: 300 });
  const a = app.join('Ada'), b = app.join('Bea');
  app.ready(a); app.ready(b); app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
  app.advance(3000);
  const at = app.now;
  app.engine.acceptJudgment(app.event.slug, { playerId: a.player.id, matched: true, source: 'rule', confidence: 0.9, receiptAt: at + 1000 });
  app.engine.acceptJudgment(app.event.slug, { playerId: b.player.id, matched: true, source: 'rule', confidence: 0.9, receiptAt: at + 1200 });
  app.advance(1500);
  assert.deepEqual(app.engine.snapshot(app.event.slug).state.winners, [a.player.id, b.player.id]);
  app.engine.command(app.event.slug, 'award', { winners: [b.player.id], reason: 'operator review' }, { id: 'operator' });
  const state = app.engine.snapshot(app.event.slug, 'operator').state;
  assert.deepEqual(state.winners, [b.player.id]);
  assert.equal(state.overrideCount, 1);
  assert.equal(app.store.listActivity(app.event.id).filter(row => row.type === 'heat_completed').length, 1);
  const heatId = app.store.listHeats(app.event.id)[0].id;
  app.engine.command(app.event.slug, 'nextHeat', {}, { id: 'operator' });
  app.engine.command(app.event.slug, 'correctHeat', { heatId, winners: [], reason: 'post-heat correction' }, { id: 'operator' });
  assert.deepEqual(app.store.listHeats(app.event.id)[0].winners, []);
  assert.deepEqual(app.engine.snapshot(app.event.slug, 'operator').state.recentHeats[0].winners, []);
  assert.equal(app.store.listActivity(app.event.id).filter(row => row.type === 'heat_completed').length, 1);
  app.store.close();
});

test('category and creative ballots deduplicate voters and can award a creative heat', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false,
    prompts: [{ id: 'V01', text: 'MAKE A VIDEO SIGNAL', category: 'Creative', judgeMode: 'audience', detector: 'manual', enabled: true, seconds: 5 }] });
  const a = app.join('Ada'), b = app.join('Bea');
  app.ready(a); app.ready(b); app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
  app.advance(3000 + 5000);
  const vote = app.engine.snapshot(app.event.slug).state.vote;
  assert.equal(vote.type, 'creative');
  const voterHash = 'a'.repeat(64);
  app.engine.castVote(app.event.slug, { windowId: vote.id, choice: vote.options[0].code, voterHash });
  assert.throws(() => app.engine.castVote(app.event.slug, { windowId: vote.id, choice: vote.options[1].id, voterHash }), error => error.code === 'duplicate_vote');
  app.advance(10_000);
  assert.deepEqual(app.engine.snapshot(app.event.slug).state.winners, [a.player.id]);
  app.engine.command(app.event.slug, 'kickPlayer', { playerId: a.player.id }, { id: 'operator' });
  assert.deepEqual(app.engine.snapshot(app.event.slug).state.vote.result, []);
  assert.deepEqual(app.engine.snapshot(app.event.slug).state.winners, []);
  app.store.close();
});

test('a winner leaving after results preserves the recorded audience vote and award', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false,
    prompts: [{ id: 'V01', text: 'MAKE A VIDEO SIGNAL', category: 'Creative', judgeMode: 'audience', detector: 'manual', enabled: true, seconds: 5 }] });
  const a = app.join('Ada'), b = app.join('Bea');
  app.ready(a); app.ready(b);
  app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
  app.advance(3000 + 5000);
  const vote = app.engine.snapshot(app.event.slug).state.vote;
  app.engine.castVote(app.event.slug, { windowId: vote.id, choice: vote.options[0].id, voterHash: 'b'.repeat(64) });
  app.advance(10_000);
  app.engine.leave(app.event.slug, a.token);
  const result = app.engine.snapshot(app.event.slug).state;
  assert.deepEqual(result.vote.result, [a.player.id]);
  assert.deepEqual(result.winners, [a.player.id]);
  assert.deepEqual(result.roster.map(player => player.alias), ['Ada', 'Bea']);
  assert.equal(result.roster[0].mediaConnected, false);
  app.store.close();
});

test('a result keeps a voluntary leaver visible while a kicked tie winner disappears', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false });
  const a = app.join('Ada'), b = app.join('Bea');
  app.ready(a); app.ready(b);
  app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
  app.advance(3000);
  app.engine.command(app.event.slug, 'award', { winners: [a.player.id, b.player.id] }, { id: 'operator' });
  app.engine.leave(app.event.slug, a.token);
  assert.deepEqual(app.engine.snapshot(app.event.slug).state.roster.map(player => player.alias), ['Ada', 'Bea']);
  app.engine.command(app.event.slug, 'kickPlayer', { playerId: b.player.id }, { id: 'operator' });
  const state = app.engine.snapshot(app.event.slug).state;
  assert.deepEqual(state.winners, [a.player.id]);
  assert.deepEqual(state.roster.map(player => player.alias), ['Ada']);
  assert.deepEqual(app.store.listHeats(app.event.id)[0].winners, [a.player.id]);
  app.store.close();
});

test('pause freezes the round clock and resume restores its remaining time', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false });
  const a = app.join('Ada'), b = app.join('Bea');
  app.ready(a); app.ready(b); app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
  app.advance(3000);
  app.engine.command(app.event.slug, 'pause', {}, { id: 'operator' });
  assert.equal(app.engine.snapshot(app.event.slug).state.roundEndsAt, null);
  app.advance(100_000);
  assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'hunt');
  app.engine.command(app.event.slug, 'resume', {}, { id: 'operator' });
  assert.equal(Date.parse(app.engine.snapshot(app.event.slug).state.roundEndsAt) - app.now, 45_000);
  app.store.close();
});

test('joining a paused lobby keeps open slots available for the heat after resume', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual' });
  app.engine.command(app.event.slug, 'pause', {}, { id: 'operator' });
  const a = app.join('Ada'), b = app.join('Bea');
  assert.deepEqual([a.player.slot, b.player.slot], [1, 2]);
  assert.throws(() => app.ready(a), error => error.code === 'invalid_state');
  app.engine.command(app.event.slug, 'resume', {}, { id: 'operator' });
  app.ready(a); app.ready(b);
  app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
  assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'countdown');
  app.store.close();
});

test('Next heat cannot strand a lobby roster or abandon an unfinished review', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false, roundSeconds: 5,
    prompts: [{ id: 'M01', text: 'SHOW A NETWORK SIGNAL', category: 'Object', judgeMode: 'operator', detector: 'manual', enabled: true, seconds: null }] });
  const a = app.join('Ada'), b = app.join('Bea');
  app.ready(a); app.ready(b);
  assert.throws(() => app.engine.command(app.event.slug, 'nextHeat', {}, { id: 'operator' }),
    error => error.code === 'invalid_state');
  app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
  app.advance(3000 + 5000);
  assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'review');
  assert.throws(() => app.engine.command(app.event.slug, 'nextHeat', {}, { id: 'operator' }),
    error => error.code === 'invalid_state');
  app.engine.command(app.event.slug, 'noMatch', {}, { id: 'operator' });
  app.engine.command(app.event.slug, 'nextHeat', {}, { id: 'operator' });
  assert.equal(app.engine.snapshot(app.event.slug).state.heat, 2);
  app.store.close();
});

test('changing vote settings closes the active ballot, including a creative final', () => {
  const category = setup({ startMode: 'manual' });
  category.engine.command(category.event.slug, 'openVote', { type: 'category' }, { id: 'operator' });
  const revised = category.store.saveEvent(category.event.slug, {
    ...category.event, vote: { ...category.event.vote, enabled: false },
  }, category.event.revision);
  category.engine.configChanged(category.event.slug, category.event, revised);
  assert.equal(category.engine.snapshot(category.event.slug).state.vote.status, 'closed');
  category.store.close();

  const creative = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false,
    prompts: [{ id: 'V01', text: 'BUILD A SIGNAL', category: 'Creative', judgeMode: 'audience', detector: 'manual', enabled: true, seconds: 5 }] });
  const a = creative.join('Ada'), b = creative.join('Bea');
  creative.ready(a); creative.ready(b);
  creative.engine.command(creative.event.slug, 'start', {}, { id: 'operator' });
  creative.advance(3000 + 5000);
  assert.equal(creative.engine.snapshot(creative.event.slug).state.vote.status, 'open');
  const disabled = creative.store.saveEvent(creative.event.slug, {
    ...creative.event, vote: { ...creative.event.vote, enabled: false },
  }, creative.event.revision);
  creative.engine.configChanged(creative.event.slug, creative.event, disabled);
  assert.equal(creative.engine.snapshot(creative.event.slug).state.phase, 'result');
  creative.store.close();
});

test('operator can kick a ready player or queued player and their sessions cannot continue', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual' });
  const readyPlayer = app.join('Ada'), other = app.join('Bea'), queued = app.join('Cy');
  app.ready(readyPlayer); app.ready(other);
  assert.throws(() => app.engine.command(app.event.slug, 'kickPlayer', { playerId: 'missing' }, { id: 'operator' }),
    error => error.code === 'not_found');
  app.engine.command(app.event.slug, 'kickPlayer', { playerId: readyPlayer.player.id }, { id: 'operator' });
  app.engine.command(app.event.slug, 'kickPlayer', { playerId: queued.player.id }, { id: 'operator' });
  const state = app.engine.snapshot(app.event.slug).state;
  assert.deepEqual(state.roster.map(player => player.id), [other.player.id]);
  assert.equal(state.queuedCount, 0);
  assert.equal(app.store.getPlayer(readyPlayer.player.id).status, 'kicked');
  assert.equal(app.store.getPlayer(readyPlayer.player.id).slot, null);
  assert.throws(() => app.engine.me(app.event.slug, readyPlayer.token), error => error.code === 'player_kicked');
  assert.throws(() => app.engine.heartbeat(app.event.slug, queued.token), error => error.code === 'player_kicked');
  assert.throws(() => app.engine.command(app.event.slug, 'kickPlayer', { playerId: readyPlayer.player.id }, { id: 'operator' }),
    error => error.code === 'invalid_state');
  assert.equal(app.store.listActivity(app.event.id).filter(row => row.type === 'player_kicked').length, 2);
  assert.equal(app.store.listAudit(app.event.id).filter(row => row.action === 'command:kickPlayer').length, 2);
  app.store.close();
});

test('kicking during an active heat removes evidence and prevents awarding the removed player', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false });
  const a = app.join('Ada'), b = app.join('Bea');
  app.ready(a); app.ready(b);
  app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
  app.advance(3000);
  app.engine.acceptJudgment(app.event.slug, { playerId: a.player.id, matched: true,
    confidence: 0.9, receiptAt: app.now, source: 'rule' });
  app.engine.command(app.event.slug, 'kickPlayer', { playerId: a.player.id }, { id: 'operator' });
  const state = app.engine.snapshot(app.event.slug, 'operator').state;
  assert.deepEqual(state.roster.map(player => player.id), [b.player.id]);
  assert.equal(state.candidate, null);
  assert.deepEqual(state.candidates, []);
  assert.throws(() => app.engine.command(app.event.slug, 'award', { winners: [a.player.id] }, { id: 'operator' }),
    error => error.code === 'invalid_state');
  app.engine.command(app.event.slug, 'award', { winners: [b.player.id] }, { id: 'operator' });
  assert.deepEqual(app.engine.snapshot(app.event.slug).state.winners, [b.player.id]);
  app.store.close();
});

test('removing the first detected match recalculates a fair tie among remaining finds', () => {
  const app = setup({ minPlayers: 3, maxPlayers: 3, startMode: 'manual', autoAdvance: false });
  const a = app.join('Ada'), b = app.join('Bea'), c = app.join('Cy');
  for (const player of [a, b, c]) app.ready(player);
  app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
  app.advance(3000);
  for (const [player, offset] of [[a, 0], [b, 200], [c, 400]]) {
    app.engine.acceptJudgment(app.event.slug, { playerId: player.player.id, matched: true,
      confidence: 0.9, receiptAt: app.now + offset, source: 'rule' });
  }
  assert.deepEqual(app.engine.snapshot(app.event.slug, 'operator').state.candidate.winners, [a.player.id, b.player.id]);
  app.engine.command(app.event.slug, 'kickPlayer', { playerId: a.player.id }, { id: 'operator' });
  assert.deepEqual(app.engine.snapshot(app.event.slug, 'operator').state.candidate.winners, [b.player.id, c.player.id]);
  app.store.close();
});

test('kicking an awarded winner corrects the current result without leaving them on the wall', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false });
  const a = app.join('Ada'), b = app.join('Bea');
  app.ready(a); app.ready(b);
  app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
  app.advance(3000);
  app.engine.command(app.event.slug, 'award', { winners: [a.player.id] }, { id: 'operator' });
  app.engine.command(app.event.slug, 'kickPlayer', { playerId: a.player.id }, { id: 'operator' });
  const state = app.engine.snapshot(app.event.slug).state;
  assert.deepEqual(state.winners, []);
  assert.equal(state.roster.some(player => player.id === a.player.id), false);
  assert.deepEqual(app.store.listHeats(app.event.id)[0].winners, []);
  app.store.close();
});

test('presence sweep removes abandoned players after grace but keeps a briefly backgrounded phone', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false,
    roundSeconds: 120 });
  const a = app.join('Ada'), b = app.join('Bea');
  app.ready(a); app.ready(b);
  app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
  app.advance(3000);
  app.advance(25_000);
  assert.equal(app.store.getPlayer(a.player.id).status, 'active');
  app.engine.heartbeat(app.event.slug, b.token);
  app.advance(35_001);
  assert.equal(app.store.getPlayer(a.player.id).status, 'left');
  assert.equal(app.store.getPlayer(a.player.id).slot, null);
  assert.equal(app.store.getPlayer(b.player.id).status, 'active');
  assert.equal(app.store.listActivity(app.event.id).filter(row => row.type === 'player_timed_out').length, 1);
  app.store.close();
});
