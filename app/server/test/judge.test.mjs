import test from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { openDatabase } from '../db.mjs';
import { GameEngine } from '../engine.mjs';
import { JudgeService, decodeEvidence, detectColor } from '../judge.mjs';
import { OpenAIVision } from '../openai-vision.mjs';

function frame(color = [255, 0, 0]) {
  const width = 120, height = 160;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 4;
    const paint = x > 32 && x < 88 && y > 42 && y < 118;
    data[index] = paint ? color[0] : 238;
    data[index + 1] = paint ? color[1] : 238;
    data[index + 2] = paint ? color[2] : 238;
    data[index + 3] = 255;
  }
  return jpeg.encode({ data, width, height }, 72).data;
}

function arena(prompt = { id: 'C01', text: 'SHOW SOMETHING RED', category: 'Color', judgeMode: 'rule', detector: 'color:red', enabled: true, seconds: 10 }) {
  const store = openDatabase();
  let event = store.seedDefault();
  event = store.saveEvent(event.slug, { ...event, minPlayers: 2, maxPlayers: 2, startMode: 'manual', autoAdvance: false, prompts: [prompt] }, event.revision);
  let now = Date.UTC(2026, 0, 1, 12);
  const engine = new GameEngine({ store, now: () => now });
  const entries = ['Ada', 'Bea'].map(alias => {
    const entry = engine.join(event.slug, { alias, displayConsent: true });
    engine.setTransport(event.slug, entry.token, 'rehearsal');
    engine.ready(event.slug, entry.token);
    return entry;
  });
  engine.command(event.slug, 'start', {}, { id: 'operator' });
  now += 3000;
  engine.tickAll();
  return { store, event, engine, entries, get now() { return now; }, set now(value) { now = value; } };
}

test('local referee recognizes a visible central color over stable frames and rejects wrong color', async () => {
  const red = frame([245, 15, 20]), blue = frame([20, 40, 245]);
  assert.ok(detectColor(decodeEvidence(red), 'red').matched);
  assert.equal(detectColor(decodeEvidence(blue), 'red').matched, false);
  const app = arena();
  const judge = new JudgeService({ engine: app.engine, now: () => app.now,
    vision: { enabled: () => false } });
  assert.equal((await judge.submit({ slug: app.event.slug, playerId: app.entries[0].player.id, buffer: red, receiptAt: app.now })).status, 'pending');
  app.now += 310;
  assert.equal((await judge.submit({ slug: app.event.slug, playerId: app.entries[0].player.id, buffer: red, receiptAt: app.now })).status, 'pending');
  app.now += 310;
  const verified = await judge.submit({ slug: app.event.slug, playerId: app.entries[0].player.id, buffer: red, receiptAt: app.now });
  assert.equal(verified.status, 'verified');
  app.now += 500;
  app.engine.tickAll();
  assert.deepEqual(app.engine.snapshot(app.event.slug).state.winners, [app.entries[0].player.id]);
  app.store.close();
});

test('AI vision returns a proposal that the operator may override, while unconfigured AI stays manual', async () => {
  const prompt = { id: 'O01', text: 'SHOW A CUP', category: 'Object', judgeMode: 'ai-assisted', detector: 'object:cup', enabled: true, seconds: 10 };
  const app = arena(prompt);
  const calls = [];
  const judge = new JudgeService({ engine: app.engine, now: () => app.now,
    vision: { enabled: () => true, judge: async (...args) => { calls.push(args); return { matched: true, confidence: 0.88, explanation: 'Cup clearly visible' }; } } });
  const result = await judge.submit({ slug: app.event.slug, playerId: app.entries[0].player.id, buffer: frame(), receiptAt: app.now });
  assert.equal(result.status, 'verified');
  assert.equal(calls.length, 1);
  app.now += 500;
  app.engine.tickAll();
  assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'review');
  app.engine.command(app.event.slug, 'award', { winners: [app.entries[1].player.id], reason: 'cup was held up first' }, { id: 'operator' });
  assert.deepEqual(app.engine.snapshot(app.event.slug).state.winners, [app.entries[1].player.id]);
  app.store.close();

  const noKey = arena(prompt);
  const manual = new JudgeService({ engine: noKey.engine, vision: { enabled: () => false } });
  assert.equal((await manual.submit({ slug: noKey.event.slug, playerId: noKey.entries[0].player.id, buffer: frame(), receiptAt: noKey.now })).status, 'manual');
  noKey.store.close();
});

