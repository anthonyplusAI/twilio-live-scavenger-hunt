import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db.mjs';
import { GameEngine } from '../engine.mjs';

function setup(changes = {}, { randomIndex = () => 0 } = {}) {
  const store = openDatabase();
  let event = store.seedDefault();
  if (Object.keys(changes).length) event = store.saveEvent(event.slug, { ...event, ...changes }, event.revision);
  let now = Date.UTC(2026, 0, 1, 12);
  const engine = new GameEngine({ store, now: () => now, randomIndex });
  const advance = milliseconds => { now += milliseconds; engine.tickAll(); };
  const join = (alias, options = {}) => {
    const response = engine.join(event.slug, { alias, displayConsent: true }, options);
    if (response.player.slot) engine.setTransport(event.slug, response.token, 'rehearsal');
    return response;
  };
  const ready = response => engine.ready(event.slug, response.token);
  return { store, event, engine, advance, join, ready, get now() { return now; }, set now(value) { now = value; } };
}

function startAfterBallot(app) {
  if (app.engine.snapshot(app.event.slug).state.vote?.status === 'open')
    app.engine.command(app.event.slug, 'closeVote', {}, { id: 'operator' });
  app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
}

test('new events wait for an operator start even when every spot is ready', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2 });
  try {
    assert.equal(app.event.startMode, 'manual');
    assert.equal(app.event.autoAdvance, true);
    const a = app.join('Ada'), b = app.join('Bea');
    app.ready(a); app.ready(b);
    app.advance(20_000);
    app.engine.heartbeat(app.event.slug, a.token);
    app.engine.heartbeat(app.event.slug, b.token);
    app.advance(app.event.joinSeconds * 1000 - 19_000);
    assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'lobby');
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'countdown');
  } finally { app.store.close(); }
});

test('manual start waits for an open category ballot to close', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual' });
  try {
    const a = app.join('Ada'), b = app.join('Bea');
    app.ready(a); app.ready(b);
    app.engine.command(app.event.slug, 'openVote', { type: 'category' }, { id: 'operator' });
    assert.throws(() => app.engine.command(app.event.slug, 'start', {}, { id: 'operator' }),
      error => error.code === 'vote_open');
    assert.equal(app.engine.snapshot(app.event.slug).state.vote.status, 'open');
    app.engine.command(app.event.slug, 'closeVote', {}, { id: 'operator' });
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'countdown');
  } finally { app.store.close(); }
});

test('a waiting roster enters the next lobby without an automatic category ballot', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: true });
  try {
    const first = app.join('Ada'), second = app.join('Bea');
    app.ready(first); app.ready(second);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    app.advance(3000);
    const waitingA = app.join('Cy'), waitingB = app.join('Dee');
    assert.equal(app.store.getPlayer(waitingA.player.id).status, 'queued');
    assert.equal(app.store.getPlayer(waitingB.player.id).status, 'queued');
    app.engine.command(app.event.slug, 'noMatch', {}, { id: 'operator' });
    app.advance(app.event.resultSeconds * 1000);

    const state = app.engine.snapshot(app.event.slug).state;
    assert.equal(state.phase, 'lobby');
    assert.equal(state.vote, null);
    for (const waiting of [waitingA, waitingB]) {
      assert.equal(app.store.getPlayer(waiting.player.id).status, 'joined');
      app.engine.setTransport(app.event.slug, waiting.token, 'rehearsal');
      app.ready(waiting);
    }
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'countdown');
  } finally { app.store.close(); }
});

test('automatic prompt draws are random without repeats within a tier, with category and manual overrides', () => {
  const app = setup();
  try {
    const event = { ...app.event, prompts: app.event.prompts.filter(prompt => ['C01', 'O01', 'T01'].includes(prompt.id)) };
    const state = { usedPromptIds: [], queuedPromptId: null, preferredCategory: null };
    app.engine.randomIndex = max => max - 1;
    const draw = () => app.engine._choosePrompt(event, state).id;

    assert.deepEqual([draw(), draw(), draw(), draw(), draw()], ['T01', 'O01', 'T01', 'O01', 'C01']);
    assert.deepEqual(state.usedPromptIds, ['T01', 'O01', 'C01']);
    assert.equal(state.automaticPromptSelections, 5);

    state.preferredCategory = 'Text'; // A category vote can override the automatic tier schedule.
    assert.equal(draw(), 'T01');
    state.queuedPromptId = 'O01'; // Staff can intentionally repeat a prompt.
    assert.equal(draw(), 'O01');
    assert.equal(state.queuedPromptId, null);
    assert.equal(state.automaticPromptSelections, 5);

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

test('vacant lobby spots promote queued players before later visitors', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual' });
  const a = app.join('Ada'), b = app.join('Bea');
  const c = app.join('Cy'), d = app.join('Dee');
  assert.deepEqual([c.player.queuePosition, d.player.queuePosition], [1, 2]);
  assert.equal(app.engine.snapshot(app.event.slug).state.queuedCount, 2);
  assert.equal(Object.hasOwn(app.engine.snapshot(app.event.slug).state, 'queuePosition'), false);

  app.engine.leave(app.event.slug, a.token);
  assert.equal(app.store.getPlayer(c.player.id).slot, 1);
  assert.equal(app.store.getPlayer(c.player.id).status, 'joined');
  assert.equal(app.engine.me(app.event.slug, c.token).player.queuePosition, null);
  assert.equal(app.engine.me(app.event.slug, d.token).player.queuePosition, 1);

  const e = app.join('Eli');
  assert.equal(e.player.status, 'queued');
  assert.equal(e.player.queuePosition, 2);
  app.engine.command(app.event.slug, 'kickPlayer', { playerId: b.player.id }, { id: 'operator' });
  assert.equal(app.store.getPlayer(d.player.id).slot, 2);
  assert.equal(app.engine.me(app.event.slug, e.token).player.queuePosition, 1);
  assert.deepEqual(app.engine.snapshot(app.event.slug).state.roster.map(player => player.alias), ['Cy', 'Dee']);
  app.store.close();
});

test('a join repairs a preexisting lobby vacancy without jumping the queue', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual' });
  const a = app.join('Ada');
  app.join('Bea');
  const c = app.join('Cy');
  app.store.updatePlayer(a.player.id, { status: 'left', slot: null, leftAt: new Date(app.now).toISOString() });
  const d = app.join('Dee');
  assert.equal(app.store.getPlayer(c.player.id).slot, 1);
  assert.equal(d.player.status, 'queued');
  assert.equal(d.player.queuePosition, 1);
  assert.deepEqual(app.engine.snapshot(app.event.slug).state.roster.map(player => player.alias), ['Cy', 'Bea']);
  app.store.close();
});

test('raising lobby capacity gives newly open spots to the existing queue', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual' });
  app.join('Ada'); app.join('Bea');
  const c = app.join('Cy'), d = app.join('Dee');
  const expanded = app.store.saveEvent(app.event.slug,
    { ...app.event, maxPlayers: 4 }, app.event.revision);
  app.engine.configChanged(app.event.slug, app.event, expanded);
  const state = app.engine.snapshot(app.event.slug).state;
  assert.deepEqual(state.roster.map(player => player.alias), ['Ada', 'Bea', 'Cy', 'Dee']);
  assert.deepEqual(state.roster.map(player => player.slot), [1, 2, 3, 4]);
  assert.equal(state.queuedCount, 0);
  assert.equal(app.engine.heartbeat(app.event.slug, c.token).player.queuePosition, null);
  assert.equal(app.engine.heartbeat(app.event.slug, d.token).player.queuePosition, null);
  app.store.close();
});

