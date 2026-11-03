import { EventEmitter } from 'node:events';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { promptPriority, ValidationError } from './config.mjs';
import { validateLead } from './leads.mjs';

const toIso = milliseconds => new Date(milliseconds).toISOString();
const fromIso = value => value == null ? null : Date.parse(value);
const clone = value => structuredClone(value);
const tokenHash = token => createHash('sha256').update(String(token)).digest('hex');
const HUNT_PHASES = new Set(['hunt', 'review', 'result']);
const INACTIVE_WAITING_MS = 25_000;
const INACTIVE_HEAT_MS = 60_000;

function fail(message, code = 'invalid_state') { throw new ValidationError(message, code); }
function initialRuntime(eventId, now) {
  return {
    eventId, phase: 'lobby', heat: 1, version: 1, updatedAt: toIso(now),
    paused: false, pauseRemaining: null, readyDeadline: null, goAt: null,
    countdownEndsAt: null, roundEndsAt: null, reviewEndsAt: null,
    resultEndsAt: null, heatId: null, promptSnapshot: null, rulesSnapshot: null,
    lockedPlayerIds: [], queuedPromptId: null, preferredCategory: null,
    candidates: [], candidate: null, candidateDeadline: null, winners: [], resultRoster: [],
    judgeNotice: null,
    vote: null, usedPromptIds: [], promptPlayCounts: {}, automaticPromptSelections: 0,
    heatsStarted: 0, overrideCount: 0,
  };
}

function publicVote(store, eventId, vote) {
  if (!vote) return null;
  const tallies = Object.fromEntries(vote.options.map(option => [option.id, 0]));
  for (const ballot of store.listVotes(eventId, vote.id)) {
    if (Object.hasOwn(tallies, ballot.choice)) tallies[ballot.choice]++;
  }
  return {
    id: vote.id, type: vote.type, status: vote.status,
    closesAt: vote.closesAt, options: vote.options.map(option => ({ ...option })),
    tallies, result: vote.result ?? null,
  };
}

export class GameEngine extends EventEmitter {
  constructor({ store, now = () => Date.now(), mediaMode = () => 'rehearsal', telemetry = null,
    randomIndex = randomInt } = {}) {
    super();
    if (!store) throw new Error('GameEngine needs a Store.');
    this.store = store;
    this.now = now;
    this.mediaMode = mediaMode;
    this.telemetry = telemetry;
    this.randomIndex = randomIndex;
    this.aiVisionAvailable = null;
    this.interval = null;
    this.lastPresenceSweep = new Map();
  }

  startTicker(milliseconds = 100) {
    if (this.interval) return;
    this.interval = setInterval(() => this.tickAll(), milliseconds);
    this.interval.unref?.();
    this.tickAll();
  }

  close() { if (this.interval) clearInterval(this.interval); this.interval = null; }

  event(slug) {
    const event = this.store.getEvent(slug);
    if (!event) fail('Event not found.', 'not_found');
    return event;
  }

  _runtime(event) {
    const state = this.store.getRuntime(event.id);
    if (state) return state;
    const created = initialRuntime(event.id, this.now());
    this.store.saveRuntime(event.id, created);
    return created;
  }

  _mutate(slug, action) {
    const activities = [];
    const removedPlayers = [];
    let changed = false;
    let event;
    const result = this.store.transaction(() => {
      event = this.event(slug);
      const state = this._runtime(event);
      const context = {
        event, state, now: this.now(),
        touch: () => { changed = true; },
        activity: (type, properties = {}) => {
          const item = this.store.recordActivity(event.id, type, properties, toIso(this.now()));
          activities.push(item);
          return item;
        },
        removeMedia: (player, status) => removedPlayers.push({ event, player, status }),
      };
      const value = action(context);
      if (changed) {
        state.version += 1;
        state.updatedAt = toIso(this.now());
        this.store.saveRuntime(event.id, state);
      }
      return value;
    });
    if (changed) this.emit('change', event.slug);
    for (const item of removedPlayers) this.emit('player-removed', item);
    for (const item of activities) {
      try { this.telemetry?.track?.(item); } catch { /* Analytics never blocks a booth heat. */ }
    }
    return result;
  }

  publicEvent(event) {
    return {
      id: event.id, slug: event.slug, name: event.name, venue: event.venue,
      timeZone: event.timeZone, minPlayers: event.minPlayers, maxPlayers: event.maxPlayers,
      roundSeconds: event.roundSeconds, joinSeconds: event.joinSeconds,
      resultSeconds: event.resultSeconds, startMode: event.startMode,
      leadCapture: { ...clone(event.leadCapture), timing: event.leadCapture?.timing || 'after-play' },
      cta: clone(event.cta || { primary: 'github' }), vote: {
        ...clone(event.vote),
        eventCode: event.vote.eventCode || event.slug.replace(/-/g, '').slice(0, 20).toUpperCase(),
      },
      mediaMode: this.mediaMode(),
    };
  }

  _publicState(event, state) {
    const players = this.store.listPlayers(event.id);
    const liveRoster = players
      .filter(player => player.heat === state.heat && player.slot != null && !['left', 'kicked'].includes(player.status))
      .sort((a, b) => a.slot - b.slot)
      .map(player => ({
        id: player.id, alias: player.alias, slot: player.slot,
        status: player.status, mediaConnected: player.mediaConnected,
      }));
    const byId = new Map(players.map(player => [player.id, player]));
    const roster = state.phase === 'result' && state.resultRoster?.length
      ? state.resultRoster.map(spot => {
        const current = byId.get(spot.id);
        if (!current || current.status === 'kicked') return null;
        return { ...spot, status: current.status,
          mediaConnected: current.status === 'left' ? false : current.mediaConnected };
      }).filter(Boolean)
      : liveRoster;
    const readyCount = roster.filter(player => player.mediaConnected &&
      ['ready', 'locked', 'active', 'finished'].includes(player.status)).length;
    const result = {
      eventId: event.id, phase: state.phase, heat: state.heat, version: state.version,
      paused: state.paused, roster,
      queuedCount: players.filter(player => player.status === 'queued').length,
      readyCount, lockedCount: state.lockedPlayerIds.length,
      readyDeadline: state.readyDeadline, countdownEndsAt: state.countdownEndsAt,
      roundEndsAt: state.roundEndsAt, resultEndsAt: state.resultEndsAt,
      winners: [...state.winners], vote: publicVote(this.store, event.id, state.vote),
    };
    if (HUNT_PHASES.has(state.phase) && state.promptSnapshot) {
      result.prompt = {
        id: state.promptSnapshot.id, text: state.promptSnapshot.text,
        category: state.promptSnapshot.category, seconds: state.promptSnapshot.seconds,
        judgeMode: state.promptSnapshot.judgeMode,
      };
    }
    return result;
  }

