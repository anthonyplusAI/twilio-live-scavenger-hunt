/* Signal Stadium visual prototype. Browser-local data is a stand-in for a server database. */
(() => {
  const EVENTS_KEY = "signal-stadium-demo-events-v1";
  const COMMAND_KEY = "signal-stadium-demo-command-v1";
  const STATE_KEY = "signal-stadium-demo-state-v1";
  const CHANGE_EVENT = "signal-stadium-demo-change";
  const startModes = ["flexible", "capacity", "deadline", "manual"];
  const judgePolicies = ["auto-with-override", "operator-confirm", "manual"];
  const judgeModes = ["rule", "ai-assisted", "audience", "operator"];
  const categories = ["Color", "Object", "Shape", "Text", "Gesture", "Combination", "Creative"];
  const leadFieldModes = ["required", "optional", "hidden"];
  const leadFieldTypes = ["text", "email", "tel"];
  const leadFieldPresets = [
    { id: "name", label: "Name", type: "text", required: true },
    { id: "email", label: "Work email", type: "email", required: true },
    { id: "company", label: "Company", type: "text", required: false },
    { id: "jobTitle", label: "Job title", type: "text", required: false },
    { id: "phone", label: "Phone number", type: "tel", required: false },
  ];

  const samplePrompts = [
    { id: "color-red", text: "SHOW SOMETHING RED", category: "Color", judgeMode: "rule", detector: "color", enabled: true, seconds: null },
    { id: "object-cup", text: "SHOW A CUP", category: "Object", judgeMode: "rule", detector: "object", enabled: true, seconds: null },
    { id: "combo-red-cup", text: "SHOW A RED CUP", category: "Combination", judgeMode: "ai-assisted", detector: "object+color", enabled: true, seconds: null },
    { id: "shape-triangle", text: "FIND THE TRIANGLE", category: "Shape", judgeMode: "rule", detector: "shape-card", enabled: true, seconds: null },
    { id: "text-twilio", text: "FIND THE WORD TWILIO", category: "Text", judgeMode: "rule", detector: "ocr-card", enabled: true, seconds: null },
    { id: "text-api", text: "FIND THE WORD API", category: "Text", judgeMode: "rule", detector: "ocr-card", enabled: true, seconds: null },
    { id: "text-code", text: "FIND THE WORD CODE", category: "Text", judgeMode: "rule", detector: "ocr-card", enabled: true, seconds: null },
    { id: "text-webhook", text: "FIND THE WORD WEBHOOK", category: "Text", judgeMode: "rule", detector: "ocr-card", enabled: true, seconds: null },
    { id: "text-404", text: "FIND THE NUMBER 404", category: "Text", judgeMode: "rule", detector: "ocr-card", enabled: true, seconds: null },
    { id: "gesture-peace", text: "MAKE A PEACE SIGN", category: "Gesture", judgeMode: "rule", detector: "gesture", enabled: true, seconds: null },
    { id: "creative-trophy", text: "MAKE A TINY TROPHY", category: "Creative", judgeMode: "audience", detector: "vote", enabled: false, seconds: 30 },
  ];

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function numberIn(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
  }
  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? clone(fallback); }
    catch { return clone(fallback); }
  }
  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { key, value } }));
      return { ok: true, value: clone(value) };
    } catch (error) {
      return { ok: false, error: error?.message || "Could not save in this browser" };
    }
  }
  function uid(prefix) {
    const rand = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${rand}`;
  }
  function normalizePrompt(prompt, index) {
    const raw = prompt && typeof prompt === "object" ? prompt : {};
    return {
      id: String(raw.id || uid("prompt")).slice(0, 80),
      text: String(raw.text || `NEW PROMPT ${index + 1}`).trim().slice(0, 55),
      category: categories.includes(raw.category) ? raw.category : "Object",
      judgeMode: judgeModes.includes(raw.judgeMode) ? raw.judgeMode : "operator",
      detector: String(raw.detector || "manual").slice(0, 60),
      enabled: Boolean(raw.enabled),
      seconds: raw.seconds == null || raw.seconds === "" ? null : numberIn(raw.seconds, 5, 180, null),
    };
  }
  function normalizeLeadCapture(raw = {}, previous = {}) {
    const source = raw && typeof raw === "object" ? raw : {};
    const earlier = previous && typeof previous === "object" ? previous : {};
    const booleanValue = (key, fallback) => source[key] == null ? (earlier[key] ?? fallback) : Boolean(source[key]);
    const fieldMode = (key, fallback) => leadFieldModes.includes(source[key])
      ? source[key]
      : leadFieldModes.includes(earlier[key]) ? earlier[key] : fallback;
    const legacyFields = () => {
      const fields = [];
      const nameMode = fieldMode("nameMode", "required");
      const companyMode = fieldMode("companyMode", "optional");
      if (nameMode !== "hidden") fields.push({ ...leadFieldPresets[0], required: nameMode === "required" });
      fields.push({ ...leadFieldPresets[1] });
      if (companyMode !== "hidden") fields.push({ ...leadFieldPresets[2], required: companyMode === "required" });
      return fields;
    };
    const fieldSource = Array.isArray(source.fields) ? source.fields
      : Array.isArray(earlier.fields) ? earlier.fields : legacyFields();
    return {
      enabled: booleanValue("enabled", true),
      guideEnabled: booleanValue("guideEnabled", true),
      expertEnabled: booleanValue("expertEnabled", true),
      marketingOptIn: booleanValue("marketingOptIn", true),
      fields: fieldSource.slice(0, 8).map((field, index) => ({
        id: String(field?.id || uid("field")).trim().slice(0, 80),
        label: String(field?.label || `Field ${index + 1}`).trim().slice(0, 40),
        type: leadFieldTypes.includes(field?.type) ? field.type : "text",
        required: Boolean(field?.required),
      })),
    };
  }
  function validateLeadCapture(raw = {}, previous = {}) {
    const lead = normalizeLeadCapture(raw, previous);
    const fields = Array.isArray(raw?.fields) ? raw.fields : lead.fields;
    if (fields.length > 8) return "Use no more than eight lead fields.";
    const ids = new Set(), labels = new Set();
    for (const field of fields) {
      const id = String(field?.id || "").trim();
      const label = String(field?.label || "").trim();
      if (!/^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(id)) return "Each lead field needs a valid ID.";
      if (!label || label.length > 40) return "Lead field labels must be 1–40 characters.";
      if (!leadFieldTypes.includes(field?.type)) return "Choose a valid lead field type.";
      if (ids.has(id) || labels.has(label.toLowerCase())) return "Lead fields need distinct IDs and labels.";
      ids.add(id); labels.add(label.toLowerCase());
    }
    if (lead.enabled && (lead.guideEnabled || lead.expertEnabled) && !fields.some(field => field.type === "email" || field.type === "tel")) {
      return "Add an email or phone field for follow-up requests.";
    }
    return null;
  }
  function normalizeEvent(raw = {}, previous = null) {
    const maxPlayers = numberIn(raw.maxPlayers, 2, 6, previous?.maxPlayers ?? 6);
    const minPlayers = numberIn(raw.minPlayers, 2, maxPlayers, previous?.minPlayers ?? 2);
    const prompts = (Array.isArray(raw.prompts) ? raw.prompts : previous?.prompts || samplePrompts)
      .slice(0, 100).map(normalizePrompt);
    const seen = new Set();
    for (const prompt of prompts) {
      while (seen.has(prompt.id)) prompt.id = uid("prompt");
      seen.add(prompt.id);
    }
    return {
      id: String(raw.id || previous?.id || "demo").slice(0, 80),
      name: String(raw.name || previous?.name || "SIGNAL STADIUM").trim().slice(0, 50),
      minPlayers,
      maxPlayers,
      roundSeconds: numberIn(raw.roundSeconds, 5, 180, previous?.roundSeconds ?? 20),
      joinSeconds: numberIn(raw.joinSeconds, 5, 180, previous?.joinSeconds ?? 30),
      startMode: startModes.includes(raw.startMode) ? raw.startMode : previous?.startMode || "flexible",
      judgePolicy: judgePolicies.includes(raw.judgePolicy) ? raw.judgePolicy : previous?.judgePolicy || "auto-with-override",
      autoAdvance: raw.autoAdvance == null ? previous?.autoAdvance ?? true : Boolean(raw.autoAdvance),
      leadCapture: normalizeLeadCapture(raw.leadCapture, previous?.leadCapture),
      prompts,
      revision: previous?.revision ?? 0,
      updatedAt: previous?.updatedAt ?? null,
    };
  }
  const initialEvent = normalizeEvent({ id: "demo", name: "SIGNAL STADIUM" });
  const initial = { schema: 1, activeEventId: "demo", events: { demo: { ...initialEvent, revision: 1, updatedAt: new Date().toISOString() } } };
  function readEvents() {
    const value = readJSON(EVENTS_KEY, initial);
    if (!value || value.schema !== 1 || !value.events || typeof value.events !== "object") return clone(initial);
    return value;
  }
  function getEvent(id) {
    const store = readEvents();
    const event = store.events[id || store.activeEventId] || store.events[store.activeEventId] || initial.events.demo;
    return clone(normalizeEvent(event, event));
  }
  function listEvents() { return Object.values(readEvents().events).map(event => clone(normalizeEvent(event, event))); }
  function getActiveEventId() { return readEvents().activeEventId; }
  function saveEvent(id, draft, expectedRevision = null) {
    const store = readEvents();
    const current = store.events[id];
    if (!current) return { ok: false, error: "Event not found" };
    if (Array.isArray(draft?.prompts) && draft.prompts.some(prompt => !String(prompt?.text || "").trim() || String(prompt.text).trim().length > 55)) {
      return { ok: false, error: "Each prompt needs 1–55 characters for the arena wall." };
    }
    const leadError = validateLeadCapture(draft?.leadCapture || current.leadCapture, current.leadCapture);
    if (leadError) return { ok: false, error: leadError };
    if (expectedRevision !== null && current.revision !== expectedRevision) {
      return { ok: false, error: "This event changed in another tab. Reload before saving." };
    }
    const next = normalizeEvent({ ...current, ...draft, id }, current);
    next.revision = current.revision + 1;
    next.updatedAt = new Date().toISOString();
    store.events[id] = next;
    const result = writeJSON(EVENTS_KEY, store);
    return result.ok ? { ok: true, event: clone(next) } : result;
  }
  function createEvent(name) {
    const store = readEvents();
    const id = uid("event");
    const event = normalizeEvent({ id, name: name || "NEW EVENT" });
    event.revision = 1;
    event.updatedAt = new Date().toISOString();
    store.events[id] = event;
    store.activeEventId = id;
    const result = writeJSON(EVENTS_KEY, store);
    return result.ok ? { ok: true, event: clone(event) } : result;
  }
  function setActiveEvent(id) {
    const store = readEvents();
    if (!store.events[id]) return { ok: false, error: "Event not found" };
    store.activeEventId = id;
    const result = writeJSON(EVENTS_KEY, store);
    return result.ok ? { ok: true, event: clone(store.events[id]) } : result;
  }
  function getState(eventId) {
    const states = readJSON(STATE_KEY, {});
    return clone(states[eventId || getActiveEventId()] || { phase: "lobby", readyCount: 0, heat: 1, winners: [], promptId: null, updatedAt: null });
  }
  function setState(eventId, patch) {
    const states = readJSON(STATE_KEY, {});
    states[eventId] = { ...getState(eventId), ...patch, updatedAt: new Date().toISOString() };
    return writeJSON(STATE_KEY, states);
  }
  function sendCommand(eventId, type, payload = {}) {
    const command = { id: uid("command"), eventId, type, payload, sentAt: new Date().toISOString() };
    const result = writeJSON(COMMAND_KEY, command);
    return result.ok ? { ok: true, command } : result;
  }
  function getCommand() { return readJSON(COMMAND_KEY, null); }
  function subscribe(listener) {
    const onStorage = (event) => { if ([EVENTS_KEY, COMMAND_KEY, STATE_KEY].includes(event.key)) listener(event.key); };
    const onLocal = (event) => listener(event.detail.key);
    window.addEventListener("storage", onStorage);
    window.addEventListener(CHANGE_EVENT, onLocal);
    return () => { window.removeEventListener("storage", onStorage); window.removeEventListener(CHANGE_EVENT, onLocal); };
  }
  window.SignalStadiumStore = {
    EVENTS_KEY, COMMAND_KEY, STATE_KEY, startModes, judgePolicies, judgeModes, categories, leadFieldModes, leadFieldTypes, leadFieldPresets,
    getEvent, listEvents, getActiveEventId, saveEvent, createEvent, setActiveEvent,
    getState, setState, sendCommand, getCommand, subscribe, uid,
  };
})();
