import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const playerSource = readFileSync(new URL('../../public/player.js', import.meta.url), 'utf8');

function phone() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, dataset: {}, innerHTML: '', textContent: '', hidden: false, style: {},
      addEventListener() {}, setAttribute() {}, querySelector() { return null; },
      querySelectorAll() { return []; }, classList: { add() {}, remove() {}, toggle() {} },
    });
    return elements.get(id);
  };
  const storage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  let completedResult = null;
  const heldMe = [];
  const context = vm.createContext({
    location: { pathname: '/e/live-scavenger-hunt/play', search: '' }, URLSearchParams,
    document: { getElementById: element, querySelectorAll() { return []; }, querySelector() { return null; } },
    window: { addEventListener() {} }, localStorage: storage, sessionStorage: storage,
    innerWidth: 390, innerHeight: 844,
    setInterval() { return 1; }, clearInterval() {}, setTimeout() { return 1; }, clearTimeout() {},
    fetch(url) {
      if (String(url).endsWith('/me')) {
        const held = heldMe.shift();
        if (held) return held.promise;
        return Promise.resolve({ ok: true, json: async () => ({
          player: { id: 'a', heat: 1, status: 'finished', completedResult },
        }) });
      }
      // The module starts its normal boot request; hold it while the test supplies states directly.
      return new Promise(() => {});
    },
    EventSource: class {}, Date, Math, JSON, Number, String, Array, Set, Map, Promise, Blob, console,
  });
  vm.runInContext(playerSource, context);
  vm.runInContext(`app.event={name:'Live Scavenger Hunt',resultSeconds:15,mediaMode:'rehearsal',leadCapture:{enabled:false}};
    app.player={id:'a',alias:'Ada',heat:1,status:'finished',slot:1};app.view='live';app.token='test-token'`, context);
  return {
    html: () => element('screen').innerHTML,
    state: (payload, player = null) => {
      context.payload = { ...payload, ...(player ? { player } : {}) };
      if (player) vm.runInContext('applyPrivatePlayer(payload.player)', context);
      vm.runInContext('applyState(payload)', context);
    },
    setCompletedResult: value => { completedResult = value; },
    holdNextMe: () => {
      let release;
      const promise = new Promise(resolve => { release = resolve; });
      heldMe.push({ promise });
      return result => release({ ok: true, json: async () => ({
        player: { id: 'a', heat: 1, status: 'finished', completedResult: result },
      }) });
    },
    expireReveal: () => vm.runInContext('app.outcome.decisionAt=0;app.outcome.minRevealUntil=0;render(true)', context),
    outcome: () => vm.runInContext('app.outcome && ({heat:app.outcome.heat,winners:app.outcome.winners,winnerNames:app.outcome.winnerNames})', context),
  };
}

const roster = [
  { id: 'a', alias: 'Ada', slot: 1, status: 'finished', mediaConnected: true },
  { id: 'b', alias: 'Bea', slot: 2, status: 'finished', mediaConnected: true },
];
const state = (phase, heat, version, resultRevision, winners = [], players = roster) => ({
  state: { phase, heat, version, resultRevision, winners, roster: players, paused: false,
    readyCount: 0, queuedCount: 0, resultEndsAt: new Date(Date.now() + 15_000).toISOString() },
});

test('phone updates win, loss, tie, and no-match when staff correct a displayed heat', async () => {
  const player = phone();
  player.state(state('result', 1, 1, 0, ['b']),
    { id: 'a', alias: 'Ada', heat: 1, status: 'finished', completedResult: { heat: 1, winners: ['b'], winnerNames: ['Bea'] } });
  assert.match(player.html(), /NOT THIS/);
  player.state(state('result', 1, 2, 1, ['a']));
  assert.match(player.html(), /YOU FOUND/);

  player.state(state('lobby', 2, 3, 1, [], []));
  player.expireReveal();
  // A cached private response from before the correction must not revert the result.
  assert.match(player.html(), /YOU FOUND IT FIRST/);
  player.state(state('lobby', 3, 4, 1, [], []));

  player.setCompletedResult({ heat: 1, winners: ['b'], winnerNames: ['Bea'] });
  player.state(state('lobby', 3, 5, 2, [], []));
  await new Promise(setImmediate);
  assert.match(player.html(), /ANOTHER PLAYER WON/);

  player.setCompletedResult({ heat: 1, winners: [], winnerNames: [] });
  player.state(state('lobby', 3, 6, 3, [], []));
  await new Promise(setImmediate);
  assert.match(player.html(), /NO VERIFIED FIND/);

  player.setCompletedResult({ heat: 1, winners: ['a', 'b'], winnerNames: ['Ada', 'Bea'] });
  player.state(state('lobby', 3, 7, 4, [], []));
  await new Promise(setImmediate);
  assert.match(player.html(), /YOU TIED FOR FIRST/);
});

