/* Signal Stadium visual prototype: anonymous, browser-local event log. */
(() => {
  const KEY = "signal-stadium-demo-metrics-v1";
  const CHANGE_EVENT = "signal-stadium-metrics-change";
  const MAX_EVENTS = 10000;
  const PRIVATE_KEYS = /^(name|email|workEmail|phone|phoneNumber|company|message|body|address)$/i;
  const SINGLE_HEAT_TYPES = new Set(["heat_started", "prompt_revealed", "heat_completed"]);
  const ACTION_TYPES = new Set(["player_joined", "result_viewed", "cta_opened", "lead_form_opened", "lead_submitted", "vote_accepted"]);

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function uid() { return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
  function validEvent(value) { return value && typeof value.id === "string" && typeof value.eventId === "string" && typeof value.type === "string" && Number.isFinite(Date.parse(value.at)); }
  function read() {
    try { const value = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(value?.events) ? value.events.filter(validEvent) : []; }
    catch { return []; }
  }
  function publicProperties(raw) {
    const result = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
    for (const [key, value] of Object.entries(raw)) {
      if (PRIVATE_KEYS.test(key) || key.length > 48) continue;
      if (value == null || typeof value === "boolean" || typeof value === "number") result[key] = value;
      else if (typeof value === "string") result[key] = value.slice(0, 140);
      else if (Array.isArray(value)) result[key] = value.filter(item => ["string", "number", "boolean"].includes(typeof item)).slice(0, 12).map(item => typeof item === "string" ? item.slice(0, 80) : item);
    }
    return result;
  }
  function write(events) {
    try { localStorage.setItem(KEY, JSON.stringify({ schema: 1, events: events.slice(-MAX_EVENTS) })); window.dispatchEvent(new CustomEvent(CHANGE_EVENT)); return true; }
    catch { return false; }
  }
  function record(eventId, type, properties = {}) {
    if (!String(eventId || "").trim() || !String(type || "").trim()) return null;
    const publicProps = publicProperties(properties), existing = read();
    if (SINGLE_HEAT_TYPES.has(type) && publicProps.heatId) {
      const prior = existing.find(item => item.eventId === eventId && item.type === type && item.properties?.heatId === publicProps.heatId);
      if (prior) return clone(prior);
    }
    const event = { id: `metric-${uid()}`, eventId: String(eventId).slice(0, 80), type: String(type).slice(0, 64), at: new Date().toISOString(), properties: publicProps };
    return write([...existing, event]) ? clone(event) : null;
  }
  function recordOnce(eventId, type, dedupeKey, properties = {}) {
    if (!dedupeKey) return record(eventId, type, properties);
    const key = String(dedupeKey).slice(0, 140);
    const prior = read().find(item => item.eventId === eventId && item.type === type && item.properties?.dedupeKey === key);
    return prior ? clone(prior) : record(eventId, type, { ...properties, dedupeKey: key });
  }
  function boundary(value, endOfDay = false) {
    if (!value) return null;
    if (value instanceof Date) return value.getTime();
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) { const date = new Date(`${value}T00:00:00`); if (endOfDay) date.setDate(date.getDate() + 1); return date.getTime() - (endOfDay ? 1 : 0); }
    const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null;
  }
  function select(records, { eventId = null, from = null, to = null } = {}) {
    const start = boundary(from), end = boundary(to, true);
    return records.filter(item => { if (eventId && eventId !== "all" && item.eventId !== eventId) return false; const at = Date.parse(item.at); return (start == null || at >= start) && (end == null || at <= end); }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }
  function query(filters = {}) { return clone(select(read(), filters)); }
  function isEngagementAction(type) { return ACTION_TYPES.has(type); }
  function uniquePeople(items) {
    const ids = new Set(); let withoutId = 0;
    for (const item of items) { const id = item.properties?.participantId || item.properties?.sessionId; if (id) ids.add(`${item.eventId}:${id}`); else withoutId++; }
    return ids.size + withoutId;
  }
  function summarizeEvents(records) {
    const events = Array.isArray(records) ? records.filter(validEvent) : [];
    const byType = type => events.filter(item => item.type === type);
    const landings = byType("landing_opened"), joins = byType("player_joined"), heatStarts = byType("heat_started"), heatEnds = byType("heat_completed");
    const resultViews = byType("result_viewed"), ctaOpens = byType("cta_opened"), leadForms = byType("lead_form_opened"), leads = byType("lead_submitted"), votes = byType("vote_accepted");
    const awardActions = byType("winner_finalized"), proposals = byType("judge_proposed"), verified = byType("match_verified"), promptReveals = byType("prompt_revealed");
    const finalByHeat = new Map();
    for (const item of awardActions) finalByHeat.set(`${item.eventId}:${item.properties?.heatId || item.id}`, item);
    const awards = [...finalByHeat.values()];
    const guide = byType("guide_requested"), expert = byType("expert_requested"), cameraFailures = byType("camera_failed");
    const playerEntries = heatStarts.reduce((total, item) => total + (Number(item.properties?.playerCount) || 0), 0);
    const ties = awards.filter(item => Array.isArray(item.properties?.winners) && item.properties.winners.length > 1).length;
    const noMatches = awards.filter(item => Array.isArray(item.properties?.winners) && item.properties.winners.length === 0).length;
    const overrides = awardActions.filter(item => item.properties?.isOverride === true || item.properties?.source === "override").length;
    const durations = verified.map(item => Number(item.properties?.timeToMatchMs)).filter(value => Number.isFinite(value) && value >= 0);
    const promptMap = new Map();
    for (const item of promptReveals) {
      const id = item.properties?.promptId || "unknown";
      if (!promptMap.has(id)) promptMap.set(id, { promptId: id, text: item.properties?.promptText || id, category: item.properties?.category || "", plays: 0, matches: 0, noMatches: 0, overrides: 0 });
      promptMap.get(id).plays++;
    }
    for (const item of awards) {
      const id = item.properties?.promptId;
      if (!id) continue;
      if (!promptMap.has(id)) promptMap.set(id, { promptId: id, text: item.properties?.promptText || id, category: item.properties?.category || "", plays: 0, matches: 0, noMatches: 0, overrides: 0 });
      const row = promptMap.get(id);
      if ((item.properties?.winners || []).length) row.matches++; else row.noMatches++;
      if (item.properties?.isOverride === true || item.properties?.source === "override") row.overrides++;
    }
    const days = new Map();
    for (const item of events) {
      const date = new Date(item.at), key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      if (!days.has(key)) days.set(key, { day: key, landings: 0, joins: 0, heats: 0, leads: 0, interactions: 0 });
      const row = days.get(key);
      if (item.type === "landing_opened") row.landings++;
      if (item.type === "player_joined") row.joins++;
      if (item.type === "heat_started") row.heats++;
      if (item.type === "lead_submitted") row.leads++;
      if (ACTION_TYPES.has(item.type)) row.interactions++;
    }
    const channelVotes = { web: 0, sms: 0, whatsapp: 0 };
    votes.forEach(item => { const channel = String(item.properties?.channel || "web").toLowerCase(); if (channel in channelVotes) channelVotes[channel]++; });
    return {
      totalEvents: events.length,
      engagementActions: events.filter(item => ACTION_TYPES.has(item.type)).length,
      landings: landings.length, uniqueVisitors: uniquePeople(landings),
      joins: joins.length, uniquePlayers: uniquePeople(joins), playerEntries,
      repeatEntries: Math.max(0, joins.length - uniquePeople(joins)),
      heatsStarted: heatStarts.length, heatsCompleted: heatEnds.length,
      averagePlayers: heatStarts.length ? playerEntries / heatStarts.length : 0,
      resultViews: resultViews.length, ctaOpens: ctaOpens.length, uniqueCtaVisitors: uniquePeople(ctaOpens),
      leadFormOpens: leadForms.length, leads: leads.length, uniqueLeads: uniquePeople(leads),
      guideRequests: guide.length, expertRequests: expert.length, votes: votes.length, channelVotes,
      promptsPlayed: promptReveals.length, verifiedMatches: verified.length, judgeProposals: proposals.length,
      awards: awards.length, awardActions: awardActions.length, ties, noMatches, overrides, cameraFailures: cameraFailures.length,
      avgMatchMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
      prompts: [...promptMap.values()].sort((a, b) => b.plays - a.plays || a.text.localeCompare(b.text)),
      daily: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
      recent: [...events].reverse().slice(0, 20),
      funnel: [
        { label: "Opened", count: uniquePeople(landings) },
        { label: "Joined", count: uniquePeople(joins) },
        { label: "Saw result", count: uniquePeople(resultViews) },
        { label: "Opened CTA", count: uniquePeople(ctaOpens) },
        { label: "Left lead", count: uniquePeople(leads) },
      ],
    };
  }
  function summarize(filters = {}) { return summarizeEvents(query(filters)); }
  function subscribe(listener) {
    const onStorage = event => { if (event.key === KEY) listener(); };
    window.addEventListener("storage", onStorage); window.addEventListener(CHANGE_EVENT, listener);
    return () => { window.removeEventListener("storage", onStorage); window.removeEventListener(CHANGE_EVENT, listener); };
  }

  window.SignalStadiumMetrics = { KEY, MAX_EVENTS, record, recordOnce, query, summarize, summarizeEvents, select, isEngagementAction, subscribe };
})();
