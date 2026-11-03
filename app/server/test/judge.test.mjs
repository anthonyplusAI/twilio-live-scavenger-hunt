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