test('wall evidence gives the phone camera the first chance to judge after GO', async () => {
  const prompt = { id: 'O01', text: 'SHOW A CUP', category: 'Object', judgeMode: 'ai-assisted', detector: 'object:cup', enabled: true, seconds: 10 };
  const app = arena(prompt);
  const playerId = app.entries[0].player.id;
  app.engine.setTransport(app.event.slug, app.entries[0].token, 'twilio');
  app.engine.setMediaConnected(app.event.slug, playerId, true);
  const judge = new JudgeService({ engine: app.engine, now: () => app.now,
    vision: { enabled: () => true, judge: async () => ({ matched: true, confidence: 0.9, explanation: 'Cup in phone frame' }) } });
  const wall = await judge.submit({ slug: app.event.slug, playerId, buffer: frame(), receiptAt: app.now + 500, source: 'wall' });
  assert.equal(wall.status, 'pending');
  const phone = await judge.submit({ slug: app.event.slug, playerId, buffer: frame(), receiptAt: app.now + 700, source: 'phone' });
  assert.equal(phone.status, 'verified');
  assert.equal(app.engine.store.getRuntime(app.event.id).candidates[0].explanation, 'Cup in phone frame');
  app.store.close();
});

test('phone AI evidence bypasses a wall review in flight and takes priority over its later verdict', async () => {
  const prompt = { id: 'O01', text: 'SHOW A CUP', category: 'Object', judgeMode: 'ai-assisted', detector: 'object:cup', enabled: true, seconds: 10 };
  const app = arena(prompt);
  const playerId = app.entries[0].player.id;
  app.engine.setTransport(app.event.slug, app.entries[0].token, 'twilio');
  app.engine.setMediaConnected(app.event.slug, playerId, true);
  const wallFrame = frame([20, 40, 245]);
  const phoneFrame = frame([245, 15, 20]);
  let releaseWall;
  const wallReview = new Promise(resolve => { releaseWall = resolve; });
  const judge = new JudgeService({ engine: app.engine, now: () => app.now,
    vision: { enabled: () => true, judge: buffer => buffer === wallFrame ? wallReview :
      Promise.resolve({ matched: true, confidence: 0.96, explanation: 'Cup in raw phone frame' }) } });
  const wall = judge.submit({ slug: app.event.slug, playerId, buffer: wallFrame, receiptAt: app.now + 3000, source: 'wall' });
  const phone = await judge.submit({ slug: app.event.slug, playerId, buffer: phoneFrame, receiptAt: app.now + 3200, source: 'phone' });
  assert.equal(phone.status, 'verified');
  releaseWall({ matched: true, confidence: 0.99, explanation: 'Cup in cropped wall frame' });
  assert.equal((await wall).status, 'pending');
  assert.deepEqual(app.engine.store.getRuntime(app.event.id).candidates.map(item => item.explanation), ['Cup in raw phone frame']);
  app.store.close();
});

