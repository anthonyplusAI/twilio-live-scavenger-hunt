import { createHash } from 'node:crypto';
import twilio from 'twilio';
import { ValidationError } from './config.mjs';

const MAX_FRAME_BYTES = 150_000;
const FRAME_TTL_MS = 15_000;
const ROOM_CACHE_MS = 60_000;
const ROOM_PARTICIPANT_CAPACITY = 7; // The app permits up to six players plus one wall subscriber.

export class MediaError extends Error {
  constructor(message, code = 'media_unavailable', status = 503) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Twilio Video credentials never leave this service. The only persisted video
 * state is the event/heat roster held by the engine; JPEG snapshots live here
 * briefly in memory for local rehearsal and vision judging.
 */
export class MediaService {
  constructor({ publicBaseUrl, env = process.env, twilioClient = null, now = () => Date.now() } = {}) {
    this.env = env;
    this.now = now;
    this.publicBaseUrl = String(publicBaseUrl || env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    this.twilioClient = twilioClient;
    this.roomCache = new Map();
    this.frames = new Map();
  }

  credentials() {
    return {
      accountSid: this.env.TWILIO_ACCOUNT_SID || '',
      keySid: this.env.TWILIO_API_KEY_SID || this.env.TWILIO_API_KEY || '',
      keySecret: this.env.TWILIO_API_KEY_SECRET || this.env.TWILIO_API_SECRET || '',
    };
  }

  mode() {
    const setting = String(this.env.REHEARSAL_MODE ?? '').toLowerCase();
    if (['on', 'true', '1', 'yes'].includes(setting)) return 'rehearsal';
    const { accountSid, keySid, keySecret } = this.credentials();
    if (accountSid && keySid && keySecret && this.env.TWILIO_AUTH_TOKEN) return 'twilio';
    if (['off', 'false', '0', 'no'].includes(setting)) return 'unconfigured';
    return 'rehearsal';
  }

  roomName(event, heat) {
    const eventId = String(event?.id || '');
    const number = Number(heat);
    if (!eventId || !Number.isInteger(number) || number < 1) throw new ValidationError('A valid event and heat are required for Video.', 'invalid_media_room');
    const digest = createHash('sha256').update(eventId).digest('hex').slice(0, 20);
    return `live-scavenger-hunt-${digest}-h${number}`;
  }

  _client() {
    if (this.twilioClient) return this.twilioClient;
    const { accountSid, keySid, keySecret } = this.credentials();
    this.twilioClient = twilio(keySid, keySecret, { accountSid });
    return this.twilioClient;
  }

  _callbackUrl() {
    let parsed;
    try { parsed = new URL(this.publicBaseUrl); } catch { throw new MediaError('Set PUBLIC_BASE_URL to the booth’s public HTTPS URL before using Twilio Video.', 'video_public_url'); }
    if (parsed.protocol !== 'https:') throw new MediaError('Twilio Video needs a public HTTPS callback URL. Set PUBLIC_BASE_URL before going live.', 'video_public_url');
    return `${this.publicBaseUrl}/webhooks/twilio/video`;
  }

  async _ensureRoom(event, heat) {
    const name = this.roomName(event, heat);
    const cached = this.roomCache.get(name);
    if (cached && cached.expiresAt > this.now()) return cached.promise;
    const promise = this._fetchOrCreateRoom(event, name);
    this.roomCache.set(name, { promise, expiresAt: this.now() + ROOM_CACHE_MS });
    try { return await promise; }
    catch (error) { if (this.roomCache.get(name)?.promise === promise) this.roomCache.delete(name); throw error; }
  }

  async _fetchOrCreateRoom(event, name) {
    const rooms = this._client().video.v1.rooms;
    try {
      const room = await rooms(name).fetch();
      if (room?.status === 'in-progress') return room;
    } catch (error) {
      if (error.status !== 404 && error.code !== 20404) throw error;
    }
    const options = {
      uniqueName: name,
      type: 'group',
      // A live event can increase maxPlayers after this Room is created.
      // Reserve the app's full six-player limit; joining still follows event.maxPlayers.
      maxParticipants: ROOM_PARTICIPANT_CAPACITY,
      recordParticipantsOnConnect: false,
      statusCallback: this._callbackUrl(),
      statusCallbackMethod: 'POST',
      emptyRoomTimeout: 1,
      unusedRoomTimeout: 5,
    };
    try { return await rooms.create(options); }
    catch (error) {
      // Another process may have created the same deterministic room first.
      if (error.status === 409) return rooms(name).fetch();
      throw error;
    }
  }

  _token(identity, roomName) {
    const { accountSid, keySid, keySecret } = this.credentials();
    const AccessToken = twilio.jwt.AccessToken;
    const token = new AccessToken(accountSid, keySid, keySecret, { identity, ttl: 3600 });
    token.addGrant(new AccessToken.VideoGrant({ room: roomName }));
    return token.toJwt();
  }

  async playerToken(event, player) {
    const mode = this.mode();
    if (mode !== 'twilio') return { mode };
    if (!player?.id || !Number.isInteger(Number(player.heat)) || player.slot == null) {
      throw new ValidationError('Wait for a slot in the next heat before connecting your camera.', 'player_queued');
    }
    const roomName = this.roomName(event, player.heat);
    await this._ensureRoom(event, player.heat);
    const identity = `p:${player.id}`;
    return { mode, token: this._token(identity, roomName), roomName, identity };
  }

  async wallToken(event, heat) {
    const mode = this.mode();
    if (mode !== 'twilio') return { mode };
    const roomName = this.roomName(event, heat);
    await this._ensureRoom(event, heat);
    const identity = `wall:${event.id}:${heat}`;
    return { mode, token: this._token(identity, roomName), roomName, identity };
  }

  async disconnectPlayer(event, player) {
    if (!event?.id || !player?.id) throw new ValidationError('Event and player are required to disconnect Video.', 'invalid_media_player');
    this.frames.delete(this._frameKey(event.id, player.id));
    const mode = this.mode();
    if (mode !== 'twilio') return { mode, disconnected: 0 };
    const roomName = this.roomName(event, player.heat);
    const rooms = this._client().video.v1.rooms;
    let room;
    try { room = await rooms(roomName).fetch(); }
    catch (error) {
      if (error.status === 404 || error.code === 20404) return { mode, disconnected: 0 };
      throw error;
    }
    if (room.status !== 'in-progress') return { mode, disconnected: 0 };
    const participants = rooms(room.sid || roomName).participants;
    const identity = `p:${player.id}`;
    const connected = await participants.list({ identity, limit: 20 });
    let disconnected = 0;
    for (const item of connected) {
      if (item.identity !== identity || !['connected', 'reconnecting'].includes(item.status)) continue;
      try { await participants(item.sid).update({ status: 'disconnected' }); disconnected += 1; }
      catch (error) {
        if (error.status !== 404 && error.code !== 20404) throw error;
      }
    }
    return { mode, disconnected };
  }

  preflight() {
    const mode = this.mode();
    const { accountSid, keySid, keySecret } = this.credentials();
    const present = [accountSid, keySid, keySecret].filter(Boolean).length;
    if (mode === 'twilio') {
      try { this._callbackUrl(); }
      catch { return { name: 'Twilio Video', status: 'warning', detail: 'Video credentials are set, but PUBLIC_BASE_URL needs a public HTTPS URL for callbacks.' }; }
      return { name: 'Twilio Video', status: 'ok', detail: 'Credential fields and HTTPS callback URL are present. Verify with a live two-phone heat.' };
    }
    if (present === 3 && !this.env.TWILIO_AUTH_TOKEN) {
      return { name: 'Twilio Video', status: mode === 'unconfigured' ? 'unconfigured' : 'warning',
        detail: 'Add TWILIO_AUTH_TOKEN so signed Video callbacks can mark player cameras ready.' };
    }
    if (mode === 'rehearsal') {
      return { name: 'Twilio Video', status: present && present < 3 ? 'warning' : 'rehearsal', detail: present && present < 3 ? 'Video credentials are incomplete; local camera rehearsal is active.' : 'Local camera snapshots are active; Twilio Video is not connected.' };
    }
    return { name: 'Twilio Video', status: 'unconfigured', detail: 'Set Twilio Video credentials or enable local rehearsal before accepting players.' };
  }

  _frameKey(eventId, playerId) {
    if (!eventId || !playerId) throw new ValidationError('Event and player are required for a camera frame.', 'invalid_frame');
    return JSON.stringify([String(eventId), String(playerId)]);
  }

  storeFrame(eventId, playerId, buffer) {
    const key = this._frameKey(eventId, playerId);
    if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.length > MAX_FRAME_BYTES || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer.at(-2) !== 0xff || buffer.at(-1) !== 0xd9) {
      throw new ValidationError('Send one JPEG frame no larger than 150 KB.', 'invalid_frame');
    }
    this.pruneFrames();
    const receivedAt = new Date(this.now()).toISOString();
    this.frames.set(key, { buffer: Buffer.from(buffer), receivedAtMs: this.now() });
    return { bytes: buffer.length, receivedAt };
  }

  getFrame(eventId, playerId) {
    const key = this._frameKey(eventId, playerId);
    const frame = this.frames.get(key);
    if (!frame) return null;
    if (this.now() - frame.receivedAtMs > FRAME_TTL_MS) { this.frames.delete(key); return null; }
    return Buffer.from(frame.buffer);
  }

  pruneFrames(maxAgeMs = FRAME_TTL_MS) {
    const maxAge = Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? maxAgeMs : FRAME_TTL_MS;
    let removed = 0;
    for (const [key, frame] of this.frames) {
      if (this.now() - frame.receivedAtMs > maxAge) { this.frames.delete(key); removed += 1; }
    }
    return removed;
  }
}
