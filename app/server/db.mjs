import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { defaultEvent, normalizeEvent, slugify, ValidationError } from './config.mjs';

const schema = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  revision INTEGER NOT NULL, config_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runtimes (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  state_json TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, alias TEXT NOT NULL, heat INTEGER NOT NULL,
  slot INTEGER, status TEXT NOT NULL, media_connected INTEGER NOT NULL DEFAULT 0,
  transport TEXT, joined_at TEXT NOT NULL, ready_at TEXT, last_seen_at TEXT NOT NULL, left_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_players_event_heat ON players(event_id, heat);
CREATE TABLE IF NOT EXISTS heats (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  heat INTEGER NOT NULL, prompt_json TEXT NOT NULL, rules_json TEXT NOT NULL,
  phase TEXT NOT NULL, started_at TEXT NOT NULL, go_at TEXT, ended_at TEXT,
  winners_json TEXT NOT NULL DEFAULT '[]', candidate_json TEXT,
  UNIQUE(event_id, heat)
);
CREATE TABLE IF NOT EXISTS votes (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  window_id TEXT NOT NULL, window_type TEXT NOT NULL, voter_hash TEXT NOT NULL,
  channel TEXT NOT NULL, choice TEXT NOT NULL, received_at TEXT NOT NULL,
  UNIQUE(event_id, window_id, voter_hash)
);
CREATE INDEX IF NOT EXISTS idx_votes_window ON votes(event_id, window_id);
CREATE TABLE IF NOT EXISTS webhook_receipts (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  type TEXT NOT NULL, at TEXT NOT NULL, properties_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_event_at ON activity(event_id, at);
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, intent TEXT NOT NULL, participant_id TEXT NOT NULL,
  heat_id TEXT, field_values_json TEXT NOT NULL, field_snapshot_json TEXT NOT NULL,
  name TEXT, email TEXT, phone TEXT, company TEXT, marketing_opt_in INTEGER NOT NULL,
  consent_version TEXT NOT NULL, delivery_status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_leads_event_at ON leads(event_id, created_at);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
  password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL,
  auth_provider TEXT NOT NULL DEFAULT 'password', google_sub TEXT, email TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS google_oauth_flows (
  state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL, next_path TEXT NOT NULL,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_google_oauth_flows_expiry ON google_oauth_flows(expires_at);
CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY, event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT, action TEXT NOT NULL, at TEXT NOT NULL, details_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_jobs (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
`;

const parse = (value, fallback = null) => {
  try { return JSON.parse(value); } catch { return fallback; }
};
const json = value => JSON.stringify(value);
const nowIso = () => new Date().toISOString();
const normalizedSender = (value, channel) => {
  const sender = String(value ?? '').trim().toLowerCase();
  return channel === 'sms' ? sender.replace(/^\+/, '') : sender;
};
const effectiveEventCode = event => String(event.vote?.eventCode || event.slug.replace(/-/g, '').slice(0, 20)).trim().toUpperCase();

export function resolveDatabasePath(root, env = process.env) {
  const configured = env.LIVE_SCAVENGER_HUNT_DB || env.SIGNAL_STADIUM_DB;
  if (configured) return resolve(root, configured);
  const current = resolve(root, 'app/data/live-scavenger-hunt.sqlite');
  const legacy = resolve(root, 'app/data/signal-stadium.sqlite');
  return existsSync(current) ? current : existsSync(legacy) ? legacy : current;
}

export class Store {
  constructor(filename = ':memory:') {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.sql = new DatabaseSync(filename);
    if (filename !== ':memory:') this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.sql.exec(schema);
    const userColumns = new Set(this.sql.prepare('PRAGMA table_info(users)').all().map(column => column.name));
    if (!userColumns.has('auth_provider')) this.sql.exec("ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'password'");
    if (!userColumns.has('google_sub')) this.sql.exec('ALTER TABLE users ADD COLUMN google_sub TEXT');
    if (!userColumns.has('email')) this.sql.exec('ALTER TABLE users ADD COLUMN email TEXT');
    this.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL');
  }

  transaction(callback) {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const value = callback();
      this.sql.exec('COMMIT');
      return value;
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }

  listEvents() {
    return this.sql.prepare('SELECT config_json FROM events ORDER BY created_at, name').all().map(row => parse(row.config_json));
  }

  getEvent(slug) {
    const row = this.sql.prepare('SELECT config_json FROM events WHERE slug = ? OR id = ?').get(slug, slug);
    return row ? parse(row.config_json) : null;
  }

  validateMessagingRoutes(event) {
    if (!event.vote?.enabled) return;
    const others = this.listEvents().filter(other => other?.id !== event.id && other?.vote?.enabled);
    const code = effectiveEventCode(event);
    for (const [channel, senderField] of [['sms', 'smsSender'], ['whatsapp', 'whatsappSender']]) {
      if (!event.vote.channels?.[channel]) continue;
      const sender = normalizedSender(event.vote[senderField], channel);
      if (!sender) continue;
      if (others.some(other => other.vote.channels?.[channel] &&
          normalizedSender(other.vote[senderField], channel) === sender && effectiveEventCode(other) === code)) {
        throw new ValidationError(`The ${channel.toUpperCase()} event code ${code} is already used for this sender. Choose another event code.`, 'duplicate_event_code');
      }
    }
  }

  createEvent(name, slug = '') {
    const candidate = slugify(slug || name) || 'event';
    return this.transaction(() => {
      let unique = candidate, suffix = 2;
      while (this.getEvent(unique)) unique = `${candidate.slice(0, 55)}-${suffix++}`;
      const event = normalizeEvent(defaultEvent(name || 'NEW EXPO EVENT', unique));
      this.validateMessagingRoutes(event);
      this.sql.prepare('INSERT INTO events(id,slug,name,revision,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(event.id, event.slug, event.name, event.revision, json(event), event.createdAt, event.updatedAt);
      return event;
    });
  }

  seedDefault() {
    const legacy = this.getEvent('signal-stadium');
    const originalName = legacy?.name?.trim().toUpperCase();
    if (legacy?.slug === 'signal-stadium' &&
      ['SIGNAL STADIUM', 'LIVE SCAVENGER HUNT'].includes(originalName) &&
      !this.getEvent('live-scavenger-hunt')) {
      this.transaction(() => {
        const updatedAt = nowIso();
        const renamed = { ...legacy, slug: 'live-scavenger-hunt', name: 'Live Scavenger Hunt',
          revision: legacy.revision + 1, updatedAt };
        this.sql.prepare('UPDATE events SET slug=?,name=?,revision=?,config_json=?,updated_at=? WHERE id=?')
          .run(renamed.slug, renamed.name, renamed.revision, json(renamed), updatedAt, legacy.id);
        this.audit(legacy.id, null, 'event:renamed', { from: 'Signal Stadium', to: renamed.name });
      });
    }
    return this.getEvent('live-scavenger-hunt') || this.listEvents()[0] ||
      this.createEvent('Live Scavenger Hunt', 'live-scavenger-hunt');
  }

  saveEvent(slug, draft, expectedRevision) {
    return this.transaction(() => {
      const current = this.getEvent(slug);
      if (!current) throw new ValidationError('Event not found.', 'not_found');
      if (!Number.isInteger(Number(expectedRevision)) || Number(expectedRevision) !== current.revision) {
        const error = new ValidationError('This event changed in another tab. Reload before saving.', 'revision_conflict');
        error.currentRevision = current.revision;
        throw error;
      }
      const next = normalizeEvent(draft, current);
      this.validateMessagingRoutes(next);
      next.revision = current.revision + 1;
      next.updatedAt = nowIso();
      this.sql.prepare('UPDATE events SET name=?,revision=?,config_json=?,updated_at=? WHERE id=?')
        .run(next.name, next.revision, json(next), next.updatedAt, current.id);
      const runtime = this.getRuntime(current.id);
      if (runtime?.phase === 'lobby' && next.maxPlayers < current.maxPlayers) {
        const overflow = this.listPlayers(current.id, runtime.heat)
          .filter(player => player.slot != null && player.slot > next.maxPlayers && player.status !== 'left');
        for (const player of overflow) {
          this.updatePlayer(player.id, {
            heat: runtime.heat + 1, slot: null, status: 'queued', readyAt: null,
            mediaConnected: false, transport: null,
          });
          this.recordActivity(current.id, 'player_queued', {
            playerId: player.id, heat: runtime.heat + 1, reason: 'capacity_changed',
          }, next.updatedAt);
        }
        if (overflow.length) {
          runtime.version += 1;
          runtime.updatedAt = next.updatedAt;
          this.saveRuntime(current.id, runtime);
        }
      }
      return next;
    });
  }

  getRuntime(eventId) {
    const row = this.sql.prepare('SELECT state_json FROM runtimes WHERE event_id=?').get(eventId);
    return row ? parse(row.state_json) : null;
  }

  saveRuntime(eventId, state) {
    this.sql.prepare(`INSERT INTO runtimes(event_id,state_json,version,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(event_id) DO UPDATE SET state_json=excluded.state_json,version=excluded.version,updated_at=excluded.updated_at`)
      .run(eventId, json(state), Number(state.version) || 1, nowIso());
    return state;
  }

  insertPlayer(player, tokenHash) {
    this.sql.prepare(`INSERT INTO players(id,event_id,token_hash,alias,heat,slot,status,media_connected,transport,joined_at,ready_at,last_seen_at,left_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(player.id, player.eventId, tokenHash, player.alias, player.heat, player.slot ?? null, player.status,
        player.mediaConnected ? 1 : 0, player.transport || null, player.joinedAt, player.readyAt || null,
        player.lastSeenAt || player.joinedAt, player.leftAt || null);
    return player;
  }

  getPlayer(id) {
    const row = this.sql.prepare('SELECT * FROM players WHERE id=?').get(id);
    return row ? this.playerFromRow(row) : null;
  }

  findPlayerByTokenHash(hash) {
    const row = this.sql.prepare('SELECT * FROM players WHERE token_hash=?').get(hash);
    return row ? this.playerFromRow(row) : null;
  }

  playerFromRow(row) {
    return {
      id: row.id, eventId: row.event_id, alias: row.alias, heat: row.heat,
      slot: row.slot, status: row.status, mediaConnected: Boolean(row.media_connected),
      transport: row.transport, joinedAt: row.joined_at, readyAt: row.ready_at,
      lastSeenAt: row.last_seen_at, leftAt: row.left_at,
    };
  }

  updatePlayer(id, patch) {
    const fields = {
      alias: 'alias', heat: 'heat', slot: 'slot', status: 'status', mediaConnected: 'media_connected',
      transport: 'transport', readyAt: 'ready_at', lastSeenAt: 'last_seen_at', leftAt: 'left_at',
    };
    const pairs = Object.entries(patch).filter(([key]) => fields[key]);
    if (!pairs.length) return this.getPlayer(id);
    const columns = pairs.map(([key]) => `${fields[key]}=?`).join(',');
    const values = pairs.map(([key, value]) => key === 'mediaConnected' ? value ? 1 : 0 : value);
    this.sql.prepare(`UPDATE players SET ${columns} WHERE id=?`).run(...values, id);
    return this.getPlayer(id);
  }

  listPlayers(eventId, heat = null) {
    const rows = heat == null
      ? this.sql.prepare('SELECT * FROM players WHERE event_id=? ORDER BY joined_at').all(eventId)
      : this.sql.prepare('SELECT * FROM players WHERE event_id=? AND heat=? ORDER BY slot,joined_at').all(eventId, heat);
    return rows.map(row => this.playerFromRow(row));
  }

  upsertHeat(heat) {
    this.sql.prepare(`INSERT INTO heats(id,event_id,heat,prompt_json,rules_json,phase,started_at,go_at,ended_at,winners_json,candidate_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,go_at=excluded.go_at,
      ended_at=excluded.ended_at,winners_json=excluded.winners_json,candidate_json=excluded.candidate_json`)
      .run(heat.id, heat.eventId, heat.heat, json(heat.prompt), json(heat.rules), heat.phase,
        heat.startedAt, heat.goAt || null, heat.endedAt || null, json(heat.winners || []), heat.candidate ? json(heat.candidate) : null);
  }

  listHeats(eventId = null) {
    const rows = eventId
      ? this.sql.prepare('SELECT * FROM heats WHERE event_id=? ORDER BY started_at').all(eventId)
      : this.sql.prepare('SELECT * FROM heats ORDER BY started_at').all();
    return rows.map(row => ({
      id: row.id, eventId: row.event_id, heat: row.heat, prompt: parse(row.prompt_json),
      rules: parse(row.rules_json), phase: row.phase, startedAt: row.started_at,
      goAt: row.go_at, endedAt: row.ended_at, winners: parse(row.winners_json, []),
      candidate: parse(row.candidate_json),
    }));
  }

  castVote(vote) {
    try {
      this.sql.prepare(`INSERT INTO votes(id,event_id,window_id,window_type,voter_hash,channel,choice,received_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(vote.id || randomUUID(), vote.eventId, vote.windowId,
        vote.windowType, vote.voterHash, vote.channel, vote.choice, vote.receivedAt || nowIso());
      return { accepted: true };
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed')) return { accepted: false, duplicate: true };
      throw error;
    }
  }

  listVotes(eventId, windowId = null) {
    const rows = windowId
      ? this.sql.prepare('SELECT * FROM votes WHERE event_id=? AND window_id=? ORDER BY received_at').all(eventId, windowId)
      : this.sql.prepare('SELECT * FROM votes WHERE event_id=? ORDER BY received_at').all(eventId);
    return rows.map(row => ({ id: row.id, eventId: row.event_id, windowId: row.window_id,
      windowType: row.window_type, voterHash: row.voter_hash, channel: row.channel,
      choice: row.choice, receivedAt: row.received_at }));
  }

  rememberWebhook(id, kind) {
    try { this.sql.prepare('INSERT INTO webhook_receipts(id,kind,received_at) VALUES(?,?,?)').run(id, kind, nowIso()); return true; }
    catch (error) { if (String(error.message).includes('UNIQUE constraint failed')) return false; throw error; }
  }

  hasWebhook(id) { return Boolean(this.sql.prepare('SELECT 1 FROM webhook_receipts WHERE id=?').get(id)); }

  getSetting(key) {
    return this.sql.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value ?? null;
  }

  getOrCreateSetting(key, createValue) {
    const existing = this.getSetting(key);
    if (existing != null) return existing;
    const value = String(createValue());
    this.sql.prepare('INSERT OR IGNORE INTO app_settings(key,value) VALUES(?,?)').run(key, value);
    return this.getSetting(key);
  }

  recordActivity(eventId, type, properties = {}, at = nowIso()) {
    const item = { id: randomUUID(), eventId, type, at, properties: structuredClone(properties) };
    this.sql.prepare('INSERT INTO activity(id,event_id,type,at,properties_json) VALUES(?,?,?,?,?)')
      .run(item.id, eventId, type, at, json(item.properties));
    return item;
  }

  listActivity(eventId = null) {
    const rows = eventId
      ? this.sql.prepare('SELECT * FROM activity WHERE event_id=? ORDER BY at').all(eventId)
      : this.sql.prepare('SELECT * FROM activity ORDER BY at').all();
    return rows.map(row => ({ id: row.id, eventId: row.event_id, type: row.type, at: row.at, properties: parse(row.properties_json, {}) }));
  }

  insertLead(lead) {
    this.sql.prepare(`INSERT INTO leads(id,event_id,created_at,intent,participant_id,heat_id,field_values_json,field_snapshot_json,
      name,email,phone,company,marketing_opt_in,consent_version,delivery_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(lead.id, lead.eventId, lead.createdAt, lead.intent, lead.participantId, lead.heatId || null,
        json(lead.fieldValues), json(lead.fieldSnapshot), lead.name || '', lead.email || '', lead.phone || '',
        lead.company || '', lead.marketingOptIn ? 1 : 0, lead.consentVersion, lead.deliveryStatus || 'pending');
    return lead;
  }

  updateLeadDelivery(id, status) {
    this.sql.prepare('UPDATE leads SET delivery_status=? WHERE id=?').run(status, id);
  }

  leadFromRow(row) {
    return {
      id: row.id, eventId: row.event_id, createdAt: row.created_at, intent: row.intent,
      participantId: row.participant_id, heatId: row.heat_id,
      fieldValues: parse(row.field_values_json, {}), fieldSnapshot: parse(row.field_snapshot_json, []),
      name: row.name || '', email: row.email || '', phone: row.phone || '', company: row.company || '',
      marketingOptIn: Boolean(row.marketing_opt_in), consentVersion: row.consent_version,
      deliveryStatus: row.delivery_status,
    };
  }

  listLeads(eventId = null) {
    const rows = eventId
      ? this.sql.prepare('SELECT * FROM leads WHERE event_id=? ORDER BY created_at DESC').all(eventId)
      : this.sql.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
    return rows.map(row => this.leadFromRow(row));
  }

  getLead(id) {
    const row = this.sql.prepare('SELECT * FROM leads WHERE id=?').get(id);
    return row ? this.leadFromRow(row) : null;
  }

  findRecentLead(eventId, intent, participantId, contact, seconds = 60) {
    const cutoff = new Date(Date.now() - seconds * 1000).toISOString();
    const rows = this.sql.prepare(`SELECT * FROM leads WHERE event_id=? AND intent=? AND participant_id=?
      AND created_at>=? ORDER BY created_at DESC`).all(eventId, intent, participantId, cutoff);
    return rows.map(row => this.leadFromRow(row)).find(row =>
      (contact.email && row.email === contact.email) || (contact.phone && row.phone.replace(/\D/g, '') === contact.phone.replace(/\D/g, ''))) || null;
  }

  deleteLead(id) {
    return this.sql.prepare('DELETE FROM leads WHERE id=?').run(id).changes > 0;
  }

  audit(eventId, userId, action, details = {}) {
    const entry = { id: randomUUID(), eventId, userId, action, at: nowIso(), details };
    this.sql.prepare('INSERT INTO audit(id,event_id,user_id,action,at,details_json) VALUES(?,?,?,?,?,?)')
      .run(entry.id, eventId || null, userId || null, action, entry.at, json(details));
    return entry;
  }

  listAudit(eventId = null) {
    const rows = eventId
      ? this.sql.prepare('SELECT * FROM audit WHERE event_id=? ORDER BY at DESC').all(eventId)
      : this.sql.prepare('SELECT * FROM audit ORDER BY at DESC').all();
    return rows.map(row => ({ id: row.id, eventId: row.event_id, userId: row.user_id,
      action: row.action, at: row.at, details: parse(row.details_json, {}) }));
  }

  pruneLeads(reference = new Date()) {
    let count = 0;
    for (const event of this.listEvents()) {
      const cutoff = new Date(reference.getTime() - event.retentionDays * 86400_000).toISOString();
      count += this.sql.prepare('DELETE FROM leads WHERE event_id=? AND created_at<?').run(event.id, cutoff).changes;
    }
    return count;
  }

  close() { this.sql.close(); }
}

export function openDatabase(filename = ':memory:') { return new Store(filename); }