test('a superseded wall AI error cannot block later phone judging', async () => {
  const prompt = { id: 'O01', text: 'SHOW A CUP', category: 'Object', judgeMode: 'ai-assisted', detector: 'object:cup', enabled: true, seconds: 10 };
  const app = arena(prompt);
  const playerId = app.entries[0].player.id;
  app.engine.setTransport(app.event.slug, app.entries[0].token, 'twilio');
  app.engine.setMediaConnected(app.event.slug, playerId, true);
  const wallFrame = frame([20, 40, 245]);
  const phoneFrame = frame([245, 15, 20]);
  let rejectWall;
  const wallReview = new Promise((resolve, reject) => { rejectWall = reject; });
  let phoneReviews = 0;
  const judge = new JudgeService({ engine: app.engine, now: () => app.now,
    vision: { enabled: () => true, judge: buffer => buffer === wallFrame ? wallReview :
      Promise.resolve({ matched: ++phoneReviews > 1, confidence: 0.94, explanation: 'Cup in raw phone frame' }) } });
  const wall = judge.submit({ slug: app.event.slug, playerId, buffer: wallFrame, receiptAt: app.now + 3000, source: 'wall' });
  assert.equal((await judge.submit({ slug: app.event.slug, playerId, buffer: phoneFrame,
    receiptAt: app.now + 3200, source: 'phone' })).status, 'pending');
  rejectWall(new Error('Wall frame failed'));
  assert.equal((await wall).status, 'pending');
  assert.equal(app.engine.store.getRuntime(app.event.id).judgeNotice, null);
  assert.equal((await judge.submit({ slug: app.event.slug, playerId, buffer: phoneFrame,
    receiptAt: app.now + 5100, source: 'phone' })).status, 'verified');
  app.store.close();
});

test('wall AI evidence waits for a fresh phone frame, then judges when phone frames are absent or stale', async () => {
  const prompt = { id: 'O01', text: 'SHOW A CUP', category: 'Object', judgeMode: 'ai-assisted', detector: 'object:cup', enabled: true, seconds: 10 };
  for (const phoneAt of [null, 3000]) {
    const app = arena(prompt);
    const playerId = app.entries[0].player.id;
    app.engine.setTransport(app.event.slug, app.entries[0].token, 'twilio');
    app.engine.setMediaConnected(app.event.slug, playerId, true);
    const phoneFrame = frame([20, 40, 245]);
    const judge = new JudgeService({ engine: app.engine, now: () => app.now,
      vision: { enabled: () => true, judge: async buffer => ({ matched: buffer !== phoneFrame,
        confidence: 0.9, explanation: 'Cup in wall frame' }) } });
    if (phoneAt !== null) {
      const phone = await judge.submit({ slug: app.event.slug, playerId, buffer: phoneFrame,
        receiptAt: app.now + phoneAt, source: 'phone' });
      assert.equal(phone.status, 'pending');
      const fresh = await judge.submit({ slug: app.event.slug, playerId, buffer: frame(),
        receiptAt: app.now + 5000, source: 'wall' });
      assert.equal(fresh.status, 'pending');
      assert.deepEqual(app.engine.store.getRuntime(app.event.id).candidates, []);
    }
    const wall = await judge.submit({ slug: app.event.slug, playerId, buffer: frame(),
      receiptAt: app.now + (phoneAt === null ? 5000 : 8000), source: 'wall' });
    assert.equal(wall.status, 'verified');
    assert.equal(app.engine.store.getRuntime(app.event.id).candidates[0].explanation, 'Cup in wall frame');
    app.store.close();
  }
});

test('phone frames uploaded during a paused hunt keep wall judging secondary after resume', async () => {
  const prompt = { id: 'O01', text: 'SHOW A CUP', category: 'Object', judgeMode: 'ai-assisted', detector: 'object:cup', enabled: true, seconds: 10 };
  const app = arena(prompt);
  const playerId = app.entries[0].player.id;
  app.engine.setTransport(app.event.slug, app.entries[0].token, 'twilio');
  app.engine.setMediaConnected(app.event.slug, playerId, true);
  const judge = new JudgeService({ engine: app.engine, now: () => app.now,
    vision: { enabled: () => true, judge: async () => ({ matched: true, confidence: 0.92, explanation: 'Cup in wall frame' }) } });
  app.now += 1000;
  app.engine.command(app.event.slug, 'pause', {}, { id: 'operator' });
  app.now += 15_000;
  const pausedPhone = await judge.submit({ slug: app.event.slug, playerId, buffer: frame(),
    receiptAt: app.now, source: 'phone' });
  assert.equal(pausedPhone.status, 'ignored');
  assert.deepEqual(app.engine.store.getRuntime(app.event.id).candidates, []);
  app.now += 500;
  app.engine.command(app.event.slug, 'resume', {}, { id: 'operator' });
  const freshWall = await judge.submit({ slug: app.event.slug, playerId, buffer: frame(),
    receiptAt: app.now + 100, source: 'wall' });
  assert.equal(freshWall.status, 'pending');
  assert.deepEqual(app.engine.store.getRuntime(app.event.id).candidates, []);
  app.now += 4000;
  const staleWall = await judge.submit({ slug: app.event.slug, playerId, buffer: frame(),
    receiptAt: app.now, source: 'wall' });
  assert.equal(staleWall.status, 'verified');
  app.store.close();
});