test('public event state seals prompt ID and text until GO, then reveals the snapshotted timer', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 3, startMode: 'manual', roundSeconds: 13 });
  const a = app.join('Ada'), b = app.join('Bea');
  app.ready(a); app.ready(b);
  app.engine.command(app.event.slug, 'queuePrompt', { promptId: 'C01' }, { id: 'operator' });
  const lobby = JSON.stringify(app.engine.snapshot(app.event.slug));
  assert.equal(lobby.includes('SHOW SOMETHING RED'), false);
  app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
  const countdown = JSON.stringify(app.engine.snapshot(app.event.slug));
  assert.equal(countdown.includes('SHOW SOMETHING RED'), false);
  assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'countdown');
  const goDeadline = Date.parse(app.engine.snapshot(app.event.slug).state.countdownEndsAt);
  app.now = goDeadline - 1;
  const beforeGo = app.engine.snapshot(app.event.slug).state;
  assert.equal(beforeGo.phase, 'countdown');
  assert.equal(Object.hasOwn(beforeGo, 'prompt'), false);
  app.now = goDeadline;
  const hunt = app.engine.snapshot(app.event.slug).state;
  assert.equal(hunt.phase, 'hunt');
  assert.equal(hunt.prompt.text, 'SHOW SOMETHING RED');
  assert.equal(Date.parse(app.store.getRuntime(app.event.id).goAt), goDeadline);
  assert.equal(Date.parse(hunt.roundEndsAt) - app.now, 13_000);
  app.store.close();
});

test('automatic rounds reserve at most one fifth for low priority and recover legacy play counts', () => {
  const prompts = [
    { id: 'C01', text: 'SHOW SOMETHING RED', category: 'Color', judgeMode: 'rule', detector: 'color:red', enabled: true, seconds: null },
    { id: 'C02', text: 'SHOW SOMETHING BLUE', category: 'Color', judgeMode: 'rule', detector: 'color:blue', enabled: true, seconds: null },
    { id: 'O01', text: 'SHOW A CUP', category: 'Object', judgeMode: 'operator', detector: 'manual', enabled: true, seconds: null, priority: 'standard' },
    { id: 'T01', text: 'FIND THE WORD TWILIO', category: 'Text', judgeMode: 'operator', detector: 'manual', enabled: true, seconds: null, priority: 'standard' },
  ];
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false, prompts });
  try {
    const seen = [];
    for (let heat = 0; heat < 5; heat++) {
      const a = app.join(`Ada${heat}`), b = app.join(`Bea${heat}`);
      app.ready(a); app.ready(b);
      startAfterBallot(app);
      seen.push(app.store.getRuntime(app.event.id).promptSnapshot.id);
      app.advance(3000);
      app.engine.command(app.event.slug, 'award', { winners: [a.player.id] }, { id: 'operator' });
      app.engine.command(app.event.slug, 'nextHeat', {}, { id: 'operator' });
      assert.equal(app.store.getRuntime(app.event.id).automaticPromptSelections, heat + 1);
      if (heat === 1) {
        const legacy = app.store.getRuntime(app.event.id);
        delete legacy.promptPlayCounts;
        app.store.saveRuntime(app.event.id, legacy);
      }
    }
    assert.deepEqual(seen, ['O01', 'T01', 'O01', 'T01', 'C01']);
    app.engine.command(app.event.slug, 'reset', {}, { id: 'operator' });
    assert.equal(app.store.getRuntime(app.event.id).automaticPromptSelections, 5);
  } finally { app.store.close(); }
});

test('six low color clues never crowd out four standard clues in automatic rotation', () => {
  const colors = ['RED', 'BLUE', 'YELLOW', 'GREEN', 'ORANGE', 'PURPLE'];
  const prompts = [
    ...colors.map((color, index) => ({ id: `C0${index + 1}`, text: `SHOW SOMETHING ${color}`,
      category: 'Color', judgeMode: 'rule', detector: `color:${color.toLowerCase()}`,
      enabled: true, seconds: null })),
    ...[
      ['O01', 'SHOW A CUP', 'Object'],
      ['T01', 'FIND THE WORD TWILIO', 'Text'],
      ['G01', 'MAKE A THUMBS UP', 'Gesture'],
      ['M01', 'SHOW TWO TECH ITEMS', 'Combination'],
    ].map(([id, text, category]) => ({ id, text, category,
      judgeMode: 'operator', detector: 'manual', priority: 'standard', enabled: true, seconds: null })),
  ];
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false, prompts });
  try {
    const seen = [];
    for (let heat = 1; heat <= 25; heat++) {
      const a = app.join(`Ada${heat}`), b = app.join(`Bea${heat}`);
      app.ready(a); app.ready(b);
      startAfterBallot(app);
      seen.push(app.store.getRuntime(app.event.id).promptSnapshot.id);
      app.advance(3000);
      app.engine.command(app.event.slug, 'award', { winners: [a.player.id] }, { id: 'operator' });
      app.engine.command(app.event.slug, 'nextHeat', {}, { id: 'operator' });
    }
    assert.deepEqual(seen.slice(0, 10), ['O01', 'T01', 'G01', 'M01', 'C01', 'O01', 'T01', 'G01', 'M01', 'C02']);
    assert.deepEqual(seen.flatMap((id, index) => id.startsWith('C') ? [index + 1] : []), [5, 10, 15, 20, 25]);
    assert.deepEqual(seen.filter(id => id.startsWith('C')), ['C01', 'C02', 'C03', 'C04', 'C05']);
    assert.equal(app.store.getRuntime(app.event.id).automaticPromptSelections, 25);
  } finally { app.store.close(); }
});

test('ties within a priority tier use the injected random draw without immediate repeats', () => {
  const prompts = [
    { id: 'C01', text: 'SHOW SOMETHING RED', category: 'Color', judgeMode: 'rule', detector: 'color:red', enabled: true, seconds: null },
    { id: 'O01', text: 'SHOW A CUP', category: 'Object', judgeMode: 'operator', detector: 'manual', priority: 'standard', enabled: true, seconds: null },
    { id: 'T01', text: 'FIND THE WORD TWILIO', category: 'Text', judgeMode: 'operator', detector: 'manual', priority: 'standard', enabled: true, seconds: null },
  ];
  const app = setup({ prompts }, { randomIndex: length => length - 1 });
  try {
    const state = app.engine._runtime(app.event);
    assert.equal(app.engine._choosePrompt(app.event, state).id, 'T01');
    assert.equal(app.engine._choosePrompt(app.event, state).id, 'O01');
    assert.equal(app.engine._choosePrompt(app.event, state).id, 'T01');
  } finally { app.store.close(); }
});

test('category choice and a queued prompt override low-priority rotation', () => {
  const prompts = [
    { id: 'O01', text: 'SHOW A CUP', category: 'Object', judgeMode: 'operator', detector: 'manual', enabled: true, seconds: null, priority: 'standard' },
    { id: 'C01', text: 'SHOW SOMETHING RED', category: 'Color', judgeMode: 'rule', detector: 'color:red', enabled: true, seconds: null },
    { id: 'C02', text: 'SHOW SOMETHING BLUE', category: 'Color', judgeMode: 'rule', detector: 'color:blue', enabled: true, seconds: null },
  ];
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false, prompts });
  try {
    for (const [heat, override, expected] of [
      [1, ['selectCategory', { category: 'Color' }], 'C01'],
      [2, ['queuePrompt', { promptId: 'C02' }], 'C02'],
      [3, null, 'O01'],
    ]) {
      const a = app.join(`Ada${heat}`), b = app.join(`Bea${heat}`);
      app.ready(a); app.ready(b);
      if (override) app.engine.command(app.event.slug, override[0], override[1], { id: 'operator' });
      app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
      assert.equal(app.store.getRuntime(app.event.id).promptSnapshot.id, expected);
      app.advance(3000);
      app.engine.command(app.event.slug, 'award', { winners: [a.player.id] }, { id: 'operator' });
      app.engine.command(app.event.slug, 'nextHeat', {}, { id: 'operator' });
    }
    assert.equal(app.store.getRuntime(app.event.id).automaticPromptSelections, 1);
  } finally { app.store.close(); }
});

