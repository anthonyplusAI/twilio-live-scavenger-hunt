const $ = id => document.getElementById(id);
const slugMatch = location.pathname.match(/\/e\/([^/]+)\/vote\/?$/);
const slug = slugMatch ? decodeURIComponent(slugMatch[1]) : "";
const state = {
  event: null, game: null, serverOffset: 0, source: null,
  pending: false, blockedWindowId: null, error: "", renderedWindow: "", expiredWindowId: null,
};
const make = (tag, className = "", value = null) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== null) node.textContent = String(value);
  return node;
};
const isCreative = vote => /creative|winner/i.test(String(vote?.type || ""));
const isOpen = vote => {
  const phase = String(state.game?.phase || "").toLowerCase();
  const correctInterlude = isCreative(vote) ? phase === "review" : phase === "lobby";
  return vote?.status === "open" && correctInterlude && !state.game?.paused && vote.closesAt && toMillis(vote.closesAt) > Date.now() + state.serverOffset;
};
function toMillis(value) {
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function setHeadline(first, accent) {
  const heading = $("vote-title"), span = make("span", "", accent);
  heading.replaceChildren(document.createTextNode(first), span);
}
function normalizeOptions(vote) {
  const raw = Array.isArray(vote?.options) ? vote.options : [];
  return raw.map((option, index) => {
    if (typeof option === "string") return { id: option, label: option, code: "", index };
    if (!option || typeof option !== "object") return null;
    const id = String(option.id ?? option.value ?? option.choice ?? option.key ?? option.label ?? "");
    if (!id) return null;
    return {
      id, label: String(option.label ?? option.name ?? option.alias ?? option.title ?? id),
      code: String(option.code ?? option.keyword ?? ""), index,
    };
  }).filter(Boolean);
}
function tallyMap(vote) {
  const raw = vote?.tallies;
  if (Array.isArray(raw)) return new Map(raw.map(row => [String(row.choice ?? row.id ?? row.value ?? ""), Number(row.count ?? row.votes ?? 0) || 0]));
  if (raw && typeof raw === "object") return new Map(Object.entries(raw).map(([key, value]) => [key, Number(value?.count ?? value) || 0]));
  return new Map();
}
function totalVotes(vote) { return [...tallyMap(vote).values()].reduce((sum, value) => sum + value, 0); }
const votesLabel = count => `${count} ${count === 1 ? "VOTE" : "VOTES"} IN`;
function voteStorageKey(windowId) { return `signal-stadium-vote:${slug}:${windowId}`; }
function savedChoice(windowId) {
  try { return sessionStorage.getItem(voteStorageKey(windowId)); } catch { return null; }
}
function saveChoice(windowId, choice) {
  try { sessionStorage.setItem(voteStorageKey(windowId), choice); } catch { /* Server cookie remains authoritative. */ }
}
function resultLabel(vote, options) {
  const result = vote?.result;
  if (result == null || result === "") return "";
  const values = Array.isArray(result) ? result : [result];
  return values.map(value => {
    const id = typeof value === "object" ? String(value.choice ?? value.id ?? value.value ?? value.winnerId ?? "") : String(value);
    const explicit = typeof value === "object" ? value.label ?? value.choiceLabel ?? value.alias : null;
    return explicit || options.find(option => option.id === id)?.label || id;
  }).filter(Boolean).join(" + ");
}
function updateClock() {
  const vote = state.game?.vote;
  if (!vote || vote.status !== "open") { $("vote-clock").textContent = vote ? "CLOSED" : "—"; $("vote-clock").classList.remove("urgent"); return; }
  if (state.game?.paused || !vote.closesAt) { $("vote-clock").textContent = "PAUSED"; $("vote-clock").classList.remove("urgent"); return; }
  const remaining = Math.max(0, Math.ceil((toMillis(vote.closesAt) - Date.now() - state.serverOffset) / 1000));
  const minutes = Math.floor(remaining / 60), seconds = remaining % 60;
  $("vote-clock").textContent = `${minutes}:${String(seconds).padStart(2, "0")}`;
  $("vote-clock").classList.toggle("urgent", remaining > 0 && remaining <= 10);
  if (remaining === 0 && state.expiredWindowId !== vote.id) { state.expiredWindowId = vote.id; render(); setTimeout(refresh, 600); }
}

function renderChannels(vote, options) {
  const config = state.event?.vote || {}, channels = config.channels || {}, host = $("channel-instructions");
  host.replaceChildren();
  if (!isOpen(vote) || !options.length || !options.every(option => option.code)) { $("channel-strip").hidden = true; return; }
  const eventCode = String(config.eventCode || "").trim();
  host.append(make("span", "channel-prompt", `Text ${eventCode ? `${eventCode} + ` : ""}card code to:`));
  if (channels.sms === true && config.smsSender) host.append(make("span", "", `SMS ${config.smsSender}`));
  if (channels.whatsapp === true && config.whatsappSender) host.append(make("span", "", `WhatsApp ${config.whatsappSender}`));
  if (host.childElementCount === 1) host.replaceChildren();
  $("channel-strip").hidden = !host.childElementCount;
}
function optionFingerprint(vote, options) { return JSON.stringify([vote.id, vote.type, options.map(option => [option.id, option.label, option.code])]); }
function renderOptionState(vote, options) {
  const ownChoice = savedChoice(vote.id), blocked = state.blockedWindowId === vote.id;
  const tallies = tallyMap(vote), showTallies = Boolean(ownChoice || blocked);
  const open = isOpen(vote), webReady = state.event?.vote?.channels?.web !== false;
  for (const button of $("vote-options").querySelectorAll(".vote-option")) {
    const choice = button.dataset.choice, selected = choice === ownChoice;
    button.disabled = !open || !webReady || state.pending || Boolean(ownChoice) || blocked;
    button.classList.toggle("selected", selected);
    button.classList.toggle("dimmed", Boolean(ownChoice) && !selected);
    button.querySelector(".option-check").textContent = selected ? "✓" : "";
    const choiceVotes = tallies.get(choice) || 0;
    button.querySelector(".option-votes").textContent = showTallies ? `${choiceVotes} ${choiceVotes === 1 ? "vote" : "votes"}` : "";
  }
  if (state.error) $("vote-feedback").textContent = state.error;
  else if (state.pending) $("vote-feedback").textContent = "Casting your vote…";
  else if (ownChoice) $("vote-feedback").textContent = "Your vote is in. Watch the arena.";
  else if (blocked) $("vote-feedback").textContent = "This browser already voted in this ballot.";
  else if (!webReady) $("vote-feedback").textContent = "Use a ready messaging channel and the code on a card.";
  else $("vote-feedback").textContent = "One vote per browser, per ballot.";
  $("vote-count").textContent = votesLabel(totalVotes(vote));
}
function renderOptions(vote, options) {
  const fingerprint = optionFingerprint(vote, options), host = $("vote-options");
  if (state.renderedWindow !== fingerprint) {
    state.renderedWindow = fingerprint; host.replaceChildren();
    host.className = `vote-options count-${options.length}`;
    host.style.setProperty("--option-rows", Math.ceil(options.length / 2));
    for (const option of options) {
      const button = make("button", "vote-option"), top = make("span", "option-top"), bottom = make("span", "option-bottom");
      button.type = "button"; button.dataset.choice = option.id;
      button.setAttribute("aria-label", `Vote for ${option.label}`);
      top.append(make("span", "option-symbol", option.code || String(option.index + 1)), make("span", "option-check"));
      bottom.append(make("span", "option-code", option.code ? `CODE ${option.code}` : `CHOICE ${String(option.index + 1).padStart(2, "0")}`), make("span", "option-votes"));
      button.append(top, make("strong", "option-label", option.label), bottom);
      button.addEventListener("click", () => submitVote(option.id));
      host.append(button);
    }
  }
  renderOptionState(vote, options);
}
function renderOpen(vote) {
  const creative = isCreative(vote), options = normalizeOptions(vote);
  setHeadline(creative ? "Pick the " : "Choose the ", creative ? "crowd favorite." : "next category.");
  $("round-label").replaceChildren(make("i"), document.createTextNode(" THE CROWD DECIDES"));
  $("vote-subtitle").textContent = creative
    ? "The clock has stopped. Choose the entry that earned your vote."
    : "Choose a theme. The exact challenge stays secret until GO.";
  $("window-kind").textContent = creative ? "CREATIVE FINAL" : "CATEGORY BALLOT";
  $("vote-options").hidden = false; $("closed-state").hidden = true;
  renderOptions(vote, options); renderChannels(vote, options); updateClock();
}
function renderClosed(vote) {
  const creative = isCreative(vote), options = normalizeOptions(vote), result = resultLabel(vote, options);
  $("vote-options").hidden = true; $("closed-state").hidden = false; $("channel-strip").hidden = true;
  state.renderedWindow = "";
  if (vote) {
    setHeadline("The crowd ", creative ? "has spoken." : "sets the stage.");
    $("vote-subtitle").textContent = creative ? "The operator is confirming the result." : "The next challenge stays secret until GO.";
    $("window-kind").textContent = creative ? "CREATIVE RESULT" : "CATEGORY RESULT";
    $("closed-title").textContent = state.game?.paused ? "Arena paused" : result ? `${creative ? "Audience pick" : "Next category"}: ${result}` : "Voting is closed";
    $("closed-detail").textContent = state.game?.paused ? "Voting resumes when the operator restarts the arena." : result ? "Watch the arena for what happens next." : "The crowd’s choice is being counted.";
    $("vote-count").textContent = votesLabel(totalVotes(vote));
    $("vote-feedback").textContent = savedChoice(vote.id) ? "Your vote was counted." : "This ballot has ended.";
    $("vote-clock").textContent = state.game?.paused ? "PAUSED" : vote.status === "open" ? "0:00" : "CLOSED";
  } else {
    setHeadline("Your call. ", "Their moment.");
    const racing = ["countdown", "hunt", "judging"].includes(String(state.game?.phase || "").toLowerCase());
    $("vote-subtitle").textContent = racing ? "Watch the arena. A new ballot may open between heats." : "The next ballot opens between heats. Keep this page ready.";
    $("window-kind").textContent = racing ? "HUNT LIVE" : "STANDBY";
    $("closed-title").textContent = racing ? "The hunt is live" : "Waiting for the next vote";
    $("closed-detail").textContent = racing ? "The crowd votes again after this heat." : "When the arena pauses, you can help choose what happens next.";
    $("vote-count").textContent = "0 VOTES";
    $("vote-feedback").textContent = "One vote per browser, per ballot.";
    $("vote-clock").textContent = "—";
  }
  $("vote-clock").classList.remove("urgent");
}
function render() {
  if (state.event) {
    $("event-name").textContent = String(state.event.name || "Live Scavenger Hunt").toUpperCase();
    document.title = `${state.event.name || "Live Scavenger Hunt"} / Audience vote`;
  }
  $("play-link").href = slug ? `/e/${encodeURIComponent(slug)}/play` : "#";
  const vote = state.game?.vote;
  if (isOpen(vote) && normalizeOptions(vote).length) renderOpen(vote); else renderClosed(vote);
}

function setConnection(label, mode) {
  const element = $("connection-status");
  element.classList.toggle("online", mode === "online");
  element.classList.toggle("offline", mode === "offline");
  element.replaceChildren(make("i"), document.createTextNode(` ${label}`));
}
let visitRecorded = false;
function recordVisit() {
  if (visitRecorded || !slug) return;
  visitRecorded = true;
  fetch(`/api/e/${encodeURIComponent(slug)}/activity`, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "vote_page_opened" }),
  }).catch(() => {});
}
function applyPayload(payload) {
  if (!payload || typeof payload !== "object") return;
  if (payload.event) state.event = payload.event;
  const priorWindow = state.game?.vote?.id;
  if (payload.state) state.game = payload.state;
  else if (payload.phase) state.game = payload;
  if (state.game?.vote?.id !== priorWindow) state.error = "";
  if (payload.serverTime != null) {
    const serverTime = toMillis(payload.serverTime);
    if (serverTime) state.serverOffset = serverTime - Date.now();
  }
  if (state.game) { recordVisit(); render(); setConnection("ARENA LIVE", "online"); }
}
async function refresh() {
  if (!slug) { $("closed-title").textContent = "Event link missing"; $("closed-detail").textContent = "Scan the QR code at the arena to open this event’s ballot."; setConnection("LINK NEEDED", "offline"); return; }
  try {
    const response = await fetch(`/api/e/${encodeURIComponent(slug)}`, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(response.status === 404 ? "Event not found" : `Connection failed (${response.status})`);
    applyPayload(await response.json());
  } catch (error) {
    setConnection("RECONNECTING", "offline");
    if (!state.game) {
      $("closed-title").textContent = "Arena connection lost";
      $("closed-detail").textContent = error.message || "Trying to reconnect…";
    }
  }
}
function connectStream() {
  if (!slug || !window.EventSource) return;
  const source = new EventSource(`/api/e/${encodeURIComponent(slug)}/stream`);
  state.source = source;
  source.addEventListener("state", event => {
    try { applyPayload(JSON.parse(event.data)); } catch { /* A later state event will recover. */ }
  });
  source.onopen = () => setConnection("ARENA LIVE", "online");
  source.onerror = () => setConnection("RECONNECTING", "offline");
}
async function submitVote(choice) {
  const vote = state.game?.vote;
  if (!vote || !isOpen(vote) || state.event?.vote?.channels?.web === false || state.pending || state.blockedWindowId === vote.id || savedChoice(vote.id)) return;
  state.pending = true; state.error = ""; renderOptionState(vote, normalizeOptions(vote));
  try {
    const response = await fetch(`/api/e/${encodeURIComponent(slug)}/votes`, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ windowId: vote.id, choice }),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 409) {
      const closed = /clos|expir|window/i.test(String(payload.code || payload.error || ""));
      if (closed) {
        state.error = "This ballot just closed.";
        if (state.game?.vote?.id === vote.id) state.game.vote.status = "closed";
      } else state.blockedWindowId = vote.id;
      refresh();
    } else if (!response.ok) throw new Error(payload.error || `Vote could not be sent (${response.status})`);
    else {
      saveChoice(vote.id, choice);
      if (payload.vote && state.game?.vote?.id === vote.id) state.game.vote = { ...state.game.vote, ...payload.vote };
    }
  } catch (error) { state.error = error.message || "Connection lost. Tap again to retry."; }
  finally { state.pending = false; render(); }
}

setInterval(updateClock, 250);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
window.addEventListener("pagehide", () => state.source?.close());
refresh();
connectStream();
