import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaService } from '../media.mjs';

const credentials = {
  TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
  TWILIO_API_KEY_SID: `SK${'2'.repeat(32)}`,
  TWILIO_API_KEY_SECRET: 'unit-test-secret',
};
const event = { id: 'event-uuid-123', maxPlayers: 6 };
const player = { id: 'player-uuid-456', heat: 3, slot: 2 };
const jwtPayload = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

function fakeClient() {
  const stored = new Map();
  const creates = [];
  const participants = new Map();
  const disconnects = [];
  let fetches = 0;
  function rooms(name) {
    const participantResource = sid => ({
      async update({ status }) {
        disconnects.push({ room: name, sid, status });
        const participant = participants.get(sid);
        if (participant) participant.status = status;
        return participant;
      },
    });
    participantResource.list = async ({ identity }) => [...participants.values()]
      .filter(participant => participant.identity === identity && participant.status === 'connected');
    return {
      async fetch() {
        fetches += 1;
        const room = stored.get(name) || [...stored.values()].find(item => item.sid === name);
        if (!room) throw Object.assign(new Error('Not found'), { status: 404 });
        return room;
      },
      participants: participantResource,
    };
  }
  rooms.create = async options => {
    creates.push(options);
    const room = { sid: `RM${String(stored.size + 1).padStart(32, '0')}`, uniqueName: options.uniqueName, status: 'in-progress' };
    stored.set(options.uniqueName, room);
    return room;
  };
  return { video: { v1: { rooms } }, creates, disconnects,
    connect(identity) { participants.set(`PA${participants.size + 1}`, { sid: `PA${participants.size + 1}`, identity, status: 'connected' }); },
    get fetches() { return fetches; } };
}

test('defaults to local rehearsal; off without credentials is unconfigured', async () => {
  const rehearsal = new MediaService({ env: {} });
  assert.equal(rehearsal.mode(), 'rehearsal');
  assert.deepEqual(await rehearsal.playerToken(event, player), { mode: 'rehearsal' });
  assert.equal(rehearsal.preflight().status, 'rehearsal');
  const unconfigured = new MediaService({ env: { REHEARSAL_MODE: 'off' } });
  assert.equal(unconfigured.mode(), 'unconfigured');
  assert.deepEqual(await unconfigured.wallToken(event, 3), { mode: 'unconfigured' });
  assert.equal(unconfigured.preflight().status, 'unconfigured');
  const forced = new MediaService({ env: { ...credentials, REHEARSAL_MODE: 'on' } });
  assert.equal(forced.mode(), 'rehearsal');
});

test('creates one unrecorded Group Room and issues room scoped player and wall tokens', async () => {
  const client = fakeClient();
  const media = new MediaService({ publicBaseUrl: 'https://booth.example', env: credentials, twilioClient: client });
  assert.equal(media.preflight().status, 'warning'); // Auth token is needed to validate callbacks.
  const ready = new MediaService({ publicBaseUrl: 'https://booth.example', env: { ...credentials, TWILIO_AUTH_TOKEN: 'webhook-secret' }, twilioClient: client });
  assert.equal(ready.preflight().status, 'ok');
  const roomName = media.roomName(event, 3);
  assert.match(roomName, /^live-scavenger-hunt-[a-f0-9]{20}-h3$/);
  assert.notEqual(roomName, media.roomName(event, 4));
  assert.notEqual(roomName, media.roomName({ id: 'other-event', maxPlayers: 6 }, 3));
  const [first, second, wall] = await Promise.all([
    media.playerToken(event, player),
    media.playerToken(event, { ...player, id: 'other-player' }),
    media.wallToken(event, 3),
  ]);
  assert.equal(client.creates.length, 1);
  assert.deepEqual(client.creates[0], {
    uniqueName: roomName,
    type: 'group',
    maxParticipants: 7,
    recordParticipantsOnConnect: false,
    statusCallback: 'https://booth.example/webhooks/twilio/video',
    statusCallbackMethod: 'POST',
    emptyRoomTimeout: 1,
    unusedRoomTimeout: 5,
  });
  assert.equal(first.mode, 'twilio');
  assert.equal(first.identity, `p:${player.id}`);
  assert.equal(first.roomName, roomName);
  assert.equal(jwtPayload(first.token).grants.video.room, roomName);
  assert.equal(jwtPayload(first.token).grants.identity, `p:${player.id}`);
  assert.equal(jwtPayload(second.token).grants.identity, 'p:other-player');
  assert.equal(jwtPayload(wall.token).grants.video.room, roomName);
  assert.equal(jwtPayload(wall.token).grants.identity, `wall:${event.id}:3`);
});

test('queued players cannot obtain Twilio tokens and public HTTPS is required', async () => {
  const client = fakeClient();
  const media = new MediaService({ publicBaseUrl: 'http://localhost:3000', env: credentials, twilioClient: client });
  assert.equal(media.preflight().status, 'warning');
  await assert.rejects(media.playerToken(event, { ...player, slot: null }), /Wait for a slot/);
  await assert.rejects(media.playerToken(event, player), /public HTTPS/);
  assert.equal(client.creates.length, 0);
});

test('disconnecting a removed player ends their Twilio room participation and clears the cached frame', async () => {
  const client = fakeClient();
  const media = new MediaService({ publicBaseUrl: 'https://booth.example', env: credentials, twilioClient: client });
  await media.playerToken(event, player);
  client.connect(`p:${player.id}`);
  media.storeFrame(event.id, player.id, Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]));
  const result = await media.disconnectPlayer(event, player);
  assert.equal(result.disconnected, 1);
  assert.deepEqual(client.disconnects, [{ room: `RM${String(1).padStart(32, '0')}`, sid: 'PA1', status: 'disconnected' }]);
  assert.equal(media.getFrame(event.id, player.id), null);
});

test('stores only bounded JPEG frames in memory and expires them', () => {
  let currentTime = 1_700_000_000_000;
  const media = new MediaService({ env: {}, now: () => currentTime });
  const image = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
  const receipt = media.storeFrame('event-a', 'player-a', image);
  assert.equal(receipt.bytes, 6);
  assert.equal(receipt.receivedAt, new Date(currentTime).toISOString());
  image[2] = 0x99;
  assert.equal(media.getFrame('event-a', 'player-a')[2], 0x01);
  assert.equal(media.getFrame('event-b', 'player-a'), null);
  assert.throws(() => media.storeFrame('event-a', 'player-a', Buffer.from('not a jpeg')), /JPEG/);
  assert.throws(() => media.storeFrame('event-a', 'player-a', Buffer.alloc(150_001, 0xff)), /150 KB/);
  currentTime += 15_001;
  assert.equal(media.pruneFrames(), 1);
  assert.equal(media.getFrame('event-a', 'player-a'), null);
});