test('automatic category ballots defer pure-low choices and keep mixed categories on cadence', () => {
  const prompts = [
    { id: 'O01', text: 'SHOW A CUP', category: 'Object', priority: 'standard' },
    { id: 'O02', text: 'SHOW A LAPTOP', category: 'Object', priority: 'low' },
    { id: 'T01', text: 'FIND THE WORD TWILIO', category: 'Text', priority: 'standard' },
    { id: 'C01', text: 'SHOW SOMETHING RED', category: 'Color', priority: 'low' },
  ].map(prompt => ({ ...prompt, judgeMode: 'ai-assisted', detector: `visual:${prompt.text}`, enabled: true, seconds: null }));
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false, prompts,
    vote: { autoCategory: true } });
  try {
    const rounds = [
      { options: null, vote: null, prompt: 'O01' },
      { options: ['Object', 'Text'], vote: 'Text', prompt: 'T01' },
      { options: null, vote: null, prompt: 'O01' },
      { options: ['Object', 'Text'], vote: 'Object', prompt: 'O01' },
      { options: null, vote: null, prompt: 'O02' },
      { options: ['Object', 'Text'], vote: 'Object', prompt: 'O01' },
      { options: null, vote: null, prompt: 'T01' },
      { options: ['Object', 'Text'], vote: 'Object', prompt: 'O01' },
      { options: null, vote: null, prompt: 'T01' },
      { options: ['Color', 'Object', 'Text'], vote: 'Color', prompt: 'C01' },
    ];
    for (const [index, round] of rounds.entries()) {
      const ballot = app.engine.snapshot(app.event.slug).state.vote;
      assert.deepEqual(ballot?.options.map(option => option.id) ?? null, round.options);
      if (round.vote) app.engine.castVote(app.event.slug, {
        windowId: ballot.id, choice: round.vote, voterHash: 'a'.repeat(64),
      });
      const a = app.join(`Ada${index}`), b = app.join(`Bea${index}`);
      app.ready(a); app.ready(b);
      startAfterBallot(app);
      assert.equal(app.store.getRuntime(app.event.id).promptSnapshot.id, round.prompt);
      assert.equal(app.store.getRuntime(app.event.id).automaticPromptSelections, index + 1);
      app.advance(3000);
      app.engine.command(app.event.slug, 'award', { winners: [a.player.id] }, { id: 'operator' });
      app.engine.command(app.event.slug, 'nextHeat', {}, { id: 'operator' });
    }
    assert.equal(app.store.getRuntime(app.event.id).promptPlayCounts.O02, 1);
  } finally { app.store.close(); }
});

test('operator category selection overrides a closed automatic ballot', () => {
  const prompts = [
    { id: 'O01', text: 'SHOW A CUP', category: 'Object', priority: 'standard' },
    { id: 'T01', text: 'FIND THE WORD TWILIO', category: 'Text', priority: 'standard' },
    { id: 'C01', text: 'SHOW SOMETHING RED', category: 'Color', priority: 'low' },
  ].map(prompt => ({ ...prompt, judgeMode: 'ai-assisted', detector: `visual:${prompt.text}`, enabled: true, seconds: null }));
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false, prompts,
    vote: { autoCategory: true } });
  try {
    const first = app.join('Ada'), second = app.join('Bea');
    app.ready(first); app.ready(second);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    app.advance(3000);
    app.engine.command(app.event.slug, 'award', { winners: [first.player.id] }, { id: 'operator' });
    app.engine.command(app.event.slug, 'nextHeat', {}, { id: 'operator' });
    const ballot = app.engine.snapshot(app.event.slug).state.vote;
    assert.deepEqual(ballot.options.map(option => option.id), ['Object', 'Text']);
    app.engine.castVote(app.event.slug, { windowId: ballot.id, choice: 'Text', voterHash: 'b'.repeat(64) });
    app.engine.command(app.event.slug, 'closeVote', {}, { id: 'operator' });
    app.engine.command(app.event.slug, 'selectCategory', { category: 'Color' }, { id: 'operator' });
    const third = app.join('Cy'), fourth = app.join('Dee');
    app.ready(third); app.ready(fourth);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    assert.equal(app.store.getRuntime(app.event.id).promptSnapshot.id, 'C01');
    assert.equal(app.store.getRuntime(app.event.id).automaticPromptSelections, 1);
  } finally { app.store.close(); }
});

test('a prompt queued during a hunt or result survives into the next heat', () => {
  for (const phase of ['hunt', 'result']) {
    const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false });
    try {
      const first = app.join('Ada'), second = app.join('Bea');
      app.ready(first); app.ready(second);
      app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
      app.advance(3000);
      if (phase === 'hunt') app.engine.command(app.event.slug, 'queuePrompt', { promptId: 'C01' }, { id: 'operator' });
      app.engine.command(app.event.slug, 'noMatch', {}, { id: 'operator' });
      if (phase === 'result') app.engine.command(app.event.slug, 'queuePrompt', { promptId: 'C01' }, { id: 'operator' });
      app.engine.command(app.event.slug, 'nextHeat', {}, { id: 'operator' });
      assert.equal(app.store.getRuntime(app.event.id).queuedPromptId, 'C01', `${phase} queue survives`);
      const third = app.join('Cy'), fourth = app.join('Dee');
      app.ready(third); app.ready(fourth);
      startAfterBallot(app);
      assert.equal(app.store.getRuntime(app.event.id).promptSnapshot.id, 'C01');
      assert.equal(app.store.getRuntime(app.event.id).queuedPromptId, null);
      assert.equal(app.store.getRuntime(app.event.id).automaticPromptSelections, 1);
    } finally { app.store.close(); }
  }
});

test('clearing a manual next prompt returns the heat to automatic rotation', () => {
  const prompts = [
    { id: 'O01', text: 'SHOW A CUP', category: 'Object', judgeMode: 'operator', detector: 'manual', enabled: true, seconds: null, priority: 'standard' },
    { id: 'C01', text: 'SHOW SOMETHING RED', category: 'Color', judgeMode: 'rule', detector: 'color:red', enabled: true, seconds: null, priority: 'low' },
  ];
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', prompts });
  try {
    const first = app.join('Ada'), second = app.join('Bea');
    app.ready(first); app.ready(second);
    app.engine.command(app.event.slug, 'queuePrompt', { promptId: 'C01' }, { id: 'operator' });
    assert.equal(app.store.getRuntime(app.event.id).queuedPromptId, 'C01');
    app.engine.command(app.event.slug, 'clearQueuedPrompt', {}, { id: 'operator' });
    assert.equal(app.store.getRuntime(app.event.id).queuedPromptId, null);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    assert.equal(app.store.getRuntime(app.event.id).promptSnapshot.id, 'O01');
    assert.equal(app.store.getRuntime(app.event.id).automaticPromptSelections, 1);
  } finally { app.store.close(); }
});

test('automatic ballots leave unvoted heats for standard categories outside the ballot and then Low prompts', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false,
    vote: { autoCategory: true } });
  try {
    const seen = [];
    const ballotHeats = [];
    for (let heat = 1; heat <= 15; heat++) {
      const ballot = app.engine.snapshot(app.event.slug).state.vote;
      if (ballot?.status === 'open') {
        ballotHeats.push(heat);
        app.engine.castVote(app.event.slug, {
          windowId: ballot.id, choice: 'Object', voterHash: 'c'.repeat(64),
        });
      }
      const first = app.join(`Ada${heat}`), second = app.join(`Bea${heat}`);
      app.ready(first); app.ready(second);
      startAfterBallot(app);
      seen.push(app.store.getRuntime(app.event.id).promptSnapshot.id);
      app.advance(3000);
      app.engine.command(app.event.slug, 'noMatch', {}, { id: 'operator' });
      app.engine.command(app.event.slug, 'nextHeat', {}, { id: 'operator' });
    }
    for (const id of ['O01', 'T01', 'G02', 'M01']) assert.ok(seen.includes(id), `${id} was played`);
    const firstColor = seen.findIndex(id => id.startsWith('C'));
    assert.ok(firstColor > Math.max(...['O01', 'T01', 'G02', 'M01'].map(id => seen.indexOf(id))),
      'a Low color prompt follows each enabled Standard prompt');
    assert.ok(ballotHeats.length > 0 && ballotHeats.length < 10, 'category ballots recur without occupying every heat');
    assert.equal(app.store.getRuntime(app.event.id).automaticPromptSelections, 15);
  } finally { app.store.close(); }
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