test('a returning phone restores the corrected outcome after missing the result screen', () => {
  const player = phone();
  player.state(state('lobby', 3, 9, 2, [], []),
    { id: 'a', alias: 'Ada', heat: 1, status: 'finished', completedResult: { heat: 1, winners: ['b'], winnerNames: ['Bea'] } });
  assert.match(player.html(), /ANOTHER PLAYER WON/);
  assert.deepEqual([...player.outcome().winners], ['b']);
});

test('a returning phone restores its own result while a newer heat is showing results', () => {
  const player = phone();
  player.state(state('result', 3, 9, 2, ['c'], [
    { id: 'c', alias: 'Cora', slot: 1, status: 'finished', mediaConnected: true },
    { id: 'd', alias: 'Dev', slot: 2, status: 'finished', mediaConnected: true },
  ]), { id: 'a', alias: 'Ada', heat: 1, status: 'finished', completedResult: {
    heat: 1, winners: ['b'], winnerNames: ['Bea'],
  } });
  assert.match(player.html(), /ANOTHER PLAYER WON/);
  assert.equal(player.outcome().heat, 1);
});

test('replay timeout preserves the earlier competed result and accepts later corrections', async () => {
  const player = phone();
  player.state(state('lobby', 3, 9, 0, [], []),
    { id: 'a', alias: 'Ada', heat: 2, status: 'finished', lastExitReason: 'replay_timeout',
      completedResult: { heat: 1, winners: ['b'], winnerNames: ['Bea'] } });
  assert.equal(player.outcome().heat, 1);
  assert.deepEqual([...player.outcome().winners], ['b']);

  player.setCompletedResult({ heat: 1, winners: ['a'], winnerNames: ['Ada'] });
  player.state(state('lobby', 3, 10, 1, [], []));
  await new Promise(setImmediate);
  assert.equal(player.outcome().heat, 1);
  assert.deepEqual([...player.outcome().winners], ['a']);
});

test('replay timeout still shows the corrected prior result alongside rejoin guidance', () => {
  for (const { winners, result, variant } of [
    { winners: ['a'], result: 'YOU FOUND IT FIRST', variant: 'win' },
    { winners: ['b'], result: 'ANOTHER PLAYER WON', variant: 'lose' },
    { winners: ['a', 'b'], result: 'YOU TIED FOR FIRST', variant: 'win' },
    { winners: [], result: 'NO VERIFIED FIND', variant: 'neutral' },
  ]) {
    const player = phone();
    player.state(state('lobby', 3, 9, 2, [], []),
      { id: 'a', alias: 'Ada', heat: 2, status: 'finished', lastExitReason: 'replay_timeout',
        completedResult: { heat: 1, winners, winnerNames: winners.map(id => id === 'a' ? 'Ada' : 'Bea') } });
    assert.match(player.html(), new RegExp(result));
    assert.match(player.html(), new RegExp(`decision-${variant}`));
    assert.match(player.html(), /Play again to rejoin without scanning/);
  }
});

test('a phone replaces a stale result when the same player finishes a newer heat', () => {
  const player = phone();
  player.state(state('result', 1, 1, 0, ['a']));
  player.state(state('result', 2, 2, 0, ['b']));
  assert.equal(player.outcome().heat, 2);
  assert.match(player.html(), /NOT THIS/);
});

test('a phone adopts a newer completed heat after missing that result window', () => {
  const player = phone();
  player.state(state('result', 1, 1, 0, ['a']));
  player.expireReveal();
  player.state(state('lobby', 3, 3, 0, [], []),
    { id: 'a', alias: 'Ada', heat: 2, status: 'finished', completedResult: {
      heat: 2, winners: ['b'], winnerNames: ['Bea'],
    } });
  assert.equal(player.outcome().heat, 2);
  assert.match(player.html(), /ANOTHER PLAYER WON/);
});

test('two rapid corrections converge when the first phone refresh is still in flight', async () => {
  const player = phone();
  player.state(state('result', 1, 1, 0, ['b']));
  player.state(state('lobby', 2, 2, 0, [], []));
  player.expireReveal();

  const releaseFirst = player.holdNextMe();
  player.state(state('lobby', 3, 3, 1, [], []));
  player.setCompletedResult({ heat: 1, winners: [], winnerNames: [] });
  player.state(state('lobby', 3, 4, 2, [], []));
  releaseFirst({ heat: 1, winners: ['a'], winnerNames: ['Ada'] });
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.match(player.html(), /NO VERIFIED FIND/);
});