test('phone color evidence stays stable at the live frame cadence', async () => {
  const app = arena();
  const judge = new JudgeService({ engine: app.engine, now: () => app.now,
    vision: { enabled: () => false } });
  const playerId = app.entries[0].player.id;
  const red = frame([245, 15, 20]);
  assert.equal((await judge.submit({ slug: app.event.slug, playerId, buffer: red, receiptAt: app.now, source: 'phone' })).status, 'pending');
  assert.equal((await judge.submit({ slug: app.event.slug, playerId, buffer: red, receiptAt: app.now + 1600, source: 'phone' })).status, 'pending');
  assert.equal((await judge.submit({ slug: app.event.slug, playerId, buffer: red, receiptAt: app.now + 3200, source: 'phone' })).status, 'verified');
  app.store.close();
});

test('wall color evidence can judge a missing phone stream at six-player cadence', async () => {
  const app = arena();
  const judge = new JudgeService({ engine: app.engine, now: () => app.now,
    vision: { enabled: () => false } });
  const playerId = app.entries[0].player.id;
  const red = frame([245, 15, 20]);
  assert.equal((await judge.submit({ slug: app.event.slug, playerId, buffer: red, receiptAt: app.now + 3000, source: 'wall' })).status, 'pending');
  assert.equal((await judge.submit({ slug: app.event.slug, playerId, buffer: red, receiptAt: app.now + 7500, source: 'wall' })).status, 'verified');
  app.store.close();
});

test('a disconnected Twilio player cannot submit a winning frame or keep an in-flight verdict', async () => {
  const app = arena();
  const playerId = app.entries[0].player.id;
  const red = frame([245, 15, 20]);
  const judge = new JudgeService({ engine: app.engine, now: () => app.now,
    vision: { enabled: () => false } });
  app.engine.setTransport(app.event.slug, app.entries[0].token, 'twilio');
  app.engine.setMediaConnected(app.event.slug, playerId, true);
  assert.equal((await judge.submit({ slug: app.event.slug, playerId, buffer: red, receiptAt: app.now })).status, 'pending');
  app.engine.setMediaConnected(app.event.slug, playerId, false);
  app.now += 620;
  const disconnected = await judge.submit({ slug: app.event.slug, playerId, buffer: red, receiptAt: app.now });
  assert.equal(disconnected.status, 'ignored');
  assert.equal(disconnected.reason, 'media_disconnected');
  assert.deepEqual(app.engine.acceptJudgment(app.event.slug, {
    playerId, matched: true, confidence: 1, source: 'rule', receiptAt: app.now,
  }), { candidate: null });
  assert.deepEqual(app.engine.store.getRuntime(app.event.id).candidates, []);
  app.store.close();

  const prompt = { id: 'O01', text: 'SHOW A CUP', category: 'Object', judgeMode: 'ai-assisted', detector: 'object:cup', enabled: true, seconds: 10 };
  const delayed = arena(prompt);
  const delayedId = delayed.entries[0].player.id;
  delayed.engine.setTransport(delayed.event.slug, delayed.entries[0].token, 'twilio');
  delayed.engine.setMediaConnected(delayed.event.slug, delayedId, true);
  let resolveVerdict;
  const waiting = new Promise(resolve => { resolveVerdict = resolve; });
  const aiJudge = new JudgeService({ engine: delayed.engine, now: () => delayed.now,
    vision: { enabled: () => true, judge: () => waiting } });
  const submission = aiJudge.submit({ slug: delayed.event.slug, playerId: delayedId,
    buffer: frame(), receiptAt: delayed.now });
  delayed.engine.setMediaConnected(delayed.event.slug, delayedId, false);
  resolveVerdict({ matched: true, confidence: 0.99, explanation: 'Cup clearly visible' });
  assert.equal((await submission).status, 'ignored');
  assert.deepEqual(delayed.engine.store.getRuntime(delayed.event.id).candidates, []);
  delayed.store.close();
});