test('a ready live Video player who disconnects cannot be locked into a heat', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual' });
  const a = app.join('Ada'), b = app.join('Bea');
  app.engine.setTransport(app.event.slug, a.token, 'twilio');
  app.engine.setTransport(app.event.slug, b.token, 'twilio');
  app.engine.setMediaConnected(app.event.slug, a.player.id, true);
  app.engine.setMediaConnected(app.event.slug, b.player.id, true);
  app.ready(a); app.ready(b);
  app.engine.setMediaConnected(app.event.slug, b.player.id, false);
  assert.equal(app.engine.snapshot(app.event.slug).state.readyCount, 1);
  assert.throws(() => app.engine.command(app.event.slug, 'start', {}, { id: 'operator' }),
    error => error.code === 'not_enough_players');
  app.engine.setMediaConnected(app.event.slug, b.player.id, true);
  assert.equal(app.engine.snapshot(app.event.slug).state.readyCount, 2);
  app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
  assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'countdown');
  app.store.close();
});

test('flexible join window begins at the minimum and resets when readiness drops', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 6, startMode: 'flexible', joinSeconds: 30 });
  const a = app.join('Ada'), b = app.join('Bea');
  app.ready(a);
  assert.equal(app.engine.snapshot(app.event.slug).state.readyDeadline, null);
  app.advance(20_000);
  app.engine.heartbeat(app.event.slug, a.token);
  app.ready(b);
  let state = app.engine.snapshot(app.event.slug).state;
  assert.equal(Date.parse(state.readyDeadline), app.now + 30_000);
  app.advance(10_000);
  app.engine.heartbeat(app.event.slug, a.token);
  app.engine.leave(app.event.slug, b.token);
  assert.equal(app.engine.snapshot(app.event.slug).state.readyDeadline, null);
  const c = app.join('Cy');
  app.ready(c);
  state = app.engine.snapshot(app.event.slug).state;
  assert.equal(Date.parse(state.readyDeadline), app.now + 30_000);
  app.advance(20_000);
  app.engine.heartbeat(app.event.slug, a.token);
  app.engine.heartbeat(app.event.slug, c.token);
  app.advance(9_999);
  assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'lobby');
  app.advance(1);
  assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'countdown');
  app.store.close();
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
    const first = app.join('Ada', { analyticsSessionId: 'a'.repeat(20) }), second = app.join('Bea');
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
    const replayJoin = app.store.listActivity(app.event.id).filter(row => row.type === 'player_joined').at(-1);
    assert.equal(replayJoin.properties.sessionId, 'a'.repeat(20));

    app.engine.command(app.event.slug, 'nextHeat', {}, { id: 'operator' });
    const promoted = app.engine.me(app.event.slug, first.token);
    assert.equal(promoted.player.status, 'joined');
    assert.equal(promoted.player.slot, 1);
    app.engine.leave(app.event.slug, first.token);
    const left = app.engine.me(app.event.slug, first.token).player;
    assert.equal(left.id, first.player.id);
    assert.equal(left.alias, 'Ada');
    assert.equal(left.status, 'left');
    assert.equal(left.slot, null);
    assert.throws(() => app.engine.player(app.event.slug, first.token), error => error.code === 'unauthorized');
    assert.throws(() => app.engine.heartbeat(app.event.slug, first.token), error => error.code === 'unauthorized');
    const rejoined = app.engine.replay(app.event.slug, first.token);
    assert.equal(rejoined.player.id, first.player.id);
    assert.equal(rejoined.player.status, 'joined');
    assert.equal(rejoined.player.lastExitReason, null);
    assert.equal(app.store.listPlayers(app.event.id).length, 2);
  } finally { app.store.close(); }
});

test('replay and voluntary leave produce one lifecycle event per player per heat', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false });
  try {
    const a = app.join('Ada'), b = app.join('Bea');
    const count = type => app.store.listActivity(app.event.id)
      .filter(row => row.type === type && row.properties.playerId === a.player.id).length;
    for (let attempt = 0; attempt < 3; attempt++) {
      app.engine.leave(app.event.slug, a.token);
      app.engine.replay(app.event.slug, a.token);
    }
    assert.equal(count('player_joined'), 1);
    assert.equal(count('player_left'), 1);

    app.engine.setTransport(app.event.slug, a.token, 'rehearsal');
    app.ready(a); app.ready(b);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    app.advance(3000);
    app.engine.command(app.event.slug, 'noMatch', {}, { id: 'operator' });
    app.engine.command(app.event.slug, 'nextHeat', {}, { id: 'operator' });
    app.engine.replay(app.event.slug, a.token);
    app.engine.leave(app.event.slug, a.token);
    app.engine.replay(app.event.slug, a.token);
    assert.equal(count('player_joined'), 2);
    assert.equal(count('player_left'), 2);
  } finally { app.store.close(); }
});

test('replay requires a newly enabled join lead once and ignores a stale optional lead after configuration changes', () => {
  const app = setup({ startMode: 'manual' });
  try {
    const a = app.join('Ada'), b = app.join('Bea');
    app.engine.leave(app.event.slug, a.token);
    app.engine.leave(app.event.slug, b.token);
    const original = app.store.getEvent(app.event.slug);
    app.store.saveEvent(original.slug, {
      ...original, leadCapture: { ...original.leadCapture, timing: 'join' },
    }, original.revision);
    assert.equal(app.engine.me(app.event.slug, a.token).player.needsJoinLead, true);
    assert.throws(() => app.engine.replay(app.event.slug, a.token),
      error => error.code === 'join_lead_required');
    assert.throws(() => app.engine.replay(app.event.slug, a.token, {
      lead: { fieldValues: { name: 'Ada', email: 'invalid', company: '' } },
    }), error => error.code === 'invalid_lead');
    assert.throws(() => app.engine.replay(app.event.slug, a.token, {
      lead: { fieldValues: { name: 'Ada', email: 'ada@example.com', removedField: 'old' } },
    }), error => error.code === 'lead_form_changed');
    assert.equal(app.engine.me(app.event.slug, a.token).player.status, 'left');
    assert.equal(app.store.findCapturedLead(app.event.id, a.player.id), null);

    const captured = app.engine.replay(app.event.slug, a.token, {
      lead: { fieldValues: { name: 'Ada', email: 'ada@example.com', company: '' } },
    });
    assert.equal(captured.player.needsJoinLead, false);
    assert.equal(app.store.listParticipantLeads(app.event.id, a.player.id).length, 1);
    assert.equal(app.store.listActivity(app.event.id).filter(row =>
      row.type === 'lead_captured' && row.properties.playerId === a.player.id).length, 1);
    app.engine.leave(app.event.slug, a.token);
    assert.equal(app.engine.replay(app.event.slug, a.token, { lead: { fieldValues: { stale: true } } })
      .player.needsJoinLead, false);
    assert.equal(app.store.listParticipantLeads(app.event.id, a.player.id).length, 1);

    const current = app.store.getEvent(app.event.slug);
    app.store.saveEvent(current.slug, {
      ...current, leadCapture: { ...current.leadCapture, timing: 'after-play' },
    }, current.revision);
    assert.equal(app.engine.me(app.event.slug, b.token).player.needsJoinLead, false);
    assert.equal(app.engine.replay(app.event.slug, b.token, { lead: { fieldValues: { stale: true } } })
      .player.needsJoinLead, false);
    assert.equal(app.store.findCapturedLead(app.event.id, b.player.id), null);
    app.engine.leave(app.event.slug, b.token);
    const afterPlay = app.store.getEvent(app.event.slug);
    app.store.saveEvent(afterPlay.slug, {
      ...afterPlay, leadCapture: { ...afterPlay.leadCapture, enabled: false },
    }, afterPlay.revision);
    assert.equal(app.engine.replay(app.event.slug, b.token, { lead: { fieldValues: { stale: true } } })
      .player.needsJoinLead, false);
    assert.equal(app.store.findCapturedLead(app.event.id, b.player.id), null);
  } finally { app.store.close(); }
});