  snapshot(slug, role = 'public') {
    this.tickEvent(slug);
    const event = this.event(slug);
    const state = this._runtime(event);
    const publicState = this._publicState(event, state);
    if (role === 'operator') {
      const queue = this.store.listQueuedPlayers(event.id);
      const people = this.store.listPlayers(event.id);
      const recentHeats = this.store.listHeats(event.id)
        .filter(heat => heat.phase === 'result')
        .sort((a, b) => b.heat - a.heat).slice(0, 5)
        .map(heat => ({
          id: heat.id, heat: heat.heat,
          prompt: { id: heat.prompt.id, text: heat.prompt.text, category: heat.prompt.category },
          winners: heat.winners,
          players: people.filter(player => heat.rules?.lockedPlayerIds
            ? heat.rules.lockedPlayerIds.includes(player.id)
            : player.heat === heat.heat && player.status === 'finished')
            .sort((a, b) => (a.slot || 99) - (b.slot || 99))
            .map(player => ({ id: player.id, alias: player.alias, slot: player.slot })),
        }));
      return {
        event: { ...event, mediaMode: this.mediaMode() }, state: {
          ...publicState, candidate: state.candidate, candidates: clone(state.candidates),
          queuedPromptId: state.queuedPromptId, preferredCategory: state.preferredCategory,
          heatsStarted: state.heatsStarted, overrideCount: state.overrideCount,
          reviewEndsAt: state.reviewEndsAt, judgeNotice: clone(state.judgeNotice || null),
          pauseRemaining: state.pauseRemaining, queue: queue.map(player => ({
            id: player.id, alias: player.alias, heat: player.heat,
          })), recentHeats,
        }, serverTime: this.now(),
      };
    }
    return { event: this.publicEvent(event), state: publicState, serverTime: this.now() };
  }