test('AI failure holds review for a visible operator decision, including a tie', async () => {
  const prompt = { id: 'O01', text: 'SHOW A CUP', category: 'Object', judgeMode: 'ai-assisted', detector: 'object:cup', enabled: true, seconds: 10 };
  const app = arena(prompt);
  const judge = new JudgeService({ engine: app.engine, now: () => app.now,
    vision: { enabled: () => true, judge: async () => { throw new Error('provider timed out'); } } });
  const result = await judge.submit({ slug: app.event.slug, playerId: app.entries[0].player.id,
    buffer: frame(), receiptAt: app.now });
  assert.equal(result.status, 'manual');
  assert.equal(result.errorCode, 'ai_unavailable');
  assert.equal(app.engine.snapshot(app.event.slug, 'operator').state.judgeNotice.code, 'ai_unavailable');
  assert.equal(app.engine.snapshot(app.event.slug).state.judgeNotice, undefined);
  app.now += 10_100;
  app.engine.tickAll();
  assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'review');
  assert.equal(app.engine.snapshot(app.event.slug, 'operator').state.reviewEndsAt, null);
  app.now += 7_000;
  app.engine.tickAll();
  assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'review');
  app.engine.command(app.event.slug, 'award', { winners: app.entries.map(entry => entry.player.id) }, { id: 'operator' });
  assert.deepEqual(app.engine.snapshot(app.event.slug).state.winners, app.entries.map(entry => entry.player.id));
  app.engine.command(app.event.slug, 'nextHeat', {}, { id: 'operator' });
  assert.equal(app.engine.snapshot(app.event.slug, 'operator').state.judgeNotice, null);
  app.store.close();
});

test('an unconfigured AI judge does not silently end an empty heat as no match', () => {
  const prompt = { id: 'O01', text: 'SHOW A CUP', category: 'Object', judgeMode: 'ai-assisted', detector: 'object:cup', enabled: true, seconds: 10 };
  const app = arena(prompt);
  new JudgeService({ engine: app.engine, vision: { enabled: () => false } });
  app.now += 10_100;
  app.engine.tickAll();
  const operator = app.engine.snapshot(app.event.slug, 'operator').state;
  assert.equal(operator.phase, 'review');
  assert.equal(operator.reviewEndsAt, null);
  assert.equal(operator.judgeNotice.code, 'ai_unconfigured');
  app.now += 7_000;
  app.engine.tickAll();
  assert.equal(app.engine.snapshot(app.event.slug).state.phase, 'review');
  app.engine.command(app.event.slug, 'noMatch', {}, { id: 'operator' });
  assert.deepEqual(app.engine.snapshot(app.event.slug).state.winners, []);
  app.store.close();
});

test('bad JPEGs are refused before they reach a model', async () => {
  const app = arena();
  const judge = new JudgeService({ engine: app.engine, vision: { enabled: () => false } });
  await assert.rejects(judge.submit({ slug: app.event.slug, playerId: app.entries[0].player.id,
    buffer: Buffer.from('not a jpeg'), receiptAt: app.now }), error => error.code === 'invalid_evidence');
  app.store.close();
});

test('vision request keeps the key server side, uses a schema, and asks for no stored response', async () => {
  let request;
  const vision = new OpenAIVision({ apiKey: 'test-key', fetchImpl: async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: '{"matched":true,"confidence":0.91,"explanation":"A cup is visible"}' }] }] }) };
  } });
  const result = await vision.judge(frame(), { text: 'SHOW A CUP', detector: 'object:cup' });
  assert.equal(result.matched, true);
  assert.equal(request.body.store, false);
  assert.equal(request.body.text.format.type, 'json_schema');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.match(request.body.input[0].content[1].image_url, /^data:image\/jpeg;base64,/);
});