test('a leaver can return on a later expo day but a stale token cannot rejoin indefinitely', () => {
  const app = setup();
  try {
    const visitor = app.join('Ada');
    app.engine.leave(app.event.slug, visitor.token);
    app.now += 2 * 24 * 60 * 60_000;
    assert.equal(app.engine.me(app.event.slug, visitor.token).player.status, 'left');
    const rejoined = app.engine.replay(app.event.slug, visitor.token);
    assert.equal(rejoined.player.id, visitor.player.id);
    app.engine.leave(app.event.slug, visitor.token);
    app.now += 8 * 24 * 60 * 60_000;
    assert.throws(() => app.engine.me(app.event.slug, visitor.token),
      error => error.code === 'unauthorized');
  } finally { app.store.close(); }
});

test('a player who leaves mid-hunt and queues again cannot submit stale evidence or receive that heat award', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual' });
  try {
    const a = app.join('Ada'), b = app.join('Bea');
    app.ready(a); app.ready(b);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    app.advance(3000);
    app.engine.leave(app.event.slug, a.token);
    assert.equal(app.engine.replay(app.event.slug, a.token).player.status, 'queued');
    assert.equal(app.engine.acceptJudgment(app.event.slug, {
      playerId: a.player.id, matched: true, source: 'rule', receiptAt: app.now,
    }).candidate, null);
    assert.throws(() => app.engine.command(app.event.slug, 'proposeWinner', {
      winners: [a.player.id],
    }, { id: 'operator' }), error => error.code === 'invalid_state');
    assert.throws(() => app.engine.command(app.event.slug, 'award', { winners: [a.player.id] }, { id: 'operator' }),
      error => error.code === 'invalid_state');
    assert.equal(app.engine.me(app.event.slug, a.token).player.queuePosition, 1);
    app.engine.command(app.event.slug, 'award', { winners: [b.player.id] }, { id: 'operator' });
    assert.equal(app.engine.me(app.event.slug, a.token).player.status, 'queued');
    assert.equal(app.engine.me(app.event.slug, a.token).player.queuePosition, 1);
    app.advance(app.event.resultSeconds * 1000);
    assert.equal(app.engine.me(app.event.slug, a.token).player.status, 'joined');
  } finally { app.store.close(); }
});

test('a player who leaves during countdown and replays stays queued through reveal and result', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: true });
  try {
    const a = app.join('Ada'), b = app.join('Bea');
    app.ready(a); app.ready(b);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    app.engine.leave(app.event.slug, a.token);
    assert.equal(app.engine.replay(app.event.slug, a.token).player.status, 'queued');
    app.advance(3000);
    assert.equal(app.engine.me(app.event.slug, a.token).player.status, 'queued');
    assert.equal(app.engine.me(app.event.slug, a.token).player.queuePosition, 1);
    app.engine.command(app.event.slug, 'award', { winners: [b.player.id] }, { id: 'operator' });
    assert.equal(app.engine.me(app.event.slug, a.token).player.status, 'queued');
    app.advance(app.event.resultSeconds * 1000);
    assert.equal(app.engine.me(app.event.slug, a.token).player.status, 'joined');
  } finally { app.store.close(); }
});

test('a finished player who makes no replay choice holds no spot in the next lobby', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: true });
  try {
    const a = app.join('Ada'), b = app.join('Bea');
    app.ready(a); app.ready(b);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    app.advance(3000);
    app.engine.command(app.event.slug, 'award', { winners: [a.player.id] }, { id: 'operator' });
    app.advance(app.event.resultSeconds * 1000);
    assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'lobby');
    assert.equal(app.engine.snapshot(app.event.slug).state.heat, 2);
    assert.equal(app.store.getPlayer(a.player.id).status, 'finished');
    assert.equal(app.engine.snapshot(app.event.slug).state.roster.some(player => player.id === a.player.id), false);
    assert.equal(app.engine.me(app.event.slug, a.token).player.status, 'finished');
    assert.equal(app.engine.me(app.event.slug, a.token).player.lastExitReason, null);
    assert.equal(app.store.listActivity(app.event.id).filter(row => row.type === 'player_kicked').length, 0);
  } finally { app.store.close(); }
});

test('a replayed player who never claims a lobby spot can replay again with the same token', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: true });
  try {
    const a = app.join('Ada'), b = app.join('Bea');
    app.ready(a); app.ready(b);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    app.advance(3000);
    app.engine.command(app.event.slug, 'award', { winners: [a.player.id] }, { id: 'operator' });
    app.advance(app.event.resultSeconds * 1000);
    const replay = app.engine.replay(app.event.slug, a.token);
    assert.equal(replay.player.id, a.player.id);
    assert.equal(replay.player.slot, 1);
    app.advance(25_000);
    assert.equal(app.engine.me(app.event.slug, a.token).player.status, 'joined');
    app.advance(5000);
    assert.equal(app.engine.me(app.event.slug, a.token).player.status, 'finished');
    assert.equal(app.engine.me(app.event.slug, a.token).player.lastExitReason, 'replay_timeout');
    assert.equal(app.store.getPlayer(a.player.id).slot, null);
    assert.equal(app.store.listActivity(app.event.id).filter(row => row.type === 'player_timed_out').length, 1);
    assert.equal(app.store.listActivity(app.event.id).filter(row => row.type === 'player_kicked').length, 0);
    const later = app.engine.replay(app.event.slug, a.token);
    assert.equal(later.player.id, a.player.id);
    assert.equal(later.player.lastExitReason, null);
    assert.equal(later.player.slot, 1);
  } finally { app.store.close(); }
});

test('a replay timeout keeps the last actually played result through later heats and corrections', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: true });
  try {
    const a = app.join('Ada'), b = app.join('Bea');
    app.ready(a); app.ready(b);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    app.advance(3000);
    app.engine.command(app.event.slug, 'award', { winners: [a.player.id] }, { id: 'operator' });
    const firstHeatId = app.store.listHeats(app.event.id)[0].id;
    app.advance(app.event.resultSeconds * 1000);
    app.engine.replay(app.event.slug, a.token);
    app.advance(30_000);
    assert.equal(app.engine.me(app.event.slug, a.token).player.lastExitReason, 'replay_timeout');
    assert.equal(app.engine.me(app.event.slug, a.token).player.heat, 2);
    assert.deepEqual(app.engine.me(app.event.slug, a.token).player.completedResult,
      { heat: 1, winners: [a.player.id], winnerNames: ['Ada'] });

    const c = app.join('Cora'), d = app.join('Dev');
    app.ready(c); app.ready(d);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    assert.equal(app.engine.me(app.event.slug, a.token).player.status, 'finished');
    app.advance(3000);
    app.engine.command(app.event.slug, 'award', { winners: [c.player.id] }, { id: 'operator' });
    app.engine.command(app.event.slug, 'correctHeat',
      { heatId: firstHeatId, winners: [b.player.id], reason: 'first heat corrected' }, { id: 'operator' });
    assert.deepEqual(app.engine.heartbeat(app.event.slug, a.token).player.completedResult,
      { heat: 1, winners: [b.player.id], winnerNames: ['Bea'] });
  } finally { app.store.close(); }
});