  _authenticatePlayer(eventId, token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) fail('Player session required.', 'unauthorized');
    const player = this.store.findPlayerByTokenHash(tokenHash(token));
    if (player?.eventId === eventId && player.status === 'kicked') fail('You were removed from this game by booth staff.', 'player_kicked');
    if (!player || player.eventId !== eventId || player.status === 'left' || this.now() - fromIso(player.joinedAt) > 24 * 60 * 60_000)
      fail('Player session expired.', 'unauthorized');
    return player;
  }

  player(slug, token) {
    const event = this.event(slug);
    return this._authenticatePlayer(event.id, token);
  }

  _withQueuePosition(player) {
    if (player.status !== 'queued') return { ...player, queuePosition: null };
    const position = this.store.listQueuedPlayers(player.eventId)
      .findIndex(waiting => waiting.id === player.id) + 1;
    return { ...player, queuePosition: position || null };
  }

  join(slug, { alias, displayConsent, lead } = {}, { requireLead = false, analyticsSessionId = null } = {}) {
    const name = String(alias ?? '').trim().replace(/\s+/g, ' ');
    if (!displayConsent) fail('Agree to appear on the booth display before joining.', 'consent_required');
    if (name.length < 2 || name.length > 20 || /[<>\x00-\x1f\x7f]/.test(name)) fail('Use a display name of 2–20 characters.');
    if (analyticsSessionId != null && !/^[a-f0-9]{20}$/.test(analyticsSessionId)) fail('Invalid activity session.', 'invalid_activity');
    const token = randomBytes(32).toString('base64url');
    let capturedLead = null;
    const value = this._mutate(slug, context => {
      const { event, state, now, touch, activity } = context;
      const inLobby = state.phase === 'lobby';
      if (inLobby) this._fillOpenLobbySlots(context);
      const current = this.store.listPlayers(event.id, state.heat).filter(player => player.slot != null && player.status !== 'left');
      const available = Array.from({ length: event.maxPlayers }, (_, index) => index + 1).find(slot => !current.some(player => player.slot === slot));
      const slot = inLobby ? available ?? null : null;
      const player = {
        id: randomUUID(), eventId: event.id, alias: name, heat: slot ? state.heat : state.heat + 1,
        slot, status: slot ? 'joined' : 'queued', mediaConnected: false, transport: null,
        analyticsSessionId,
        joinedAt: toIso(now), lastSeenAt: toIso(now),
      };
      if (event.leadCapture?.enabled && (requireLead || lead)) {
        capturedLead = validateLead(event, player, { ...lead, intent: 'capture' }, state, new Date(now));
      }
      this.store.insertPlayer(player, tokenHash(token));
      if (capturedLead) this.store.insertLead(capturedLead);
      activity('player_joined', { playerId: player.id, heat: player.heat, queued: !slot, ...(analyticsSessionId ? { sessionId: analyticsSessionId } : {}) });
      if (!slot) activity('player_queued', { playerId: player.id, heat: player.heat, ...(analyticsSessionId ? { sessionId: analyticsSessionId } : {}) });
      if (capturedLead) activity('lead_captured', { playerId: player.id, heat: player.heat, ...(analyticsSessionId ? { sessionId: analyticsSessionId } : {}) });
      touch();
      return player;
    });
    if (capturedLead) {
      try { this.telemetry?.identifyOptedInLead?.(capturedLead); }
      catch { /* Lead analytics never blocks a player join. */ }
    }
    const state = this.snapshot(slug).state;
    return { player: this._withQueuePosition(this.store.getPlayer(value.id)), token, state };
  }

  me(slug, token) {
    const player = this.player(slug, token);
    const state = this.snapshot(slug).state;
    return { player: this._withQueuePosition(this.store.getPlayer(player.id)), state };
  }

  setTransport(slug, token, transport) {
    if (!['twilio', 'rehearsal'].includes(transport)) fail('Unknown media transport.');
    const player = this._mutate(slug, ({ event, touch }) => {
      const current = this._authenticatePlayer(event.id, token);
      const mediaConnected = transport === 'rehearsal' ? true : current.transport === 'twilio' && current.mediaConnected;
      const next = this.store.updatePlayer(current.id, { transport, mediaConnected, lastSeenAt: toIso(this.now()) });
      if (next.transport !== current.transport || next.mediaConnected !== current.mediaConnected) touch();
      return next;
    });
    return player;
  }

  setMediaConnected(slug, playerId, connected) {
    return this._mutate(slug, context => {
      const { event, state, now, touch, activity } = context;
      const player = this.store.getPlayer(playerId);
      if (!player || player.eventId !== event.id || ['left', 'kicked'].includes(player.status)) return null;
      if (player.mediaConnected === Boolean(connected)) return player;
      const updated = this.store.updatePlayer(player.id, { mediaConnected: Boolean(connected), lastSeenAt: toIso(this.now()) });
      if (state.phase === 'lobby' && player.status === 'ready') {
        const ready = this._readyPlayers(event, state);
        if (ready.length < event.minPlayers) state.readyDeadline = null;
        else if (!state.readyDeadline && ['flexible', 'deadline'].includes(event.startMode))
          state.readyDeadline = toIso(now + event.joinSeconds * 1000);
        if (connected) this._maybeAutoStart(context);
      }
      activity(connected ? 'media_connected' : 'media_disconnected', { playerId });
      touch();
      return updated;
    });
  }

  _flagJudgeUnavailable(context, code) {
    const { state, touch, activity } = context;
    if (!['countdown', 'hunt', 'review'].includes(state.phase) || state.promptSnapshot?.judgeMode !== 'ai-assisted')
      return state.judgeNotice || null;
    if (state.judgeNotice?.heatId === state.heatId) return state.judgeNotice;
    const errorCode = code === 'ai_unconfigured' ? 'ai_unconfigured' : 'ai_unavailable';
    state.judgeNotice = {
      code: errorCode, heatId: state.heatId, at: toIso(context.now),
      message: errorCode === 'ai_unconfigured'
        ? 'AI judging is not configured. Choose a winner, tie, or no match manually.'
        : 'AI judging became unavailable. Choose a winner, tie, or no match manually.',
    };
    state.reviewEndsAt = null;
    if (state.pauseRemaining) delete state.pauseRemaining.reviewEndsAt;
    activity('judge_unavailable', { heatId: state.heatId, source: 'ai' });
    touch();
    return state.judgeNotice;
  }

  reportJudgeUnavailable(slug, { code = 'ai_unavailable', heatId = null } = {}) {
    return this._mutate(slug, context => {
      if (heatId && context.state.heatId !== heatId) return context.state.judgeNotice || null;
      return this._flagJudgeUnavailable(context, code);
    });
  }

  ready(slug, token) {
    const player = this._mutate(slug, context => {
      const { event, state, now, touch, activity } = context;
      const current = this._authenticatePlayer(event.id, token);
      if (current.status === 'ready') return current;
      if (state.phase !== 'lobby' || current.heat !== state.heat || current.slot == null) fail('This heat has locked. You are queued for the next heat.');
      if (state.paused) fail('The booth is paused.');
      if (!current.mediaConnected && current.transport !== 'rehearsal') fail('Connect your camera before marking ready.', 'media_required');
      const readyBefore = this._readyPlayers(event, state).length;
      const updated = this.store.updatePlayer(current.id, { status: 'ready', readyAt: toIso(now), lastSeenAt: toIso(now) });
      const readyAfter = this._readyPlayers(event, state).length;
      if (['flexible', 'deadline'].includes(event.startMode)) {
        if (readyAfter >= event.minPlayers && (readyBefore < event.minPlayers || !state.readyDeadline))
          state.readyDeadline = toIso(now + event.joinSeconds * 1000);
        else if (readyAfter < event.minPlayers) state.readyDeadline = null;
      }
      activity('player_ready', { playerId: current.id, heat: state.heat });
      touch();
      this._maybeAutoStart(context);
      return updated;
    });
    return { player, state: this.snapshot(slug).state };
  }

  configChanged(slug, previous, current) {
    this._mutate(slug, context => {
      const { state, now, touch } = context;
      if (state.vote?.status === 'open' && JSON.stringify(previous.vote) !== JSON.stringify(current.vote)) {
        this._closeVote(context);
      }
      if (state.phase !== 'lobby') return;
      this._fillOpenLobbySlots(context);
      if (previous.startMode !== current.startMode || previous.joinSeconds !== current.joinSeconds ||
          previous.minPlayers !== current.minPlayers || previous.maxPlayers !== current.maxPlayers) {
        const readyCount = this._readyPlayers(context.event, state).length;
        const deadline = readyCount >= current.minPlayers && ['flexible', 'deadline'].includes(current.startMode)
          ? toIso(now + current.joinSeconds * 1000) : null;
        if (state.readyDeadline !== deadline) {
          state.readyDeadline = deadline;
          touch();
        }
      }
      this._maybeAutoStart(context);
    });
  }

  heartbeat(slug, token) {
    const player = this._mutate(slug, ({ event }) => {
      const current = this._authenticatePlayer(event.id, token);
      return this.store.updatePlayer(current.id, { lastSeenAt: toIso(this.now()) });
    });
    const state = this.snapshot(slug).state;
    return { player: this._withQueuePosition(this.store.getPlayer(player.id)), state };
  }

  leave(slug, token) {
    this._mutate(slug, context => {
      const { event } = context;
      const current = this._authenticatePlayer(event.id, token);
      this._removePlayer(context, current, 'left', 'player_left');
    });
    return { state: this.snapshot(slug).state };
  }

  _fillOpenLobbySlots(context) {
    const { event, state, touch } = context;
    if (state.phase !== 'lobby') return;
    const occupied = new Set(this.store.listPlayers(event.id, state.heat)
      .filter(player => player.slot != null && !['left', 'kicked'].includes(player.status))
      .map(player => player.slot));
    const openSlots = Array.from({ length: event.maxPlayers }, (_, index) => index + 1)
      .filter(slot => !occupied.has(slot));
    if (!openSlots.length) return;
    const waiting = this.store.listQueuedPlayers(event.id);
    openSlots.forEach((slot, index) => {
      const player = waiting[index];
      if (!player) return;
      this.store.updatePlayer(player.id, {
        heat: state.heat, slot, status: 'joined', readyAt: null,
        mediaConnected: false, transport: null,
      });
      touch();
    });
  }

  _removePlayer(context, player, status, activityType) {
    const { state, now, touch, activity, removeMedia } = context;
    this.store.updatePlayer(player.id, { status, mediaConnected: false, leftAt: toIso(now), slot: null });
    if (state.phase === 'lobby' && this._readyPlayers(context.event, state).length < context.event.minPlayers)
      state.readyDeadline = null;
    this._fillOpenLobbySlots(context);
    state.candidates = state.candidates.filter(item => item.playerId !== player.id);
    if (state.phase !== 'result' && state.candidate?.winners?.includes(player.id)) {
      if (state.candidate.source === 'operator') {
        const remaining = state.candidate.winners.filter(id => id !== player.id);
        state.candidate = remaining.length ? { ...state.candidate, winners: remaining } : null;
      } else {
        state.candidate = state.candidates.length
          ? this._candidateFromMatches(state, state.rulesSnapshot?.tieWindowMs ?? 0) : null;
      }
    }
    if (!state.candidates.length) state.candidateDeadline = null;
    else if (state.phase === 'hunt' && state.candidateDeadline) {
      const first = Math.min(...state.candidates.map(item => fromIso(item.verifiedAt)));
      state.candidateDeadline = toIso(Math.min(fromIso(state.roundEndsAt),
        first + (state.rulesSnapshot?.tieWindowMs ?? 0) + 120));
    }
    if (state.vote?.type === 'creative' && (state.phase !== 'result' || status === 'kicked')) {
      state.vote.options = state.vote.options.filter(option => option.id !== player.id);
      if (Array.isArray(state.vote.result)) state.vote.result = state.vote.result.filter(id => id !== player.id);
    }
    activity(activityType, { playerId: player.id, heat: player.heat });
    removeMedia(player, status);
    touch();
  }

  _readyPlayers(event, state) {
    return this.store.listPlayers(event.id, state.heat)
      .filter(player => player.status === 'ready' && player.slot != null &&
        (player.transport !== 'twilio' || player.mediaConnected))
      .sort((a, b) => a.slot - b.slot);
  }

  _choosePrompt(event, state) {
    const enabled = event.prompts.filter(prompt => prompt.enabled);
    if (!enabled.length) fail('Enable at least one prompt before starting.');
    if (!state.promptPlayCounts || typeof state.promptPlayCounts !== 'object' || Array.isArray(state.promptPlayCounts)) {
      state.promptPlayCounts = {};
      for (const heat of this.store.listHeats(event.id)) {
        if (heat.prompt?.id) state.promptPlayCounts[heat.prompt.id] = (Number(state.promptPlayCounts[heat.prompt.id]) || 0) + 1;
      }
    }
    const plays = prompt => Number(state.promptPlayCounts[prompt.id]) || 0;
    const leastPlayed = pool => {
      const fewest = Math.min(...pool.map(plays));
      const tied = pool.filter(prompt => plays(prompt) === fewest);
      const withoutLast = tied.filter(prompt => prompt.id !== state.usedPromptIds?.at(-1));
      const choices = withoutLast.length ? withoutLast : tied;
      return choices[this.randomIndex(choices.length)];
    };
    let selected = enabled.find(prompt => prompt.id === state.queuedPromptId);
    if (!selected) {
      const category = enabled.filter(prompt => prompt.category === state.preferredCategory);
      if (category.length) selected = leastPlayed(category);
      else {
        const standard = enabled.filter(prompt => promptPriority(prompt) === 'standard');
        const low = enabled.filter(prompt => promptPriority(prompt) === 'low');
        const priorAutomatic = Number.isSafeInteger(state.automaticPromptSelections) && state.automaticPromptSelections >= 0
          ? state.automaticPromptSelections : 0;
        const nextAutomatic = priorAutomatic + 1;
        const lowDue = standard.length > 0 && low.length > 0 && nextAutomatic % 5 === 0 &&
          standard.every(prompt => plays(prompt) > 0);
        selected = leastPlayed(lowDue ? low : standard.length ? standard : low);
        state.automaticPromptSelections = nextAutomatic;
      }
    }
    state.promptPlayCounts[selected.id] = plays(selected) + 1;
    state.usedPromptIds = [...(state.usedPromptIds || []).filter(id => id !== selected.id), selected.id].slice(-100);
    state.queuedPromptId = null;
    state.preferredCategory = null;
    return {
      id: selected.id, text: selected.text, category: selected.category,
      seconds: selected.seconds || event.roundSeconds,
      judgeMode: selected.judgeMode, detector: selected.detector, priority: promptPriority(selected),
      tier: selected.tier, accessNote: selected.accessNote,
    };
  }

  _lockHeat(context, readyPlayers = this._readyPlayers(context.event, context.state)) {
    const { event, state, now, touch, activity } = context;
    if (state.phase !== 'lobby') fail('This heat is already running.');
    if (state.paused) fail('Resume the event before starting.');
    if (readyPlayers.length < event.minPlayers) fail(`At least ${event.minPlayers} connected players must be ready.`, 'not_enough_players');
    if (state.vote?.status === 'open') this._closeVote(context, false);
    const selected = this._choosePrompt(event, state);
    const lockedIds = readyPlayers.map(player => player.id);
    for (const player of this.store.listPlayers(event.id, state.heat)) {
      if (['left', 'kicked'].includes(player.status)) continue;
      if (lockedIds.includes(player.id)) this.store.updatePlayer(player.id, { status: 'locked' });
      else this.store.updatePlayer(player.id, { heat: state.heat + 1, slot: null, status: 'queued' });
    }
    state.phase = 'countdown';
    state.heatId = randomUUID();
    state.promptSnapshot = selected;
    state.rulesSnapshot = {
      roundSeconds: selected.seconds, tieWindowMs: event.tieWindowMs,
      judgePolicy: event.judgePolicy, resultSeconds: event.resultSeconds,
      autoAdvance: event.autoAdvance,
    };
    state.lockedPlayerIds = lockedIds;
    state.rulesSnapshot.lockedPlayerIds = [...lockedIds];
    state.readyDeadline = null;
    state.countdownEndsAt = toIso(now + 3000);
    state.goAt = null;
    state.roundEndsAt = null;
    state.reviewEndsAt = null;
    state.resultEndsAt = null;
    state.candidates = [];
    state.candidate = null;
    state.candidateDeadline = null;
    state.judgeNotice = null;
    state.winners = [];
    state.vote = null;
    state.heatsStarted += 1;
    if (selected.judgeMode === 'ai-assisted' && this.aiVisionAvailable === false)
      this._flagJudgeUnavailable(context, 'ai_unconfigured');
    this.store.upsertHeat({
      id: state.heatId, eventId: event.id, heat: state.heat, prompt: selected,
      rules: state.rulesSnapshot,
      phase: 'countdown', startedAt: toIso(now), winners: [],
    });
    activity('heat_locked', { heatId: state.heatId, heat: state.heat, playerCount: lockedIds.length });
    touch();
  }

  _maybeAutoStart(context) {
    const { event, state, now } = context;
    if (state.phase !== 'lobby' || state.paused || state.vote?.status === 'open') return;
    const ready = this._readyPlayers(event, state);
    if (ready.length < event.minPlayers || event.startMode === 'manual') return;
    const full = ready.length >= event.maxPlayers;
    const deadline = state.readyDeadline && fromIso(state.readyDeadline) <= now;
    if ((['flexible', 'capacity'].includes(event.startMode) && full) ||
        (['flexible', 'deadline'].includes(event.startMode) && deadline)) this._lockHeat(context, ready);
  }

  _revealHeat(context) {
    const { event, state, touch, activity } = context;
    if (state.phase !== 'countdown') return;
    const goAt = fromIso(state.countdownEndsAt);
    state.phase = 'hunt';
    state.goAt = toIso(goAt);
    state.roundEndsAt = toIso(goAt + state.promptSnapshot.seconds * 1000);
    state.countdownEndsAt = null;
    for (const id of state.lockedPlayerIds) {
      const player = this.store.getPlayer(id);
      if (player && !['left', 'kicked'].includes(player.status)) this.store.updatePlayer(id, { status: 'active' });
    }
    this.store.upsertHeat({
      id: state.heatId, eventId: event.id, heat: state.heat,
      prompt: state.promptSnapshot, rules: state.rulesSnapshot,
      phase: 'hunt', startedAt: toIso(goAt - 3000), goAt: toIso(goAt), winners: [],
    });
    activity('heat_started', {
      heatId: state.heatId, heat: state.heat, playerCount: state.lockedPlayerIds.length,
      players: [...state.lockedPlayerIds],
    });
    activity('prompt_revealed', {
      heatId: state.heatId, promptId: state.promptSnapshot.id,
      promptText: state.promptSnapshot.text, category: state.promptSnapshot.category,
    });
    touch();
  }

  _candidateFromMatches(state, tieWindowMs) {
    if (!state.candidates.length) return null;
    const sorted = [...state.candidates].sort((a, b) => fromIso(a.verifiedAt) - fromIso(b.verifiedAt));
    const earliest = fromIso(sorted[0].verifiedAt);
    const tied = sorted.filter(item => fromIso(item.verifiedAt) - earliest <= tieWindowMs);
    return {
      winners: tied.map(item => item.playerId),
      source: tied.some(item => item.source === 'ai') ? 'ai' : 'rule',
      explanation: tied.map(item => item.explanation).filter(Boolean).join(' · '),
      verifiedAt: sorted[0].verifiedAt,
      confidence: Math.min(...tied.map(item => Number(item.confidence) || 0)),
    };
  }

  _enterReview(context) {
    const { event, state, now, touch, activity } = context;
    state.phase = 'review';
    if (state.promptSnapshot?.judgeMode === 'ai-assisted' && this.aiVisionAvailable === false)
      this._flagJudgeUnavailable(context, 'ai_unconfigured');
    state.reviewEndsAt = !state.judgeNotice && state.rulesSnapshot.judgePolicy === 'auto-with-override' && state.promptSnapshot?.judgeMode !== 'operator'
      ? toIso(now + (state.promptSnapshot?.judgeMode === 'ai-assisted' ? 9000 : 6000)) : null;
    state.candidate = this._candidateFromMatches(state, state.rulesSnapshot.tieWindowMs);
    activity('judge_review_opened', { heatId: state.heatId, candidateCount: state.candidates.length });
    touch();
  }

  _finalize(context, winners, source, reason = '') {
    const { event, state, now, touch, activity } = context;
    if (!state.heatId || !['hunt', 'review', 'result'].includes(state.phase)) fail('There is no heat to award.');
    const unique = [...new Set(winners || [])];
    const previous = state.phase === 'result';
    if (unique.some(id => {
      const player = this.store.getPlayer(id);
      return !state.lockedPlayerIds.includes(id) || !player || player.status === 'kicked' ||
        (player.status === 'left' && !(previous && state.resultRoster?.some(spot => spot.id === id)));
    })) fail('Choose a player in this heat.');
    const isOverride = previous || (source === 'operator' && state.candidate &&
      JSON.stringify([...state.candidate.winners].sort()) !== JSON.stringify([...unique].sort()));
    if (!previous) state.resultRoster = this.store.listPlayers(event.id, state.heat)
      .filter(player => state.lockedPlayerIds.includes(player.id) && player.slot != null && player.status !== 'kicked')
      .sort((a, b) => a.slot - b.slot)
      .map(player => ({ id: player.id, alias: player.alias, slot: player.slot }));
    state.phase = 'result';
    state.winners = unique;
    state.resultEndsAt = state.paused ? null : toIso(now + state.rulesSnapshot.resultSeconds * 1000);
    if (state.paused) state.pauseRemaining = { resultEndsAt: state.rulesSnapshot.resultSeconds * 1000 };
    state.reviewEndsAt = null;
    state.candidateDeadline = null;
    if (source === 'operator' || source === 'override') {
      state.candidate = { winners: unique, source: isOverride ? 'override' : 'operator',
        explanation: reason || 'Selected by booth operator', verifiedAt: toIso(now), confidence: 1 };
    }
    if (isOverride) state.overrideCount += 1;
    for (const id of state.lockedPlayerIds) {
      const player = this.store.getPlayer(id);
      if (player && !['left', 'kicked'].includes(player.status)) this.store.updatePlayer(id, { status: 'finished' });
    }
    const existing = this.store.listHeats(event.id).find(heat => heat.id === state.heatId);
    this.store.upsertHeat({
      id: state.heatId, eventId: event.id, heat: state.heat,
      prompt: state.promptSnapshot,
      rules: existing?.rules || state.rulesSnapshot,
      phase: 'result', startedAt: existing?.startedAt || toIso(now),
      goAt: existing?.goAt, endedAt: toIso(now), winners: unique, candidate: state.candidate,
    });
    if (!previous) activity('heat_completed', { heatId: state.heatId, heat: state.heat, promptId: state.promptSnapshot.id });
    activity('winner_finalized', {
      heatId: state.heatId, heat: state.heat, promptId: state.promptSnapshot.id,
      winners: unique, source: isOverride ? 'override' : source, isOverride, reason: reason || undefined,
    });
    touch();
  }

  _openVote(context, type) {
    const { event, state, now, touch, activity } = context;
    if (!event.vote.enabled) fail('Voting is disabled for this event.');
    if (state.vote?.status === 'open') fail('A ballot is already open.');
    if (type === 'category' && state.phase !== 'lobby') fail('Category voting opens between heats.');
    if (type === 'creative' && state.phase !== 'review') fail('Creative voting opens after a hunt.');
    const options = type === 'category'
      ? event.vote.categories.filter(category => event.prompts.some(prompt => prompt.enabled && prompt.category === category))
        .map((category, index) => ({ id: category, label: category, code: String(index + 1) }))
      : state.lockedPlayerIds.map((id, index) => {
        const player = this.store.getPlayer(id);
        return ['left', 'kicked'].includes(player?.status) ? null : { id, label: player?.alias || `Player ${index + 1}`, code: String(index + 1) };
      }).filter(Boolean);
    if (options.length < 2) fail('A ballot needs at least two options.');
    state.vote = {
      id: randomUUID(), type, status: 'open', openedAt: toIso(now),
      closesAt: toIso(now + (type === 'creative' ? event.vote.creativeWindowSeconds : event.vote.windowSeconds) * 1000),
      options, result: null,
    };
    if (type === 'creative') state.reviewEndsAt = null;
    activity('vote_opened', { windowId: state.vote.id, windowType: type, heat: state.heat });
    touch();
    return state.vote;
  }

  _closeVote(context, startAfter = true) {
    const { event, state, touch, activity } = context;
    const vote = state.vote;
    if (!vote || vote.status !== 'open') return null;
    const publicBallot = publicVote(this.store, event.id, vote);
    const max = Math.max(0, ...Object.values(publicBallot.tallies));
    const top = max ? vote.options.filter(option => publicBallot.tallies[option.id] === max).map(option => option.id) : [];
    vote.status = 'closed';
    vote.closesAt = toIso(context.now);
    vote.result = vote.type === 'category' ? top[0] || null : top;
    if (vote.type === 'category') state.preferredCategory = vote.result;
    activity('vote_closed', { windowId: vote.id, windowType: vote.type, heat: state.heat,
      votes: Object.values(publicBallot.tallies).reduce((sum, value) => sum + value, 0) });
    touch();
    if (vote.type === 'creative') this._finalize(context, top, 'audience', max ? 'Audience ballot' : 'No audience ballots');
    else if (startAfter) this._maybeAutoStart(context);
    return vote.result;
  }

  _nextHeat(context) {
    const { event, state, now, touch, activity } = context;
    if (state.phase !== 'result') fail('Finalize this heat before opening the next one.');
    const oldHeat = state.heat;
    const preserved = { usedPromptIds: state.usedPromptIds, promptPlayCounts: state.promptPlayCounts,
      automaticPromptSelections: state.automaticPromptSelections,
      heatsStarted: state.heatsStarted, overrideCount: state.overrideCount };
    Object.assign(state, initialRuntime(event.id, now), preserved, { heat: oldHeat + 1, version: state.version });
    const waiting = this.store.listQueuedPlayers(event.id);
    waiting.forEach((player, index) => {
      this.store.updatePlayer(player.id, { heat: state.heat + (index >= event.maxPlayers ? 1 : 0),
        slot: index < event.maxPlayers ? index + 1 : null,
        status: index < event.maxPlayers ? 'joined' : 'queued' });
    });
    activity('next_heat_opened', { heat: state.heat, promoted: Math.min(waiting.length, event.maxPlayers) });
    if (event.vote.enabled && event.vote.categories.length >= 2) {
      try { this._openVote(context, 'category'); } catch { /* Single enabled category leaves a plain lobby. */ }
    }
    touch();
  }

  acceptJudgment(slug, { playerId, matched, confidence = 0, explanation = '', source = 'rule', receiptAt = this.now() } = {}) {
    if (!matched) return { candidate: null };
    const candidate = this._mutate(slug, context => {
      const { event, state, touch, activity } = context;
      const received = Number(receiptAt);
      if (!Number.isFinite(received) || !['rule', 'ai'].includes(source)) fail('Invalid evidence result.');
      const player = this.store.getPlayer(playerId);
      if (!['hunt', 'review'].includes(state.phase) || !state.lockedPlayerIds.includes(playerId) ||
        !player || ['left', 'kicked'].includes(player.status) ||
        (player.transport === 'twilio' && !player.mediaConnected)) return state.candidate;
      if (!state.goAt || received < fromIso(state.goAt) || received > fromIso(state.roundEndsAt) + 500) return state.candidate;
      if (state.candidates.some(item => item.playerId === playerId)) return state.candidate;
      const item = {
        playerId, verifiedAt: toIso(received), source,
        confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
        explanation: String(explanation).slice(0, 240),
      };
      state.candidates.push(item);
      state.candidate = this._candidateFromMatches(state, state.rulesSnapshot.tieWindowMs);
      if (state.phase === 'hunt' && !state.candidateDeadline) {
        state.candidateDeadline = toIso(Math.min(fromIso(state.roundEndsAt), received + state.rulesSnapshot.tieWindowMs + 120));
      }
      activity('match_verified', {
        heatId: state.heatId, playerId, source,
        timeToMatchMs: Math.max(0, received - fromIso(state.goAt)),
      });
      activity(source === 'ai' ? 'ai_proposed' : 'judge_proposed', {
        heatId: state.heatId, playerId, confidence: item.confidence,
      });
      touch();
      return state.candidate;
    });
    return { candidate };
  }

  castVote(slug, { windowId, choice, voterHash, channel = 'web', sessionId = null } = {}) {
    this.tickEvent(slug);
    const answer = this._mutate(slug, context => {
      const { event, state, now, touch, activity } = context;
      if (!event.vote.enabled || !event.vote.channels[channel]) fail('This vote channel is disabled.', 'vote_disabled');
      const vote = state.vote;
      if (!vote || vote.status !== 'open' || vote.id !== windowId || fromIso(vote.closesAt) <= now) fail('This ballot is closed.', 'vote_closed');
      if (typeof voterHash !== 'string' || !/^[a-f0-9]{32,128}$/i.test(voterHash)) fail('Voter session required.');
      if (sessionId != null && !/^[a-f0-9]{20}$/.test(sessionId)) fail('Invalid activity session.', 'invalid_activity');
      const option = vote.options.find(item => item.id === choice || item.code.toUpperCase() === String(choice ?? '').trim().toUpperCase());
      if (!option) fail('Choose a valid ballot option.');
      const result = this.store.castVote({
        eventId: event.id, windowId: vote.id, windowType: vote.type,
        voterHash, channel, choice: option.id, receivedAt: toIso(now),
      });
      if (!result.accepted) fail('You already voted in this ballot.', 'duplicate_vote');
      activity('vote_accepted', {
        voterId: voterHash.slice(0, 20), windowId: vote.id, windowType: vote.type,
        channel, choice: option.id, choiceLabel: option.label,
        ...(sessionId ? { sessionId } : {}),
      });
      touch();
      return true;
    });
    return { accepted: answer, vote: this.snapshot(slug).state.vote };
  }

  activity(slug, type, properties = {}) {
    const allowed = new Set([
      'landing_opened', 'join_page_viewed', 'camera_enabled', 'camera_failed',
      'result_viewed', 'cta_opened', 'guide_cta_opened', 'expert_cta_opened',
      'twilio_product_link_opened', 'github_cta_opened',
      'lead_form_opened', 'player_help_opened', 'vote_page_opened',
      'arena_opened',
    ]);
    if (!allowed.has(type)) fail('Unknown activity type.', 'invalid_activity');
    const productLink = type === 'twilio_product_link_opened';
    const githubLink = type === 'github_cta_opened';
    if ((productLink && !['video', 'messaging', 'segment'].includes(properties.product)) ||
      (githubLink && Object.hasOwn(properties, 'source') && !['phone', 'spectator', 'arena_qr', 'arena_link'].includes(properties.source)) ||
      Object.keys(properties).some(key => key !== 'sessionId' && !(productLink && key === 'product') && !(githubLink && key === 'source')) ||
      (properties.sessionId != null && !/^[a-f0-9]{20}$/.test(properties.sessionId))) fail('Invalid activity session.', 'invalid_activity');
    this._mutate(slug, ({ activity }) => activity(type, properties));
    return { ok: true };
  }

  command(slug, type, payload = {}, user = null) {
    if (typeof payload !== 'object' || payload == null || Array.isArray(payload)) fail('Invalid command payload.');
    this._mutate(slug, context => {
      const { event, state, now, touch, activity } = context;
      const operatorId = user?.id || null;
      switch (type) {
        case 'start': {
          this._lockHeat(context);
          break;
        }
        case 'pause': {
          if (state.paused) break;
          const deadlines = ['readyDeadline', 'countdownEndsAt', 'roundEndsAt', 'reviewEndsAt', 'resultEndsAt', 'candidateDeadline'];
          const remaining = {};
          for (const key of deadlines) {
            if (state[key]) { remaining[key] = Math.max(0, fromIso(state[key]) - now); state[key] = null; }
          }
          if (state.vote?.status === 'open') {
            remaining.vote = Math.max(0, fromIso(state.vote.closesAt) - now);
            state.vote.closesAt = null;
          }
          state.pauseRemaining = remaining;
          state.paused = true;
          activity('event_paused', { heat: state.heat });
          touch();
          break;
        }
        case 'resume': {
          if (!state.paused) break;
          for (const [key, remaining] of Object.entries(state.pauseRemaining || {})) {
            if (key === 'vote' && state.vote?.status === 'open') state.vote.closesAt = toIso(now + remaining);
            else if (key !== 'vote') state[key] = toIso(now + remaining);
          }
          state.paused = false;
          state.pauseRemaining = null;
          activity('event_resumed', { heat: state.heat });
          touch();
          break;
        }
        case 'queuePrompt': {
          const prompt = event.prompts.find(item => item.id === String(payload.promptId || '') && item.enabled);
          if (!prompt) fail('Choose an enabled prompt.');
          state.queuedPromptId = prompt.id;
          activity('prompt_queued', { promptId: prompt.id, heat: state.heat });
          touch();
          break;
        }
        case 'kickPlayer': {
          const playerId = String(payload.playerId || '');
          const player = this.store.getPlayer(playerId);
          if (!player || player.eventId !== event.id) fail('Player not found in this event.', 'not_found');
          if (['left', 'kicked'].includes(player.status) ||
            (player.status !== 'queued' && (player.heat !== state.heat || player.slot == null)))
            fail('This player is no longer in the current game.');
          this._removePlayer(context, player, 'kicked', 'player_kicked');
          if (state.phase === 'result' && state.winners.includes(playerId)) {
            this._finalize(context, state.winners.filter(id => id !== playerId), 'override', 'Winner removed by booth operator');
          }
          break;
        }
        case 'proposeWinner': {
          if (!['hunt', 'review'].includes(state.phase)) fail('There is no active heat to judge.');
          const winners = Array.isArray(payload.winners) ? [...new Set(payload.winners.map(String))] : [];
          if (!winners.length || winners.some(id => !state.lockedPlayerIds.includes(id) ||
            ['left', 'kicked'].includes(this.store.getPlayer(id)?.status))) fail('Select one or more players in this heat.');
          state.candidate = { winners, source: 'operator', explanation: String(payload.reason || 'Operator proposal').slice(0, 240),
            verifiedAt: toIso(now), confidence: 1 };
          activity('judge_proposed', { heatId: state.heatId, winners, source: 'operator' });
          touch();
          break;
        }
        case 'award': {
          const winners = Array.isArray(payload.winners) ? payload.winners.map(String) : state.candidate?.winners || [];
          if (!winners.length) fail('Select one or more winners or use No match.');
          this._finalize(context, winners, 'operator', String(payload.reason || '').slice(0, 240));
          break;
        }
        case 'noMatch': {
          this._finalize(context, [], 'operator', String(payload.reason || 'No match').slice(0, 240));
          break;
        }
        case 'correctHeat': {
          const heatId = String(payload.heatId || '');
          const heat = this.store.listHeats(event.id).find(item => item.id === heatId && item.phase === 'result');
          if (!heat) fail('Choose a completed heat to correct.');
          if (!Array.isArray(payload.winners)) fail('Provide a winner list, or an empty list for no match.');
          const winners = [...new Set(payload.winners.map(String))];
          const eligible = heat.rules?.lockedPlayerIds || this.store.listPlayers(event.id, heat.heat)
            .filter(player => player.status === 'finished').map(player => player.id);
          if (winners.some(id => !eligible.includes(id))) fail('Choose a player who competed in that heat.');
          const reason = String(payload.reason || 'Operator correction').slice(0, 240);
          if (state.heatId === heatId && state.phase === 'result') {
            this._finalize(context, winners, 'override', reason);
          } else {
            const candidate = { winners, source: 'override', explanation: reason,
              verifiedAt: toIso(now), confidence: 1 };
            this.store.upsertHeat({ ...heat, winners, candidate });
            state.overrideCount += 1;
            activity('winner_finalized', {
              heatId, heat: heat.heat, promptId: heat.prompt.id,
              winners, source: 'override', isOverride: true, reason,
            });
            touch();
          }
          break;
        }
        case 'nextHeat': {
          this._nextHeat(context);
          break;
        }
        case 'reset': {
          for (const player of this.store.listPlayers(event.id)) {
            if (!['left', 'finished'].includes(player.status)) this.store.updatePlayer(player.id, {
              status: 'left', slot: null, mediaConnected: false, leftAt: toIso(now),
            });
          }
          const next = initialRuntime(event.id, now);
          Object.assign(state, next, { heat: state.heat + 1, version: state.version,
            heatsStarted: state.heatsStarted, overrideCount: state.overrideCount,
            usedPromptIds: state.usedPromptIds, promptPlayCounts: state.promptPlayCounts,
            automaticPromptSelections: state.automaticPromptSelections });
          activity('event_reset', { heat: state.heat });
          touch();
          break;
        }
        case 'openVote': {
          this._openVote(context, String(payload.voteType || payload.type || 'category'));
          break;
        }
        case 'closeVote': {
          if (!state.vote || state.vote.status !== 'open') fail('No ballot is open.');
          this._closeVote(context);
          break;
        }
        case 'selectCategory': {
          const category = String(payload.category || '');
          if (!event.vote.categories.includes(category) || !event.prompts.some(prompt => prompt.enabled && prompt.category === category)) fail('Choose an available category.');
          if (state.phase !== 'lobby') fail('Select the next category between heats.');
          if (state.vote?.status === 'open') {
            state.vote.status = 'closed';
            state.vote.result = category;
            state.vote.closesAt = toIso(now);
          }
          state.preferredCategory = category;
          activity('category_selected', { category, heat: state.heat });
          touch();
          this._maybeAutoStart(context);
          break;
        }
        default: fail('Unknown operator command.');
      }
      this.store.audit(event.id, operatorId, `command:${type}`, {
        heat: state.heat,
        ...(['award', 'proposeWinner', 'correctHeat'].includes(type) ? { winners: payload.winners || [] } : {}),
        ...(type === 'correctHeat' ? { heatId: payload.heatId } : {}),
        ...(type === 'kickPlayer' ? { playerId: payload.playerId } : {}),
      });
    });
    return { state: this.snapshot(slug, 'operator').state };
  }

  tickEvent(slug) {
    const event = this.store.getEvent(slug);
    if (!event) return false;
    const state = this.store.getRuntime(event.id);
    if (!state || state.paused) return false;
    const now = this.now();
    const due = value => value && fromIso(value) <= now;
    const needsTick =
      (state.phase === 'lobby' && (due(state.vote?.status === 'open' ? state.vote.closesAt : null) || due(state.readyDeadline))) ||
      (state.phase === 'countdown' && due(state.countdownEndsAt)) ||
      (state.phase === 'hunt' && (due(state.candidateDeadline) || due(state.roundEndsAt))) ||
      (state.phase === 'review' && (due(state.vote?.status === 'open' ? state.vote.closesAt : null) || due(state.reviewEndsAt))) ||
      (state.phase === 'result' && (state.rulesSnapshot?.autoAdvance ?? event.autoAdvance) && due(state.resultEndsAt));
    if (!needsTick) return false;
    this._mutate(slug, context => {
      for (let step = 0; step < 8; step++) {
        const { event: currentEvent, state: current, now: time, touch } = context;
        const passed = value => value && fromIso(value) <= time;
        if (current.phase === 'lobby') {
          if (current.vote?.status === 'open' && passed(current.vote.closesAt)) { this._closeVote(context); continue; }
          if (passed(current.readyDeadline)) {
            const ready = this._readyPlayers(currentEvent, current);
            if (ready.length >= currentEvent.minPlayers) this._maybeAutoStart(context);
            else { current.readyDeadline = null; touch(); }
          }
          break;
        }
        if (current.phase === 'countdown' && passed(current.countdownEndsAt)) { this._revealHeat(context); continue; }
        if (current.phase === 'hunt') {
          const matchDue = passed(current.candidateDeadline) && current.candidates.length;
          if (matchDue) {
            const proposal = this._candidateFromMatches(current, current.rulesSnapshot.tieWindowMs);
            const auto = !current.judgeNotice && current.rulesSnapshot.judgePolicy === 'auto-with-override' &&
              (proposal.source === 'rule' || proposal.confidence >= 0.93);
            if (auto) this._finalize(context, proposal.winners, proposal.source, proposal.explanation);
            else this._enterReview(context);
            continue;
          }
          if (passed(current.roundEndsAt)) {
            if (current.promptSnapshot?.judgeMode === 'audience' && currentEvent.vote.enabled) {
              this._enterReview(context);
              try { this._openVote(context, 'creative'); }
              catch { this._finalize(context, [], 'audience', 'Creative ballot unavailable'); }
            } else if (current.candidates.length) {
              const proposal = this._candidateFromMatches(current, current.rulesSnapshot.tieWindowMs);
              const auto = !current.judgeNotice && current.rulesSnapshot.judgePolicy === 'auto-with-override' &&
                (proposal.source === 'rule' || proposal.confidence >= 0.93);
              if (auto) this._finalize(context, proposal.winners, proposal.source, proposal.explanation);
              else this._enterReview(context);
            } else if (['ai-assisted', 'operator'].includes(current.promptSnapshot?.judgeMode)) this._enterReview(context);
            else if (current.rulesSnapshot.judgePolicy === 'auto-with-override') this._finalize(context, [], 'timeout', 'No verified match');
            else this._enterReview(context);
            continue;
          }
          break;
        }
        if (current.phase === 'review') {
          if (current.vote?.status === 'open' && passed(current.vote.closesAt)) { this._closeVote(context); continue; }
          if (current.judgeNotice && current.reviewEndsAt) { current.reviewEndsAt = null; touch(); break; }
          if (passed(current.reviewEndsAt)) {
            const proposal = current.candidate;
            if (proposal?.winners?.length && proposal.confidence >= 0.82)
              this._finalize(context, proposal.winners, proposal.source, proposal.explanation);
            else this._finalize(context, [], 'timeout', 'No verified match');
            continue;
          }
          break;
        }
        if (current.phase === 'result' && (current.rulesSnapshot?.autoAdvance ?? currentEvent.autoAdvance) && passed(current.resultEndsAt)) { this._nextHeat(context); continue; }
        break;
      }
    });
    return true;
  }

  tickAll() {
    for (const event of this.store.listEvents()) {
      try {
        this.tickEvent(event.slug);
        if (this.now() - (this.lastPresenceSweep.get(event.id) ?? -Infinity) >= 5000) {
          this.lastPresenceSweep.set(event.id, this.now());
          this._sweepPresence(event.slug);
        }
      }
      catch (error) { console.error(`Heat clock for ${event.slug}: ${error.message}`); }
    }
  }

  _sweepPresence(slug) {
    this._mutate(slug, context => {
      const { event, state, now, touch } = context;
      for (const player of this.store.listPlayers(event.id)) {
        if (['left', 'kicked', 'finished'].includes(player.status)) continue;
        const age = now - fromIso(player.lastSeenAt);
        if (age < INACTIVE_WAITING_MS) continue;
        if (player.status === 'queued' || (state.phase === 'lobby' && player.heat === state.heat)) {
          this._removePlayer(context, player, 'left', 'player_timed_out');
        } else if (age >= INACTIVE_HEAT_MS) {
          this._removePlayer(context, player, 'left', 'player_timed_out');
        } else if (player.mediaConnected) {
          this.store.updatePlayer(player.id, { mediaConnected: false });
          touch();
        }
      }
    });
  }
}