test('a later replay timeout cannot revive a heat someone explicitly left before its result', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 3, startMode: 'manual', autoAdvance: true });
  try {
    const earlyLeaver = app.join('Ada'), resultLeaver = app.join('Bea'), winner = app.join('Cy');
    for (const player of [earlyLeaver, resultLeaver, winner]) app.ready(player);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    app.advance(3000);
    app.engine.leave(app.event.slug, earlyLeaver.token);
    app.engine.command(app.event.slug, 'award', { winners: [winner.player.id] }, { id: 'operator' });
    app.engine.leave(app.event.slug, resultLeaver.token);
    app.advance(app.event.resultSeconds * 1000);
    app.engine.replay(app.event.slug, earlyLeaver.token);
    app.engine.replay(app.event.slug, resultLeaver.token);
    app.advance(30_000);

    const early = app.engine.me(app.event.slug, earlyLeaver.token).player;
    const late = app.engine.me(app.event.slug, resultLeaver.token).player;
    assert.equal(early.lastExitReason, 'replay_timeout');
    assert.equal(late.lastExitReason, 'replay_timeout');
    assert.equal(early.completedResult, null);
    assert.deepEqual(late.completedResult, {
      heat: 1, winners: [winner.player.id], winnerNames: ['Cy'],
    });

    // Older activity records have no phase; the lock/completion insertion order is still decisive.
    app.store.sql.prepare(`UPDATE activity SET properties_json=json_remove(properties_json,'$.phase')
      WHERE event_id=? AND type='player_left'`).run(app.event.id);
    assert.equal(app.engine.me(app.event.slug, earlyLeaver.token).player.completedResult, null);
    assert.deepEqual(app.engine.me(app.event.slug, resultLeaver.token).player.completedResult,
      { heat: 1, winners: [winner.player.id], winnerNames: ['Cy'] });
  } finally { app.store.close(); }
});

test('leaving and rejoining the lobby does not erase a later played result', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: true });
  try {
    const a = app.join('Ada');
    app.engine.leave(app.event.slug, a.token);
    app.engine.replay(app.event.slug, a.token);
    app.engine.setTransport(app.event.slug, a.token, 'rehearsal');
    app.ready(a);
    const b = app.join('Bea');
    app.ready(b);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    app.advance(3000);
    app.engine.command(app.event.slug, 'award', { winners: [a.player.id] }, { id: 'operator' });
    app.advance(app.event.resultSeconds * 1000);
    app.engine.replay(app.event.slug, a.token);
    app.advance(30_000);
    assert.deepEqual(app.engine.me(app.event.slug, a.token).player.completedResult, {
      heat: 1, winners: [a.player.id], winnerNames: ['Ada'],
    });
  } finally { app.store.close(); }
});

test('an active-heat leave still opts out after a lobby leave and rejoin in the same heat', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: true });
  try {
    const a = app.join('Ada');
    app.engine.leave(app.event.slug, a.token);
    app.engine.replay(app.event.slug, a.token);
    app.engine.setTransport(app.event.slug, a.token, 'rehearsal');
    app.ready(a);
    const b = app.join('Bea');
    app.ready(b);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    app.advance(3000);
    app.engine.leave(app.event.slug, a.token);
    app.engine.command(app.event.slug, 'award', { winners: [b.player.id] }, { id: 'operator' });
    app.advance(app.event.resultSeconds * 1000);
    app.engine.replay(app.event.slug, a.token);
    app.advance(30_000);
    assert.equal(app.engine.me(app.event.slug, a.token).player.completedResult, null);
    assert.equal(app.store.listActivity(app.event.id).filter(item => item.type === 'player_left' &&
      item.properties.playerId === a.player.id && item.properties.heat === 1).length, 1);
  } finally { app.store.close(); }
});

test('an unclaimed replay deadline survives a server restart', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: true });
  try {
    const a = app.join('Ada'), b = app.join('Bea');
    app.ready(a); app.ready(b);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    app.advance(3000);
    app.engine.command(app.event.slug, 'award', { winners: [a.player.id] }, { id: 'operator' });
    app.advance(app.event.resultSeconds * 1000);
    app.engine.replay(app.event.slug, a.token);
    assert.ok(app.store.getRuntime(app.event.id).slotClaims[a.player.id].deadlineAt);
    const restarted = new GameEngine({ store: app.store, now: () => app.now });
    app.now += 20_000;
    restarted.tickAll();
    assert.equal(restarted.me(app.event.slug, a.token).player.status, 'joined');
    app.now += 10_000;
    restarted.tickAll();
    assert.equal(restarted.me(app.event.slug, a.token).player.status, 'finished');
    assert.equal(restarted.me(app.event.slug, a.token).player.lastExitReason, 'replay_timeout');
  } finally { app.store.close(); }
});

test('an unclaimed replay slot passes to the next waiting visitor without ending that visitor session', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false });
  try {
    const a = app.join('Ada'), b = app.join('Bea');
    app.ready(a); app.ready(b);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    app.advance(3000);
    app.engine.command(app.event.slug, 'award', { winners: [a.player.id] }, { id: 'operator' });
    const c = app.join('Cy');
    app.advance(1);
    app.engine.replay(app.event.slug, a.token);
    app.advance(1);
    const d = app.join('Dee');
    app.engine.command(app.event.slug, 'nextHeat', {}, { id: 'operator' });
    app.engine.setTransport(app.event.slug, c.token, 'rehearsal');
    app.ready(c);
    assert.equal(app.store.getPlayer(a.player.id).slot, 2);
    assert.equal(app.engine.me(app.event.slug, d.token).player.queuePosition, 1);
    app.advance(20_000);
    app.engine.heartbeat(app.event.slug, c.token);
    app.engine.heartbeat(app.event.slug, d.token);
    app.advance(10_000);
    assert.equal(app.engine.me(app.event.slug, a.token).player.status, 'finished');
    assert.equal(app.engine.me(app.event.slug, d.token).player.status, 'joined');
    assert.equal(app.engine.me(app.event.slug, d.token).player.slot, 2);
    assert.equal(app.engine.me(app.event.slug, d.token).player.queuePosition, null);
  } finally { app.store.close(); }
});

test('pausing the booth freezes an unclaimed replay spot grace', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: true });
  try {
    const a = app.join('Ada'), b = app.join('Bea');
    app.ready(a); app.ready(b);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    app.advance(3000);
    app.engine.command(app.event.slug, 'award', { winners: [a.player.id] }, { id: 'operator' });
    app.advance(app.event.resultSeconds * 1000);
    app.engine.replay(app.event.slug, a.token);
    app.advance(10_000);
    app.engine.command(app.event.slug, 'pause', {}, { id: 'operator' });
    app.advance(60_000);
    assert.equal(app.engine.me(app.event.slug, a.token).player.status, 'joined');
    app.engine.command(app.event.slug, 'resume', {}, { id: 'operator' });
    app.advance(19_000);
    assert.equal(app.engine.me(app.event.slug, a.token).player.status, 'joined');
    app.advance(5_000);
    assert.equal(app.engine.me(app.event.slug, a.token).player.status, 'finished');
  } finally { app.store.close(); }
});

test('opening the next lobby while paused keeps promoted replay claims frozen until resume', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false });
  try {
    const a = app.join('Ada'), b = app.join('Bea');
    app.ready(a); app.ready(b);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    app.advance(3000);
    app.engine.command(app.event.slug, 'award', { winners: [a.player.id] }, { id: 'operator' });
    app.engine.replay(app.event.slug, a.token);
    app.engine.command(app.event.slug, 'pause', {}, { id: 'operator' });
    app.engine.command(app.event.slug, 'nextHeat', {}, { id: 'operator' });
    assert.equal(app.engine.snapshot(app.event.slug).state.paused, true);
    assert.equal(app.store.getRuntime(app.event.id).slotClaims[a.player.id].remainingMs, 30_000);
    app.advance(60_000);
    assert.equal(app.engine.me(app.event.slug, a.token).player.status, 'joined');
    app.engine.command(app.event.slug, 'resume', {}, { id: 'operator' });
    app.advance(30_000);
    assert.equal(app.engine.me(app.event.slug, a.token).player.status, 'finished');
  } finally { app.store.close(); }
});

test('a replayed ready player keeps the spot through a brief Video reconnect, then times out if disconnected', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: true });
  try {
    const a = app.join('Ada'), b = app.join('Bea');
    app.ready(a); app.ready(b);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    app.advance(3000);
    app.engine.command(app.event.slug, 'award', { winners: [a.player.id] }, { id: 'operator' });
    app.advance(app.event.resultSeconds * 1000);
    app.engine.replay(app.event.slug, a.token);
    app.engine.setTransport(app.event.slug, a.token, 'twilio');
    app.engine.setMediaConnected(app.event.slug, a.player.id, true);
    app.ready(a);
    app.engine.setMediaConnected(app.event.slug, a.player.id, false);
    assert.equal(app.engine.snapshot(app.event.slug).state.readyCount, 0);
    app.advance(20_000);
    app.engine.setMediaConnected(app.event.slug, a.player.id, true);
    app.engine.heartbeat(app.event.slug, a.token);
    app.advance(15_000);
    assert.equal(app.engine.me(app.event.slug, a.token).player.status, 'ready');
    app.engine.setMediaConnected(app.event.slug, a.player.id, false);
    app.advance(30_000);
    assert.equal(app.engine.me(app.event.slug, a.token).player.status, 'finished');
    assert.equal(app.engine.snapshot(app.event.slug).state.readyCount, 0);
  } finally { app.store.close(); }
});

test('a replaying player waits behind visitors already queued for a vacant lobby spot', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false });
  try {
    const first = app.join('Ada'), second = app.join('Bea');
    const third = app.join('Cy'), fourth = app.join('Dee'), fifth = app.join('Eve');
    app.ready(first); app.ready(second);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    app.advance(3000);
    app.engine.command(app.event.slug, 'award', { winners: [first.player.id] }, { id: 'operator' });
    app.engine.command(app.event.slug, 'nextHeat', {}, { id: 'operator' });
    assert.equal(app.engine.me(app.event.slug, third.token).player.slot, 1);
    assert.equal(app.engine.me(app.event.slug, fourth.token).player.slot, 2);
    assert.equal(app.engine.me(app.event.slug, fifth.token).player.queuePosition, 1);

    // Simulate a lobby vacancy left by an interrupted cleanup before replay arrives.
    app.store.updatePlayer(third.player.id, { slot: null, status: 'left' });
    const replay = app.engine.replay(app.event.slug, first.token);
    assert.equal(app.engine.me(app.event.slug, fifth.token).player.slot, 1);
    assert.equal(replay.player.status, 'queued');
    assert.equal(replay.player.queuePosition, 1);
    assert.equal(replay.state.queuedCount, 1);
  } finally { app.store.close(); }
});

test('restart advances absolute deadlines once and never duplicates heat completion', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false, roundSeconds: 5,
    prompts: [{ id: 'C01', text: 'SHOW SOMETHING RED', category: 'Color', judgeMode: 'rule',
      detector: 'color:red', enabled: true, seconds: null }] });
  const a = app.join('Ada'), b = app.join('Bea');
  app.ready(a); app.ready(b);
  app.engine.command(app.event.slug, 'queuePrompt', { promptId: 'C01' }, { id: 'operator' });
  app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
  app.now += 50_000;
  const restarted = new GameEngine({ store: app.store, now: () => app.now });
  assert.equal(restarted.snapshot(app.event.slug).state.phase, 'result');
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
  assert.deepEqual(app.engine.me(app.event.slug, a.token).player.completedResult,
    { heat: 1, winners: [], winnerNames: [] });
  assert.equal(app.store.listActivity(app.event.id).filter(row => row.type === 'heat_completed').length, 1);
  app.store.close();
});

test('finished phones can recover corrections to their own heat after newer heats complete', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false });
  try {
    const a = app.join('Ada'), b = app.join('Bea');
    app.ready(a); app.ready(b);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    app.advance(3000);
    app.engine.command(app.event.slug, 'award', { winners: [b.player.id] }, { id: 'operator' });
    const firstHeatId = app.store.listHeats(app.event.id)[0].id;
    app.engine.command(app.event.slug, 'nextHeat', {}, { id: 'operator' });
    const c = app.join('Cora'), d = app.join('Dev');
    app.ready(c); app.ready(d);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    app.advance(3000);
    app.engine.command(app.event.slug, 'award', { winners: [c.player.id] }, { id: 'operator' });
    app.engine.command(app.event.slug, 'nextHeat', {}, { id: 'operator' });

    const before = app.engine.snapshot(app.event.slug).state.resultRevision;
    app.engine.command(app.event.slug, 'correctHeat',
      { heatId: firstHeatId, winners: [a.player.id], reason: 'corrected first heat' }, { id: 'operator' });
    assert.equal(app.engine.snapshot(app.event.slug).state.resultRevision, before + 1);
    assert.deepEqual(app.engine.me(app.event.slug, a.token).player.completedResult,
      { heat: 1, winners: [a.player.id], winnerNames: ['Ada'] });
    assert.deepEqual(app.engine.heartbeat(app.event.slug, b.token).player.completedResult,
      { heat: 1, winners: [a.player.id], winnerNames: ['Ada'] });
    app.engine.command(app.event.slug, 'correctHeat',
      { heatId: firstHeatId, winners: [], reason: 'no valid match' }, { id: 'operator' });
    assert.deepEqual(app.engine.me(app.event.slug, a.token).player.completedResult,
      { heat: 1, winners: [], winnerNames: [] });
  } finally { app.store.close(); }
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

test('joining a paused lobby lets players get ready but waits for the operator to resume', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual' });
  app.engine.command(app.event.slug, 'pause', {}, { id: 'operator' });
  const a = app.join('Ada'), b = app.join('Bea');
  assert.deepEqual([a.player.slot, b.player.slot], [1, 2]);
  app.ready(a); app.ready(b);
  assert.equal(app.engine.snapshot(app.event.slug).state.readyCount, 2);
  app.advance(10_000);
  assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'lobby');
  app.engine.command(app.event.slug, 'resume', {}, { id: 'operator' });
  app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
  assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'countdown');
  app.store.close();
});

test('a paused lobby freezes an existing join window and starts a new one only on resume', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 3, startMode: 'flexible', joinSeconds: 30 });
  const a = app.join('Ada'), b = app.join('Bea');
  app.ready(a); app.ready(b);
  app.advance(10_000);
  app.engine.command(app.event.slug, 'pause', {}, { id: 'operator' });
  assert.equal(app.engine.snapshot(app.event.slug).state.readyDeadline, null);
  assert.equal(app.engine.snapshot(app.event.slug, 'operator').state.pauseRemaining.readyDeadline, 20_000);
  const c = app.join('Cy');
  app.ready(c);
  app.engine.heartbeat(app.event.slug, a.token);
  app.engine.heartbeat(app.event.slug, b.token);
  app.advance(21_000);
  assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'lobby');
  app.engine.command(app.event.slug, 'resume', {}, { id: 'operator' });
  assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'countdown',
    'a full roster starts immediately after resume');
  app.store.close();

  const waiting = setup({ minPlayers: 2, maxPlayers: 3, startMode: 'deadline', joinSeconds: 5 });
  waiting.engine.command(waiting.event.slug, 'pause', {}, { id: 'operator' });
  const d = waiting.join('Dee'), e = waiting.join('Eli');
  waiting.ready(d); waiting.ready(e);
  assert.equal(waiting.engine.snapshot(waiting.event.slug).state.readyDeadline, null);
  assert.equal(waiting.engine.snapshot(waiting.event.slug, 'operator').state.pauseRemaining.readyDeadline, 5000);
  waiting.advance(6000);
  assert.equal(waiting.engine.snapshot(waiting.event.slug).state.phase, 'lobby');
  waiting.engine.command(waiting.event.slug, 'resume', {}, { id: 'operator' });
  assert.equal(Date.parse(waiting.engine.snapshot(waiting.event.slug).state.readyDeadline), waiting.now + 5000);
  waiting.advance(4999);
  assert.equal(waiting.engine.snapshot(waiting.event.slug).state.phase, 'lobby');
  waiting.advance(1);
  assert.equal(waiting.engine.snapshot(waiting.event.slug).state.phase, 'countdown');
  waiting.store.close();
});

test('paused lobby readiness changes clear and restart the frozen join window', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 3, startMode: 'deadline', joinSeconds: 5 });
  const a = app.join('Ada'), b = app.join('Bea');
  app.engine.setTransport(app.event.slug, b.token, 'twilio');
  app.engine.setMediaConnected(app.event.slug, b.player.id, true);
  app.ready(a); app.ready(b);
  app.advance(2000);
  app.engine.command(app.event.slug, 'pause', {}, { id: 'operator' });
  assert.equal(app.engine.snapshot(app.event.slug, 'operator').state.pauseRemaining.readyDeadline, 3000);
  app.engine.setMediaConnected(app.event.slug, b.player.id, false);
  assert.equal(app.engine.snapshot(app.event.slug, 'operator').state.pauseRemaining.readyDeadline, undefined);
  app.engine.setMediaConnected(app.event.slug, b.player.id, true);
  assert.equal(app.engine.snapshot(app.event.slug, 'operator').state.pauseRemaining.readyDeadline, 5000);
  app.engine.setTransport(app.event.slug, b.token, 'rehearsal');
  app.engine.setTransport(app.event.slug, b.token, 'twilio');
  assert.equal(app.engine.snapshot(app.event.slug, 'operator').state.pauseRemaining.readyDeadline, undefined);
  app.engine.setMediaConnected(app.event.slug, b.player.id, true);
  assert.equal(app.engine.snapshot(app.event.slug, 'operator').state.pauseRemaining.readyDeadline, 5000);
  app.engine.command(app.event.slug, 'resume', {}, { id: 'operator' });
  assert.equal(Date.parse(app.engine.snapshot(app.event.slug).state.readyDeadline), app.now + 5000);
  app.store.close();
});

test('joining while a paused heat is underway stays queued for the next heat', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual' });
  const a = app.join('Ada'), b = app.join('Bea');
  app.ready(a); app.ready(b);
  app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
  app.engine.command(app.event.slug, 'pause', {}, { id: 'operator' });
  const c = app.join('Cy');
  assert.equal(c.player.status, 'queued');
  assert.equal(c.player.slot, null);
  assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'countdown');
  app.store.close();
});

test('a category ballot opened while paused receives its full vote window on resume', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'capacity' });
  app.engine.command(app.event.slug, 'pause', {}, { id: 'operator' });
  const a = app.join('Ada'), b = app.join('Bea');
  app.ready(a); app.ready(b);
  app.engine.command(app.event.slug, 'openVote', { type: 'category' }, { id: 'operator' });
  let state = app.engine.snapshot(app.event.slug, 'operator').state;
  assert.equal(state.phase, 'lobby');
  assert.equal(state.vote.status, 'open');
  assert.equal(state.vote.closesAt, null);
  assert.equal(state.pauseRemaining.vote, app.event.vote.windowSeconds * 1000);

  app.advance(13_000);
  assert.equal(app.engine.snapshot(app.event.slug).state.vote.status, 'open');
  app.engine.heartbeat(app.event.slug, a.token);
  app.engine.heartbeat(app.event.slug, b.token);
  app.engine.command(app.event.slug, 'resume', {}, { id: 'operator' });
  state = app.engine.snapshot(app.event.slug).state;
  assert.equal(state.phase, 'lobby');
  assert.equal(Date.parse(state.vote.closesAt), app.now + app.event.vote.windowSeconds * 1000);
  app.advance(app.event.vote.windowSeconds * 1000 - 1);
  assert.equal(app.engine.snapshot(app.event.slug).state.vote.status, 'open');
  assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'lobby');
  app.advance(1);
  state = app.engine.snapshot(app.event.slug).state;
  assert.equal(state.vote, null);
  assert.equal(state.phase, 'countdown');
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

test('a disconnected player who times out during a long hunt remains a loser on the result wall', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false,
    prompts: [{ id: 'long-object', text: 'SHOW A KEYBOARD', category: 'Object', judgeMode: 'operator',
      detector: 'manual', enabled: true, seconds: 180 }] });
  try {
    const a = app.join('Ada'), b = app.join('Bea');
    for (const player of [a, b]) {
      app.engine.setTransport(app.event.slug, player.token, 'twilio');
      app.engine.setMediaConnected(app.event.slug, player.player.id, true);
      app.ready(player);
    }
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    app.advance(3000);
    assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'hunt');
    app.engine.setMediaConnected(app.event.slug, a.player.id, false);
    assert.equal(app.engine.acceptJudgment(app.event.slug, { playerId: a.player.id, matched: true,
      source: 'ai', confidence: 0.99, receiptAt: app.now }).candidate, null);

    app.advance(30_000);
    app.engine.heartbeat(app.event.slug, b.token);
    app.advance(30_001);
    assert.equal(app.store.getPlayer(a.player.id).status, 'left');
    assert.equal(app.store.getPlayer(a.player.id).slot, null);
    assert.deepEqual(app.engine.snapshot(app.event.slug).state.roster.map(player => player.alias), ['Bea']);
    assert.throws(() => app.engine.command(app.event.slug, 'award', { winners: [a.player.id] }, { id: 'operator' }),
      error => error.code === 'invalid_state');
    app.engine.heartbeat(app.event.slug, b.token);

    for (const milliseconds of [30_000, 30_000, 30_000, 29_999]) {
      app.advance(milliseconds);
      app.engine.heartbeat(app.event.slug, b.token);
    }
    assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'review');
    app.engine.command(app.event.slug, 'award', { winners: [b.player.id] }, { id: 'operator' });
    const result = app.engine.snapshot(app.event.slug).state;
    assert.equal(result.phase, 'result');
    assert.deepEqual(result.winners, [b.player.id]);
    assert.deepEqual(result.roster.map(player => [player.id, player.alias, player.slot]), [
      [a.player.id, 'Ada', 1], [b.player.id, 'Bea', 2],
    ]);
    assert.equal(result.roster[0].mediaConnected, false);
    assert.equal(app.store.listActivity(app.event.id).filter(row => row.type === 'player_timed_out').length, 1);
  } finally { app.store.close(); }
});

test('a player who explicitly leaves mid-heat opts out of the result wall while a kicked player stays excluded', () => {
  const app = setup({ minPlayers: 2, maxPlayers: 3, startMode: 'manual', autoAdvance: false });
  try {
    const a = app.join('Ada'), b = app.join('Bea'), c = app.join('Cy');
    for (const player of [a, b, c]) app.ready(player);
    app.engine.command(app.event.slug, 'start', {}, { id: 'operator' });
    app.advance(3000);
    app.engine.leave(app.event.slug, a.token);
    app.engine.command(app.event.slug, 'kickPlayer', { playerId: b.player.id }, { id: 'operator' });
    app.engine.command(app.event.slug, 'award', { winners: [c.player.id] }, { id: 'operator' });
    assert.deepEqual(app.engine.snapshot(app.event.slug).state.roster.map(player => player.alias), ['Cy']);
  } finally { app.store.close(); }
});
