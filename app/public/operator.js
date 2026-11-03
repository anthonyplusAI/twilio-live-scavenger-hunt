const $ = (id) => document.getElementById(id);
const clone = (value) => JSON.parse(JSON.stringify(value));
const pathParts = location.pathname.split("/");
const slug = decodeURIComponent(pathParts[2] || "");
const eventPath = "/e/" + encodeURIComponent(slug);
const apiPath = "/api/admin/e/" + encodeURIComponent(slug);
const publicApiPath = "/api/e/" + encodeURIComponent(slug);
const allowedCategories = ["Color", "Object", "Shape", "Text", "Count", "Gesture", "Combination", "Creative"];
const presetFields = [
  { id: "name", label: "Name", type: "text", required: true },
  { id: "email", label: "Work email", type: "email", required: true },
  { id: "company", label: "Company", type: "text", required: false },
  { id: "jobTitle", label: "Job title", type: "text", required: false },
  { id: "phone", label: "Phone number", type: "tel", required: false },
];
const phaseNames = { lobby: "Lobby open", countdown: "Lights up", hunt: "Hunt live", review: "Judge review", result: "Heat awarded" };
const phaseLines = {
  lobby: "Players see the clue only when the hunt begins.",
  countdown: "Roster locked. The clue is still sealed.",
  hunt: "Challenge live on every player phone.",
  review: "Review the proposal or choose a winner.",
  result: "Results are live. Prepare the next heat.",
};
const startNames = { flexible: "Flexible start", capacity: "At capacity", deadline: "Join deadline", manual: "Operator start" };

let session = null;
let csrfToken = "";
let events = [];
let committed = null;
let draft = null;
let runtime = null;
let preflight = [];
let mediaMode = null;
let stream = null;
let clockOffset = 0;
let lastHeat = null;
let selectedWinners = new Set();
let selectedPastHeatId = null;
let selectedPastWinners = new Set();
let pastSelectionDirty = false;
let selectedPromptId = null;
let promptBuffer = null;
let promptDirty = false;
let promptPriorityAuto = false;
let eventDirty = false;
let conflict = false;
let saving = false;
let commandBusy = false;
let managePage = 0;
let pendingKickId = null;
let manageSignature = "";
let promptPage = 0;
let leadFieldPage = 0;
let votePage = 0;
let preflightPage = 0;
let toastTimer = 0;
let operators = [];
let localAdmin = null;
let adminEditorDirty = false;
let adminNeedsReview = false;
let teamPage = 0;
let teamMode = "admin";
let selectedOperatorId = null;
let teamBusy = false;

function isAdmin() { return String(session?.user?.role || "").toLowerCase() === "admin"; }
function asDate(value) {
  if (value == null || value === "") return null;
  const valueMs = typeof value === "number" ? value : /^\d+$/.test(String(value)) ? Number(value) : Date.parse(value);
  return Number.isFinite(valueMs) ? valueMs : null;
}
function serverNow() { return Date.now() + clockOffset; }
function remaining(value) {
  const end = asDate(value);
  return end == null ? null : Math.max(0, Math.ceil((end - serverNow()) / 1000));
}
function flash(message, error = false) {
  const node = $("toast");
  node.textContent = message;
  node.classList.toggle("error", error);
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 3600);
}
function saveStatus(message, kind = "") {
  const node = $("save-state");
  node.textContent = message;
  node.className = "save-state" + (kind ? " " + kind : "");
}
function redirectToLogin() {
  const next = location.pathname + location.search + location.hash;
  location.assign("/login?next=" + encodeURIComponent(next));
}
async function request(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  if (options.body != null && typeof options.body !== "string") {
    headers.set("Content-Type", "application/json");
    options.body = JSON.stringify(options.body);
  }
  const method = String(options.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && csrfToken) headers.set("X-CSRF-Token", csrfToken);
  let response;
  try {
    response = await fetch(url, { ...options, method, headers, credentials: "same-origin" });
  } catch {
    throw new Error("Connection lost. Check the booth network and try again.");
  }
  if (response.status === 401 && url !== "/api/auth/session") {
    redirectToLogin();
    throw new Error("Sign in again to continue.");
  }
  let data = {};
  try { data = await response.json(); } catch { /* error responses may have no body */ }
  if (!response.ok) {
    const error = new Error(data.error || "Request failed (" + response.status + ").");
    error.status = response.status;
    error.code = data.code;
    error.data = data;
    throw error;
  }
  return data;
}
function ensureEventShape(event) {
  const copy = clone(event);
  copy.prompts = Array.isArray(copy.prompts) ? copy.prompts : [];
  copy.leadCapture = copy.leadCapture || {};
  delete copy.leadCapture.marketingOptIn;
  copy.leadCapture.timing = copy.leadCapture.timing || "after-play";
  copy.leadCapture.fields = Array.isArray(copy.leadCapture.fields) ? copy.leadCapture.fields : [];
  copy.cta = copy.cta || { primary: "github" };
  copy.vote = copy.vote || {};
  copy.vote.channels = copy.vote.channels || {};
  copy.vote.categories = Array.isArray(copy.vote.categories) ? copy.vote.categories : ["Color", "Object", "Text", "Creative"];
  return copy;
}
function activePrompt() { return draft?.prompts?.find((item) => item.id === selectedPromptId) || null; }
function selectedPrompt() { return committed?.prompts?.find((item) => item.id === selectedPromptId) || null; }
function markDirty() {
  eventDirty = true;
  if (!conflict) saveStatus("Unsaved changes", "dirty");
}
function setConflict() {
  if (conflict) return;
  conflict = true;
  saveStatus("New revision available", "error");
  $("reload-event-button").hidden = false;
  $("save-event-button").disabled = true;
  flash("This event changed elsewhere. Reload the latest revision before saving.", true);
}
function setServerTime(value) {
  const stamp = asDate(value);
  if (stamp != null) clockOffset = stamp - Date.now();
}
function setCommitted(event) {
  committed = ensureEventShape(event);
  draft = ensureEventShape(event);
  eventDirty = false;
  promptDirty = false;
  conflict = false;
  selectedPromptId = draft.prompts.some((item) => item.id === selectedPromptId) ? selectedPromptId : promptDisplayOrder(draft.prompts)[0]?.id || null;
  promptBuffer = activePrompt() ? clone(activePrompt()) : null;
  promptPriorityAuto = promptBuffer?.priority == null;
  $("reload-event-button").hidden = true;
  $("save-event-button").disabled = !isAdmin();
  saveStatus("Saved · rev " + committed.revision, "saved");
  renderEventForm();
  renderPromptList();
  renderPromptEditor();
  renderQueue();
  renderVoteConfig();
  renderEventPicker();
}
function applyPayload(payload) {
  if (!payload || !payload.event || !payload.state) return;
  setServerTime(payload.serverTime);
  mediaMode = payload.event.mediaMode || payload.event.media?.mode || mediaMode;
  if (!committed) setCommitted(payload.event);
  else if (Number(payload.event.revision) > Number(committed.revision)) {
    if (saving) return;
    if (eventDirty || promptDirty) setConflict();
    else setCommitted(payload.event);
  }
  const next = payload.state;
  if (lastHeat != null && next.heat !== lastHeat) selectedWinners.clear();
  lastHeat = next.heat;
  runtime = next;
  const currentIds = new Set(activeRoster().map((player) => player.id));
  selectedWinners = new Set([...selectedWinners].filter((id) => currentIds.has(id)));
  renderRun();
  renderVotes();
  renderQueue();
}
async function refreshEvent() {
  const payload = await request(apiPath);
  applyPayload(payload);
}
async function refreshEvents() {
  const payload = await request("/api/admin/events");
  events = Array.isArray(payload.events) ? payload.events : [];
  renderEventPicker();
}
async function refreshPreflight() {
  try {
    const payload = await request(apiPath + "/preflight");
    preflight = Array.isArray(payload.checks) ? payload.checks : [];
  } catch (error) {
    preflight = [{ name: "Preflight", status: "error", detail: error.message }];
  }
  renderPreflight();
}
function connectStream() {
  if (stream) stream.close();
  stream = new EventSource(apiPath + "/stream");
  const onState = (event) => {
    try { applyPayload(JSON.parse(event.data)); }
    catch { /* keep the previous valid state */ }
  };
  stream.addEventListener("state", onState);
  stream.onmessage = onState;
  stream.onerror = () => {
    if (!eventDirty && !conflict) saveStatus("Reconnecting…");
  };
  stream.onopen = () => {
    if (!eventDirty && !conflict && committed) saveStatus("Saved · rev " + committed.revision, "saved");
  };
}
function showView(view) {
  if (!["run", "prompts", "event", "votes", "team"].includes(view) || (view === "team" && !isAdmin())) view = "run";
  for (const element of document.querySelectorAll(".view")) element.classList.toggle("active", element.id === "view-" + view);
  for (const button of document.querySelectorAll(".nav[data-view]")) {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  if (view === "team") {
    loadOperators().catch((error) => flash(error.message, true));
    loadLocalAdmin().catch((error) => flash(error.message, true));
  }
  if (location.hash !== "#" + view) history.replaceState(null, "", "#" + view);
}
function showRunPanel(panel) {
  $("view-run").dataset.runPanel = panel === "past" ? "past" : "live";
  if (panel === "past") renderPastResults();
}
function setPromptStep(step) {
  $("prompts-workspace").dataset.step = step;
  for (const button of document.querySelectorAll("[data-prompt-step]")) button.classList.toggle("active", button.dataset.promptStep === step);
}
function setEventStep(step) {
  $("event-form").dataset.step = step;
  const sections = {
    basics: ["Game", "Booth and timing", "Set the event name, roster size, and round clock."],
    rules: ["Rules", "Heat rules", "Choose when a heat starts and how winners are decided."],
    leads: ["Leads", "Lead capture", "Choose when visitors share details and what happens next."],
    systems: ["Systems", "Audience and delivery", "Set voting, messaging, data retention, and readiness."],
  };
  const [kicker, title, description] = sections[step] || sections.basics;
  $("event-section-kicker").textContent = kicker;
  $("event-section-title").textContent = title;
  $("event-section-description").textContent = description;
  for (const button of document.querySelectorAll("[data-event-step]")) {
    const active = button.dataset.eventStep === step;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}
function setGameStep(step) {
  $("game-pane").dataset.gameStep = step;
  for (const button of document.querySelectorAll("[data-game-step]")) {
    const active = button.dataset.gameStep === step;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}
function setLeadStep(step) {
  $("lead-pane").dataset.leadStep = step;
  for (const button of document.querySelectorAll("[data-lead-step]")) {
    const active = button.dataset.leadStep === step;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}
function setSystemStep(step) {
  $("systems-pane").dataset.systemStep = step;
  for (const button of document.querySelectorAll("[data-system-step]")) {
    const active = button.dataset.systemStep === step;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}
function renderRole() {
  $("event-role").textContent = isAdmin() ? "Admin" : "Operator";
  $("new-event-button").disabled = !isAdmin();
  $("save-event-button").disabled = !isAdmin() || conflict;
  $("event-save-note").textContent = isAdmin() ? "Saved settings stay with this event." : "Viewing settings · admin access required to edit.";
  for (const input of $("event-form").querySelectorAll("input, select")) input.disabled = !isAdmin();
  for (const input of $("prompt-form").querySelectorAll("input, select")) input.disabled = !isAdmin();
  $("add-prompt-button").disabled = !isAdmin();
  $("save-prompt-button").disabled = !isAdmin();
  const metrics = document.querySelector(".metrics-link");
  metrics.hidden = !isAdmin();
  document.querySelector(".team-nav").hidden = !isAdmin();
}
function operatorLabel(operator) { return String(operator?.email || operator?.username || "Operator"); }
function isGoogleOperator(operator) { return String(operator?.authProvider || "password").toLowerCase() === "google"; }
function teamPageSize() { return window.innerWidth <= 760 ? 4 : 5; }
function updateAdminSaveState() {
  const username = $("team-admin-username").value.trim().toLowerCase();
  const changed = Boolean(localAdmin) && (username !== localAdmin.username || $("team-admin-password").value.length > 0);
  $("team-admin-submit").disabled = teamBusy || adminNeedsReview || !changed;
}
function renderAdminAccount() {
  const username = String(localAdmin?.username || "");
  $("team-admin-card-username").textContent = username || "Account unavailable";
  $("team-admin-current").textContent = username || "Account unavailable";
  $("team-admin-initial").textContent = username.slice(0, 1).toUpperCase() || "A";
  $("team-admin-button").setAttribute("aria-pressed", String(teamMode === "admin"));
  if (!adminEditorDirty) $("team-admin-username").value = username;
  for (const id of ["team-admin-username", "team-admin-password", "team-admin-confirm"]) $(id).disabled = !localAdmin;
  updateAdminSaveState();
}
function renderTeam() {
  renderAdminAccount();
  const list = $("team-list");
  const size = teamPageSize();
  const pages = Math.max(1, Math.ceil(operators.length / size));
  teamPage = Math.max(0, Math.min(teamPage, pages - 1));
  $("team-count").textContent = String(operators.length);
  list.replaceChildren();
  if (!operators.length) {
    const empty = document.createElement("div");
    empty.className = "team-empty";
    const title = document.createElement("strong");
    title.textContent = "No operator accounts yet";
    const note = document.createElement("small");
    note.textContent = "Add a booth operator to give someone a local account.";
    empty.append(title, note);
    list.append(empty);
  }
  for (const operator of operators.slice(teamPage * size, (teamPage + 1) * size)) {
    const label = operatorLabel(operator);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "team-row";
    row.dataset.operatorId = String(operator.id);
    const selected = ["manage", "rename-operator"].includes(teamMode) && String(selectedOperatorId) === String(operator.id);
    row.setAttribute("aria-pressed", String(selected));
    const avatar = document.createElement("span");
    avatar.className = "team-avatar";
    avatar.textContent = label.trim().slice(0, 1).toUpperCase() || "O";
    const identity = document.createElement("span");
    identity.className = "team-identity";
    const name = document.createElement("strong");
    name.textContent = label;
    const detail = document.createElement("small");
    detail.textContent = isGoogleOperator(operator) ? "Google · @twilio.com" : "Username and password";
    identity.append(name, detail);
    const marker = document.createElement("span");
    marker.className = "team-row-arrow";
    marker.setAttribute("aria-hidden", "true");
    marker.textContent = "↗";
    row.append(avatar, identity, marker);
    list.append(row);
  }
  $("team-page-label").textContent = operators.length
    ? "Showing " + (teamPage * size + 1) + "–" + Math.min((teamPage + 1) * size, operators.length) + " of " + operators.length
    : "0 operators";
  $("team-prev").disabled = teamPage === 0;
  $("team-next").disabled = teamPage >= pages - 1;

  const selected = operators.find((item) => String(item.id) === String(selectedOperatorId));
  if (["manage", "rename-operator"].includes(teamMode) && !selected) teamMode = "admin";
  if (teamMode === "rename-operator" && isGoogleOperator(selected)) teamMode = "manage";
  const managing = ["manage", "rename-operator"].includes(teamMode);
  const google = managing && isGoogleOperator(selected);
  $("team-admin-button").setAttribute("aria-pressed", String(teamMode === "admin"));
  $("team-admin-form").hidden = teamMode !== "admin";
  $("team-create-form").hidden = teamMode !== "create";
  $("team-reset-form").hidden = teamMode !== "manage" || google;
  $("team-operator-username-form").hidden = teamMode !== "rename-operator" || google;
  $("team-google-detail").hidden = teamMode !== "manage" || !google;
  if (managing) {
    const label = operatorLabel(selected);
    $("team-detail-kicker").textContent = google ? "Google account" : "Local account";
    $("team-detail-title").textContent = google ? "Twilio teammate" : teamMode === "rename-operator" ? "Change username" : "Manage operator";
    $("team-detail-copy").textContent = google ? "Signed in with a verified @twilio.com identity." : teamMode === "rename-operator" ? "Update their login name. Their password stays the same." : "Change their username, reset their password, or remove access.";
    if (google) $("team-google-name").textContent = label;
    else {
      $("team-selected-name").textContent = label;
      $("team-selected-initial").textContent = label.trim().slice(0, 1).toUpperCase() || "O";
      $("team-rename-current").textContent = label;
      $("team-rename-initial").textContent = label.trim().slice(0, 1).toUpperCase() || "O";
    }
  } else if (teamMode === "admin") {
    $("team-detail-kicker").textContent = "Primary local account";
    $("team-detail-title").textContent = "Admin login";
    $("team-detail-copy").textContent = "Update the existing admin username or password.";
  } else {
    $("team-detail-kicker").textContent = "New account";
    $("team-detail-title").textContent = "Add an operator";
    $("team-detail-copy").textContent = "Create a username and password for booth staff.";
  }
}
function showTeamMode(mode, operatorId = null) {
  if (mode === "rename-operator") {
    const selected = operators.find((item) => String(item.id) === String(operatorId));
    if (!selected || isGoogleOperator(selected)) return;
    $("team-operator-username").value = selected.username || "";
  }
  teamMode = mode;
  selectedOperatorId = operatorId;
  $("team-workspace").dataset.step = "detail";
  renderTeam();
  const focusId = mode === "admin" ? "team-admin-username" : mode === "rename-operator" ? "team-operator-username" : mode === "create" ? "team-create-username" : "team-detail-title";
  $(focusId).focus();
  if (["admin", "rename-operator"].includes(mode)) $(focusId).select();
}
async function loadOperators() {
  if (!isAdmin()) return;
  const payload = await request("/api/admin/operators");
  operators = Array.isArray(payload.operators) ? payload.operators.filter((item) => String(item.role || "operator").toLowerCase() === "operator") : [];
  renderTeam();
}
async function loadLocalAdmin() {
  if (!isAdmin()) return;
  const payload = await request("/api/admin/local-admin");
  localAdmin = payload.admin || null;
  renderTeam();
}
async function loadAuthProviders() {
  try {
    const payload = await request("/api/auth/providers");
    const enabled = Boolean(payload.google?.enabled);
    $("team-google-status").classList.toggle("enabled", enabled);
    $("team-google-status-copy").textContent = enabled
      ? "Verified @twilio.com accounts have admin access. Google manages their passwords."
      : "Configure a Google OAuth client to enable it.";
  } catch {
    $("team-google-status-copy").textContent = "Google sign-in status is unavailable.";
  }
}
function renderEventPicker() {
  const select = $("event-select");
  select.replaceChildren();
  for (const item of events) {
    const option = document.createElement("option");
    option.value = item.slug;
    option.textContent = item.name;
    select.append(option);
  }
  select.value = slug;
  if (!select.value && committed) {
    const option = document.createElement("option");
    option.value = slug;
    option.textContent = committed.name;
    select.append(option);
    select.value = slug;
  }
  if (!committed) return;
  $("top-event-name").textContent = committed.name;
  $("top-event-revision").textContent = "Revision " + committed.revision;
  document.querySelector(".wall-link").href = eventPath + "/arena";
  const metrics = document.querySelector(".metrics-link");
  metrics.href = eventPath + "/metrics";
  const mode = committed.media?.mode || committed.mediaMode || mediaMode;
  $("media-mode").classList.toggle("warn", mode !== "twilio");
  $("media-mode").textContent = mode === "twilio" ? "Twilio Video ready" : mode === "rehearsal" ? "Rehearsal · Twilio pending" : mode ? "Twilio Video unconfigured" : "Checking media";
}

function renderEventForm() {
  if (!draft) return;
  $("event-name").value = draft.name || "";
  $("event-venue").value = draft.venue || "";
  $("event-timezone").value = draft.timeZone || "UTC";
  $("event-min").value = draft.minPlayers ?? 2;
  $("event-max").value = draft.maxPlayers ?? 6;
  $("event-round").value = draft.roundSeconds ?? 45;
  $("event-join").value = draft.joinSeconds ?? 30;
  $("event-result").value = draft.resultSeconds ?? 8;
  $("event-tie").value = draft.tieWindowMs ?? 300;
  $("event-retention").value = draft.retentionDays ?? 90;
  const startRadio = document.querySelector('input[name="start-mode"][value="' + (draft.startMode || "flexible") + '"]');
  if (startRadio) startRadio.checked = true;
  $("event-judge").value = draft.judgePolicy || "manual";
  $("event-auto").checked = Boolean(draft.autoAdvance);
  const lead = draft.leadCapture;
  $("lead-enabled").checked = Boolean(lead.enabled);
  $("lead-timing").value = lead.timing || "after-play";
  $("primary-cta").value = draft.cta?.primary || "github";
  $("lead-guide").checked = Boolean(lead.guideEnabled);
  $("lead-expert").checked = Boolean(lead.expertEnabled);
  renderLeadFields();
  updateLeadControls();
  renderVoteConfig();
  renderRole();
}
function renderVoteConfig() {
  if (!draft) return;
  const vote = draft.vote;
  $("vote-enabled").checked = Boolean(vote.enabled);
  $("vote-seconds").value = vote.windowSeconds ?? 20;
  $("vote-creative-seconds").value = vote.creativeWindowSeconds ?? 20;
  $("vote-web").checked = vote.channels.web !== false;
  $("vote-sms").checked = Boolean(vote.channels.sms);
  $("vote-whatsapp").checked = Boolean(vote.channels.whatsapp);
  $("vote-categories").value = vote.categories.join(", ");
  $("vote-sms-sender").value = vote.smsSender || "";
  $("vote-whatsapp-sender").value = vote.whatsappSender || "";
  $("vote-event-code").value = vote.eventCode || "";
  updateMessagingPreview();
}
function updateMessagingPreview() {
  const code = $("vote-event-code").value.trim().toUpperCase() || slug.replace(/-/g, "").slice(0, 20).toUpperCase();
  $("effective-event-code").textContent = code || "EVENTCODE";
}
function updateLeadControls() {
  const enabled = $("lead-enabled").checked;
  const timing = $("lead-timing").value;
  const primary = $("primary-cta");
  for (const option of primary.options) {
    if (option.value === "guide") option.disabled = !enabled || !$("lead-guide").checked;
    if (option.value === "expert") option.disabled = !enabled || !$("lead-expert").checked;
  }
  if (primary.selectedOptions[0]?.disabled) { primary.value = "github"; markDirty(); }
  $("lead-timing").disabled = !enabled;
  $("lead-pane").classList.toggle("is-off", !enabled);
  $("lead-visibility").textContent = enabled ? timing === "join" ? "Join form on" : "After-play form on" : "Lead form off";
}
function leadFieldPageSize() { return innerWidth <= 360 && innerHeight <= 600 ? 2 : 3; }
function renderLeadFields() {
  if (!draft) return;
  const fields = draft.leadCapture.fields;
  const size = leadFieldPageSize();
  const pages = Math.max(1, Math.ceil(fields.length / size));
  leadFieldPage = Math.max(0, Math.min(leadFieldPage, pages - 1));
  const required = fields.filter((field) => field.required).length;
  $("lead-fields-count").textContent = String(fields.length);
  $("lead-summary").textContent = fields.length + " field" + (fields.length === 1 ? "" : "s") + " · " + required + " required";
  const list = $("lead-field-list");
  list.replaceChildren();
  if (!fields.length) {
    const empty = document.createElement("div");
    empty.className = "lead-field-empty";
    empty.textContent = "No fields yet. Add an email or phone field for follow-up.";
    list.append(empty);
  }
  fields.slice(leadFieldPage * size, (leadFieldPage + 1) * size).forEach((field, pageIndex) => {
    const index = leadFieldPage * size + pageIndex;
    const row = document.createElement("div");
    row.className = "lead-field-row";
    row.dataset.fieldId = field.id;
    const order = document.createElement("div");
    order.className = "lead-field-order";
    for (const [action, symbol, blocked] of [["up", "↑", index === 0], ["down", "↓", index === fields.length - 1]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = symbol;
      button.dataset.fieldAction = action;
      button.dataset.fieldId = field.id;
      button.setAttribute("aria-label", "Move " + field.label + " " + action);
      button.disabled = blocked || !isAdmin();
      order.append(button);
    }
    const main = document.createElement("div");
    main.className = "lead-field-main";
    const label = document.createElement("input");
    label.className = "input";
    label.type = "text";
    label.maxLength = 40;
    label.value = field.label;
    label.dataset.fieldLabel = field.id;
    label.setAttribute("aria-label", "Label for field " + (index + 1));
    label.disabled = !isAdmin();
    const kind = document.createElement("small");
    kind.textContent = field.type === "email" ? "Email address" : field.type === "tel" ? "Phone number" : "Short answer";
    main.append(label, kind);
    const requirement = document.createElement("label");
    requirement.className = "lead-required";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = Boolean(field.required);
    check.dataset.fieldRequired = field.id;
    check.disabled = !isAdmin();
    const full = document.createElement("span");
    full.className = "full";
    full.textContent = "Required";
    const short = document.createElement("span");
    short.className = "short";
    short.textContent = "Req.";
    requirement.append(check, full, short);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "lead-remove";
    remove.textContent = "×";
    remove.dataset.fieldAction = "remove";
    remove.dataset.fieldId = field.id;
    remove.setAttribute("aria-label", "Remove " + field.label);
    remove.disabled = !isAdmin();
    row.append(order, main, requirement, remove);
    list.append(row);
  });
  $("lead-field-page").textContent = fields.length
    ? (leadFieldPage * size + 1) + "–" + Math.min((leadFieldPage + 1) * size, fields.length) + " of " + fields.length + " fields"
    : "0 fields";
  $("lead-field-prev").disabled = leadFieldPage === 0;
  $("lead-field-next").disabled = leadFieldPage >= pages - 1;
  const preset = $("lead-field-preset");
  for (const option of preset.options) option.disabled = option.value !== "custom" && fields.some((field) => field.id === option.value);
  if (preset.selectedOptions[0]?.disabled) preset.value = [...preset.options].find((option) => !option.disabled)?.value || "custom";
  $("lead-add-field").disabled = !isAdmin() || fields.length >= 8;
}
function addLeadField() {
  if (!isAdmin()) return;
  const fields = draft.leadCapture.fields;
  if (fields.length >= 8) return flash("A player form can have up to eight fields.", true);
  const choice = $("lead-field-preset").value;
  let field;
  if (choice === "custom") {
    const used = new Set(fields.map((item) => item.label.toLowerCase()));
    let number = 1;
    while (used.has(("Short answer " + number).toLowerCase())) number++;
    field = { id: "custom-" + crypto.randomUUID().slice(0, 8), label: "Short answer " + number, type: "text", required: false };
  } else {
    field = presetFields.find((item) => item.id === choice);
    if (!field || fields.some((item) => item.id === field.id)) return flash("That field is already in the form.", true);
    field = clone(field);
  }
  fields.push(field);
  leadFieldPage = Math.floor((fields.length - 1) / leadFieldPageSize());
  markDirty();
  renderLeadFields();
  $("lead-field-list").querySelector('[data-field-label="' + field.id + '"]')?.focus();
}
function onLeadFieldInput(event) {
  const id = event.target.dataset.fieldLabel;
  if (!id) return;
  const field = draft.leadCapture.fields.find((item) => item.id === id);
  if (field) { field.label = event.target.value; markDirty(); }
}
function onLeadFieldChange(event) {
  const id = event.target.dataset.fieldRequired;
  if (!id) return;
  const field = draft.leadCapture.fields.find((item) => item.id === id);
  if (field) { field.required = event.target.checked; markDirty(); renderLeadFields(); }
}
function onLeadFieldClick(event) {
  const button = event.target.closest("button[data-field-action]");
  if (!button || !isAdmin()) return;
  const fields = draft.leadCapture.fields;
  const index = fields.findIndex((item) => item.id === button.dataset.fieldId);
  if (index < 0) return;
  if (button.dataset.fieldAction === "remove") fields.splice(index, 1);
  else {
    const next = index + (button.dataset.fieldAction === "up" ? -1 : 1);
    if (next < 0 || next >= fields.length) return;
    [fields[index], fields[next]] = [fields[next], fields[index]];
    leadFieldPage = Math.floor(next / leadFieldPageSize());
  }
  markDirty();
  renderLeadFields();
}
function syncEventForm() {
  if (!draft) return;
  draft.name = $("event-name").value.trim();
  draft.venue = $("event-venue").value.trim();
  draft.timeZone = $("event-timezone").value.trim();
  draft.minPlayers = Number($("event-min").value);
  draft.maxPlayers = Number($("event-max").value);
  draft.roundSeconds = Number($("event-round").value);
  draft.joinSeconds = Number($("event-join").value);
  draft.resultSeconds = Number($("event-result").value);
  draft.tieWindowMs = Number($("event-tie").value);
  draft.retentionDays = Number($("event-retention").value);
  draft.startMode = document.querySelector('input[name="start-mode"]:checked')?.value || "flexible";
  draft.judgePolicy = $("event-judge").value;
  draft.autoAdvance = $("event-auto").checked;
  draft.leadCapture.enabled = $("lead-enabled").checked;
  draft.leadCapture.timing = $("lead-timing").value;
  draft.leadCapture.guideEnabled = $("lead-guide").checked;
  draft.leadCapture.expertEnabled = $("lead-expert").checked;
  draft.cta = { primary: $("primary-cta").value };
  draft.vote.enabled = $("vote-enabled").checked;
  draft.vote.windowSeconds = Number($("vote-seconds").value);
  draft.vote.creativeWindowSeconds = Number($("vote-creative-seconds").value);
  draft.vote.channels = { ...draft.vote.channels, web: $("vote-web").checked, sms: $("vote-sms").checked, whatsapp: $("vote-whatsapp").checked };
  draft.vote.categories = $("vote-categories").value.split(",").map((item) => item.trim()).filter(Boolean);
  draft.vote.smsSender = $("vote-sms-sender").value.trim();
  draft.vote.whatsappSender = $("vote-whatsapp-sender").value.trim().toLowerCase();
  draft.vote.eventCode = $("vote-event-code").value.trim().toUpperCase();
}
function validateEvent() {
  if (!draft.name || draft.name.length > 50) return "Event name must be 1–50 characters.";
  if (draft.venue.length > 120) return { message: "Venue must be 120 characters or fewer.", step: "basics", substep: "details", field: "event-venue" };
  if (!draft.timeZone || draft.timeZone.length > 80) return { message: "Enter an IANA event time zone, such as America/Los_Angeles.", step: "basics", substep: "details", field: "event-timezone" };
  try { new Intl.DateTimeFormat("en-US", { timeZone: draft.timeZone }); }
  catch { return { message: "Choose a valid IANA time zone.", step: "basics", substep: "details", field: "event-timezone" }; }
  if (!Number.isInteger(draft.minPlayers) || draft.minPlayers < 2 || draft.minPlayers > 6) return "Minimum players must be 2–6.";
  if (!Number.isInteger(draft.maxPlayers) || draft.maxPlayers < draft.minPlayers || draft.maxPlayers > 6) return "Maximum players must be between minimum players and 6.";
  if (!Number.isInteger(draft.roundSeconds) || draft.roundSeconds < 5 || draft.roundSeconds > 180) return "Round length must be 5–180 seconds.";
  if (!Number.isInteger(draft.joinSeconds) || draft.joinSeconds < 5 || draft.joinSeconds > 180) return "Join window must be 5–180 seconds.";
  if (!Number.isInteger(draft.resultSeconds) || draft.resultSeconds < 3 || draft.resultSeconds > 30) return { message: "Result display must be 3–30 seconds.", step: "basics", substep: "timing", field: "event-result" };
  if (!Number.isInteger(draft.tieWindowMs) || draft.tieWindowMs < 0 || draft.tieWindowMs > 1500) return { message: "Tie window must be 0–1,500 milliseconds.", step: "basics", substep: "timing", field: "event-tie" };
  if (!Number.isInteger(draft.retentionDays) || draft.retentionDays < 1 || draft.retentionDays > 365) return { message: "Lead retention must be 1–365 days.", step: "systems", substep: "data", field: "event-retention" };
  if (!Number.isInteger(draft.vote.windowSeconds) || draft.vote.windowSeconds < 5 || draft.vote.windowSeconds > 180) return "Category voting must be 5–180 seconds.";
  if (!Number.isInteger(draft.vote.creativeWindowSeconds) || draft.vote.creativeWindowSeconds < 5 || draft.vote.creativeWindowSeconds > 180) return "Player voting must be 5–180 seconds.";
  if (draft.vote.enabled && !Object.values(draft.vote.channels).some(Boolean)) return "Enable at least one vote channel.";
  if (draft.vote.categories.length > allowedCategories.length || draft.vote.categories.some((item) => !allowedCategories.includes(item))) return "Use categories from the challenge deck.";
  if (new Set(draft.vote.categories).size !== draft.vote.categories.length) return "Each vote category should appear once.";
  if (draft.vote.smsSender && !/^\+?\d{5,20}$/.test(draft.vote.smsSender)) return { message: "SMS sender must be a Twilio number or 5–20 digit short code.", step: "systems", substep: "messaging", field: "vote-sms-sender" };
  if (draft.vote.whatsappSender && !/^whatsapp:\+\d{8,15}$/.test(draft.vote.whatsappSender)) return { message: "WhatsApp sender must look like whatsapp:+15551234567.", step: "systems", substep: "messaging", field: "vote-whatsapp-sender" };
  if (draft.vote.eventCode && !/^[A-Z0-9]{2,20}$/.test(draft.vote.eventCode)) return { message: "Event text code must be 2–20 letters or digits, with no spaces.", step: "systems", substep: "messaging", field: "vote-event-code" };
  if (!draft.prompts.length) return "Add at least one prompt.";
  if (draft.prompts.length > 100) return "The deck can have up to 100 prompts.";
  if (!draft.prompts.some((prompt) => prompt.enabled)) return "Enable at least one prompt.";
  for (const prompt of draft.prompts) {
    if (!prompt.text?.trim() || prompt.text.length > 55) return "Each prompt needs 1–55 characters.";
    if (!allowedCategories.includes(prompt.category)) return "Choose a valid prompt category.";
    if (prompt.seconds != null && (!Number.isInteger(prompt.seconds) || prompt.seconds < 5 || prompt.seconds > 180)) return "Prompt seconds must be 5–180.";
    if (prompt.judgeMode === "rule" && (prompt.category !== "Color" || !colorTargetFromText(prompt.text) || prompt.detector !== `color:${colorTargetFromText(prompt.text)}`))
      return "Fast detector needs a simple color clue, such as SHOW SOMETHING RED.";
  }
  const lead = draft.leadCapture;
  if (!["join", "after-play"].includes(lead.timing)) return "Choose when to ask for visitor details.";
  if (!["github", "guide", "expert"].includes(draft.cta?.primary)) return "Choose a main action.";
  if (draft.cta.primary === "guide" && (!lead.enabled || !lead.guideEnabled)) return "Enable build guide requests to make them the main action.";
  if (draft.cta.primary === "expert" && (!lead.enabled || !lead.expertEnabled)) return "Enable expert requests to make them the main action.";
  if (lead.fields.length > 8) return "The lead form can have up to eight fields.";
  const ids = new Set();
  const labels = new Set();
  for (const field of lead.fields) {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(field.id)) return "Lead fields need valid IDs.";
    const label = String(field.label || "").trim();
    if (!label || label.length > 40) return "Field labels must be 1–40 characters.";
    if (!["text", "email", "tel"].includes(field.type)) return "Choose a valid field type.";
    if (ids.has(field.id) || labels.has(label.toLowerCase())) return "Each field needs a distinct label.";
    ids.add(field.id);
    labels.add(label.toLowerCase());
  }
  if (lead.enabled && !lead.fields.some((field) => ["email", "tel"].includes(field.type))) return "Add an email or phone field for lead capture.";
  if (lead.enabled && lead.guideEnabled && !lead.fields.some((field) => field.type === "email" && field.required)) return "The build guide needs a required email field.";
  if (lead.enabled && lead.expertEnabled && !lead.fields.some((field) => ["email", "tel"].includes(field.type))) return "Add email or phone for expert requests.";
  return null;
}
async function saveEvent(includePrompt = true) {
  if (!isAdmin()) return flash("Admin access is required to change event settings.", true), false;
  if (conflict || saving) return flash("Reload the latest revision before saving.", true), false;
  if (includePrompt && promptDirty && !commitPromptBuffer(true)) return false;
  syncEventForm();
  const error = validateEvent();
  if (error) {
    if (typeof error === "object") {
      setEventStep(error.step);
      if (error.step === "basics") setGameStep(error.substep);
      if (error.step === "systems") setSystemStep(error.substep);
      $(error.field)?.focus();
      flash(error.message, true);
    } else flash(error, true);
    return false;
  }
  saving = true;
  saveStatus("Saving revision…");
  try {
    const payload = await request(apiPath, { method: "PUT", body: { event: draft, expectedRevision: committed.revision } });
    setCommitted(payload.event);
    refreshEvents().catch(() => {});
    flash("Event revision saved.");
    return true;
  } catch (error) {
    if (error.status === 409) setConflict();
    else { saveStatus("Save failed", "error"); flash(error.message, true); }
    return false;
  } finally { saving = false; }
}

function promptPageSize() {
  if (innerWidth <= 360 && innerHeight <= 600) return 5;
  if (innerWidth <= 760) return 3;
  if (innerHeight <= 700) return 4;
  return 5;
}
function promptDisplayOrder(prompts) {
  const standard = [];
  const low = [];
  for (const prompt of prompts) {
    ((prompt.priority || defaultPromptPriority(prompt)) === "low" ? low : standard).push(prompt);
  }
  return [...standard, ...low];
}
function filteredPrompts() {
  const filter = $("prompt-filter").value;
  const matching = filter === "all" ? draft.prompts : draft.prompts.filter((item) => item.category === filter);
  return promptDisplayOrder(matching);
}
function revealPromptPage(id) {
  const index = filteredPrompts().findIndex((prompt) => prompt.id === id);
  if (index >= 0) promptPage = Math.floor(index / promptPageSize());
}
function renderPromptList() {
  if (!draft) return;
  const prompts = filteredPrompts();
  const size = promptPageSize();
  const pages = Math.max(1, Math.ceil(prompts.length / size));
  promptPage = Math.max(0, Math.min(promptPage, pages - 1));
  const list = $("prompt-list");
  list.replaceChildren();
  if (!prompts.length) {
    const empty = document.createElement("div");
    empty.className = "lead-field-empty";
    empty.textContent = "No prompts in this category.";
    list.append(empty);
  }
  prompts.slice(promptPage * size, (promptPage + 1) * size).forEach((prompt, indexOnPage) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "prompt-row" + (prompt.id === selectedPromptId ? " active" : "");
    row.dataset.promptId = prompt.id;
    row.setAttribute("aria-label", "Edit " + prompt.text);
    const index = document.createElement("span");
    index.className = "prompt-index";
    index.textContent = String(promptPage * size + indexOnPage + 1).padStart(2, "0");
    const copy = document.createElement("span");
    copy.className = "prompt-copy";
    const title = document.createElement("strong");
    title.textContent = prompt.text;
    const detail = document.createElement("small");
    detail.textContent = prompt.category + " / " + ((prompt.priority || defaultPromptPriority(prompt)) === "low" ? "Low" : "Standard") + " / " + (prompt.seconds || draft.roundSeconds) + " sec / " + prompt.judgeMode;
    copy.append(title, detail);
    const dot = document.createElement("span");
    dot.className = "prompt-dot" + (prompt.enabled ? " enabled" : "");
    dot.setAttribute("aria-label", prompt.enabled ? "Enabled" : "Disabled");
    row.append(index, copy, dot);
    row.addEventListener("click", () => selectPrompt(prompt.id));
    list.append(row);
  });
  $("prompt-page").textContent = "Page " + (promptPage + 1) + " of " + pages;
  $("prompt-prev").disabled = promptPage === 0;
  $("prompt-next").disabled = promptPage >= pages - 1;
  $("prompt-count").textContent = draft.prompts.filter((item) => item.enabled).length + " active · edits apply next heat";
  $("prompt-filter-count").textContent = prompts.length + " shown";
  $("add-prompt-button").disabled = !isAdmin() || draft.prompts.length >= 100;
}
function colorTargetFromText(value) {
  return String(value || "").trim().match(/^(?:SHOW|FIND) SOMETHING (RED|BLUE|YELLOW|GREEN|ORANGE|PURPLE)[.!]?$/i)?.[1]?.toLowerCase() || null;
}
function defaultPromptPriority(prompt) {
  return prompt?.category === "Color" && /^(?:SHOW|FIND) (?:SOMETHING|ANYTHING|THE COLOR) [A-Z]+[.!]?$/i.test(String(prompt?.text || "").trim())
    ? "low" : "standard";
}
function promptHint(prompt) {
  if (prompt?.judgeMode === "rule") return "Fast detector: SHOW SOMETHING RED. Use AI assisted for named objects.";
  if (prompt?.category === "Text") return "Printed-word ideas: TWILIO, API, WEBHOOK, CODE, SMS, 404.";
  return "New prompts use AI judging. Test each clue on the booth cameras before play.";
}
function renderPromptEditor() {
  const prompt = promptBuffer;
  $("editor-heading").textContent = !prompt ? "Select a prompt" : activePrompt() ? "Edit prompt" : "New prompt";
  $("prompt-text").value = prompt?.text || "";
  $("prompt-length").textContent = $("prompt-text").value.length + " / 55";
  $("prompt-category").value = prompt?.category || "Object";
  $("prompt-judge").value = prompt?.judgeMode || "ai-assisted";
  $("prompt-seconds").value = prompt?.seconds ?? "";
  $("prompt-priority").value = prompt?.priority || defaultPromptPriority(prompt);
  $("prompt-enabled").checked = prompt?.enabled ?? false;
  $("prompt-hint").textContent = promptHint(prompt);
  for (const id of ["prompt-text", "prompt-category", "prompt-judge", "prompt-seconds", "prompt-priority", "prompt-enabled", "save-prompt-button", "discard-prompt-button"]) {
    $(id).disabled = !prompt || !isAdmin();
  }
  $("queue-editor-button").disabled = !prompt || !prompt.enabled;
}
function commitPromptBuffer(revealSelection = false) {
  if (!promptBuffer) return true;
  const text = String(promptBuffer.text || "").trim();
  if (!text || text.length > 55) return flash("A prompt needs 1–55 characters.", true), false;
  if (!allowedCategories.includes(promptBuffer.category)) return flash("Choose a prompt category.", true), false;
  if (!["standard", "low"].includes(promptBuffer.priority || defaultPromptPriority(promptBuffer))) return flash("Choose a rotation priority.", true), false;
  if (promptBuffer.seconds != null && (!Number.isInteger(promptBuffer.seconds) || promptBuffer.seconds < 5 || promptBuffer.seconds > 180)) {
    return flash("Prompt length must be 5–180 seconds.", true), false;
  }
  const original = activePrompt();
  const criteriaChanged = !original || original.text !== text || original.category !== promptBuffer.category || original.judgeMode !== promptBuffer.judgeMode;
  if (promptBuffer.judgeMode === "rule") {
    const color = colorTargetFromText(text);
    if (promptBuffer.category !== "Color" || !color) return flash("Fast detector needs a simple color clue, such as SHOW SOMETHING RED.", true), false;
    promptBuffer.detector = `color:${color}`;
  } else if (criteriaChanged) {
    promptBuffer.detector = promptBuffer.judgeMode === "ai-assisted" ? `visual:${text}` : "manual";
  }
  promptBuffer.text = text;
  promptBuffer.priority ||= defaultPromptPriority(promptBuffer);
  const index = draft.prompts.findIndex((item) => item.id === promptBuffer.id);
  if (index >= 0) draft.prompts[index] = clone(promptBuffer);
  else draft.prompts.push(clone(promptBuffer));
  promptDirty = false;
  promptPriorityAuto = false;
  markDirty();
  if (revealSelection) revealPromptPage(selectedPromptId);
  renderPromptList();
  return true;
}
function selectPrompt(id) {
  if (promptDirty && !commitPromptBuffer()) return;
  selectedPromptId = id;
  revealPromptPage(id);
  promptBuffer = activePrompt() ? clone(activePrompt()) : null;
  promptPriorityAuto = promptBuffer?.priority == null;
  promptDirty = false;
  renderPromptList();
  renderPromptEditor();
  setPromptStep("edit");
}
function addPrompt() {
  if (!isAdmin()) return;
  if (draft.prompts.length >= 100) return flash("The deck can have up to 100 prompts.", true);
  if (promptDirty && !commitPromptBuffer()) return;
  selectedPromptId = "prompt-" + crypto.randomUUID();
  promptBuffer = { id: selectedPromptId, text: "", category: "Object", judgeMode: "ai-assisted", detector: "manual", priority: "standard", enabled: true, seconds: null };
  promptPriorityAuto = true;
  promptDirty = true;
  saveStatus("Unsaved prompt", "dirty");
  renderPromptList();
  renderPromptEditor();
  setPromptStep("edit");
  $("prompt-text").focus();
}
function onPromptInput(event) {
  if (!promptBuffer || !isAdmin()) return;
  promptBuffer.text = $("prompt-text").value;
  promptBuffer.category = $("prompt-category").value;
  promptBuffer.judgeMode = $("prompt-judge").value;
  promptBuffer.seconds = $("prompt-seconds").value === "" ? null : Number($("prompt-seconds").value);
  if (event?.target?.id === "prompt-priority") promptPriorityAuto = false;
  if (promptPriorityAuto) $("prompt-priority").value = defaultPromptPriority(promptBuffer);
  promptBuffer.priority = $("prompt-priority").value;
  promptBuffer.enabled = $("prompt-enabled").checked;
  promptDirty = true;
  saveStatus("Unsaved prompt", "dirty");
  $("prompt-length").textContent = promptBuffer.text.length + " / 55";
  $("prompt-hint").textContent = promptHint(promptBuffer);
}
function discardPromptBuffer() {
  if (!activePrompt()) selectedPromptId = promptDisplayOrder(draft.prompts)[0]?.id || null;
  revealPromptPage(selectedPromptId);
  promptBuffer = activePrompt() ? clone(activePrompt()) : null;
  promptPriorityAuto = promptBuffer?.priority == null;
  promptDirty = false;
  renderPromptEditor();
  saveStatus(eventDirty ? "Unsaved changes" : "Saved · rev " + committed.revision, eventDirty ? "dirty" : "saved");
}
function renderQueue() {
  if (!committed) return;
  const select = $("queue-select");
  const prior = select.value;
  select.replaceChildren();
  for (const prompt of promptDisplayOrder(committed.prompts.filter((item) => item.enabled))) {
    const option = document.createElement("option");
    option.value = prompt.id;
    option.textContent = prompt.text;
    select.append(option);
  }
  if ([...select.options].some((item) => item.value === prior)) select.value = prior;
  else if ([...select.options].some((item) => item.value === runtime?.queuedPromptId)) select.value = runtime.queuedPromptId;
  $("queue-button").disabled = !select.options.length || commandBusy || (select.value && select.value === runtime?.queuedPromptId);
  $("queue-button").textContent = select.value && select.value === runtime?.queuedPromptId ? "Queued" : "Queue";
}

function activeRoster() {
  const roster = Array.isArray(runtime?.roster) ? runtime.roster : [];
  return roster.filter((player) => Number(player.slot) >= 1 && Number(player.slot) <= Number(committed?.maxPlayers || 6))
    .sort((a, b) => Number(a.slot) - Number(b.slot));
}
function managedPlayers() {
  const roster = Array.isArray(runtime?.roster) ? runtime.roster : [];
  const queue = Array.isArray(runtime?.queue) ? runtime.queue : [];
  return [
    ...roster.filter(player => player?.id && !["left", "kicked"].includes(player.status))
      .sort((a, b) => Number(a.slot || 99) - Number(b.slot || 99))
      .map(player => ({ ...player, position: `Spot ${String(player.slot).padStart(2, "0")}` })),
    ...queue.filter(player => player?.id)
      .map(player => ({ ...player, status: "queued", position: "Next heat" })),
  ];
}
function managePageSize() { return window.innerHeight < 500 ? 2 : window.innerHeight < 700 ? 4 : 6; }
function renderManagePlayers(force = false) {
  const dialog = $("manage-players-dialog");
  if (!dialog.open && !force) return;
  const people = managedPlayers();
  if (pendingKickId && !people.some(player => player.id === pendingKickId)) pendingKickId = null;
  const pageSize = managePageSize();
  managePage = Math.max(0, Math.min(managePage, Math.max(0, Math.ceil(people.length / pageSize) - 1)));
  const signature = JSON.stringify({ players: people, pendingKickId, managePage, pageSize, commandBusy });
  if (!force && signature === manageSignature) return;
  manageSignature = signature;
  const pending = people.find(player => player.id === pendingKickId);
  $("manage-players-list-view").hidden = !!pending;
  $("manage-players-confirm-view").hidden = !pending;
  if (pending) {
    $("manage-confirm-title").textContent = `Remove ${pending.alias}?`;
    $("manage-confirm-kick").disabled = commandBusy;
    return;
  }
  const list = $("manage-players-list");
  list.replaceChildren();
  for (const player of people.slice(managePage * pageSize, (managePage + 1) * pageSize)) {
    const row = document.createElement("div");
    row.className = "manage-player-row";
    const copy = document.createElement("div");
    copy.className = "manage-player-copy";
    const name = document.createElement("strong");
    name.textContent = player.alias;
    const detail = document.createElement("small");
    detail.textContent = `${player.position} · ${player.status === "queued" ? "In line" : player.mediaConnected ? "Camera live" : player.status === "ready" ? "Ready" : player.status === "finished" ? "Finished" : "Camera connecting"}`;
    copy.append(name, detail);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "manage-remove";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${player.alias} from the game`);
    remove.disabled = commandBusy;
    remove.addEventListener("click", () => { pendingKickId = player.id; renderManagePlayers(true); $("manage-confirm-kick").focus(); });
    row.append(copy, remove);
    list.append(row);
  }
  if (!people.length) {
    const empty = document.createElement("p");
    empty.className = "manage-player-empty";
    empty.textContent = "No players in this heat or queue.";
    list.append(empty);
  }
  $("manage-players-page").textContent = people.length ? `${managePage * pageSize + 1}–${Math.min(people.length, (managePage + 1) * pageSize)} of ${people.length}` : "0 players";
  $("manage-players-prev").disabled = managePage === 0;
  $("manage-players-next").disabled = (managePage + 1) * pageSize >= people.length;
}
function openManagePlayers(playerId = null) {
  const people = managedPlayers();
  if (!people.length) return;
  if (playerId) {
    const index = people.findIndex(player => player.id === playerId);
    if (index >= 0) managePage = Math.floor(index / managePageSize());
  }
  pendingKickId = people.some(player => player.id === playerId) ? playerId : null;
  manageSignature = "";
  const dialog = $("manage-players-dialog");
  if (!dialog.open) dialog.showModal();
  renderManagePlayers(true);
  if (pendingKickId) $("manage-confirm-kick").focus();
}
function renderReady() {
  if (!committed || !runtime) return;
  const players = activeRoster();
  const bySlot = new Map(players.map((item) => [Number(item.slot), item]));
  const track = $("ready-track");
  track.replaceChildren();
  for (let slot = 1; slot <= committed.maxPlayers; slot++) {
    const player = bySlot.get(slot);
    const chip = document.createElement(player ? "button" : "span");
    chip.className = "ready-slot" + (player && ["ready", "locked", "playing", "active", "finished"].includes(player.status) ? " ready" : player ? " queued" : "");
    if (player) {
      chip.type = "button";
      chip.classList.add("manageable");
      chip.addEventListener("click", () => openManagePlayers(player.id));
    }
    const alias = document.createElement("span");
    alias.textContent = player?.alias || String(slot).padStart(2, "0");
    chip.append(alias);
    chip.title = player ? "Manage " + player.alias + " · " + (player.status || "joined") + (player.mediaConnected ? " · camera connected" : "") : "Open slot " + slot;
    chip.setAttribute("aria-label", chip.title);
    track.append(chip);
  }
  track.style.gridTemplateColumns = "repeat(" + committed.maxPlayers + ",minmax(0,1fr))";
  $("ready-count").textContent = runtime.readyCount ?? players.filter((item) => item.status === "ready").length;
  $("ready-max").textContent = committed.maxPlayers;
  $("manage-players-button").disabled = !managedPlayers().length || commandBusy;
  $("manage-players-button").title = runtime.queuedCount ? `${runtime.queuedCount} waiting for the next heat` : "Manage players in this heat";
  $("start-rule").textContent = startNames[committed.startMode] || "Flexible start";
  $("minimum-rule").textContent = "Min " + committed.minPlayers + (runtime.queuedCount ? " · " + runtime.queuedCount + " next" : "");
  $("judge-policy-label").textContent = committed.judgePolicy === "manual" ? "Manual judging" : committed.judgePolicy === "operator-confirm" ? "Confirm to award" : "Override enabled";
  const canStart = runtime.phase === "lobby" && !runtime.paused && Number(runtime.readyCount || 0) >= committed.minPlayers;
  $("start-button").disabled = !canStart || commandBusy;
  $("start-button").textContent = runtime.phase === "lobby" && runtime.paused
    ? "Resume to start"
    : canStart ? "Start heat" : Number(runtime.readyCount || 0) < committed.minPlayers && runtime.phase === "lobby" ? "Need " + committed.minPlayers + " ready" : "Heat in progress";
  $("start-button").title = runtime.phase === "lobby" && runtime.paused ? "Resume the booth before starting this heat." : "";
  $("pause-button").textContent = runtime.paused ? "Resume" : "Pause";
  $("pause-button").disabled = commandBusy;
}
function renderCandidates() {
  if (!runtime || !committed) return;
  const grid = $("candidate-grid");
  const players = activeRoster();
  const currentIds = new Set(players.map(player => player.id));
  for (const id of selectedWinners) if (!currentIds.has(id)) selectedWinners.delete(id);
  const bySlot = new Map(players.map((item) => [Number(item.slot), item]));
  const awarded = new Set(Array.isArray(runtime.winners) ? runtime.winners : []);
  const candidate = runtime.candidate;
  const proposed = new Set(Array.isArray(candidate?.winners) ? candidate.winners : []);
  grid.replaceChildren();
  for (let slot = 1; slot <= committed.maxPlayers; slot++) {
    const player = bySlot.get(slot);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "candidate";
    button.textContent = player ? player.alias : String(slot).padStart(2, "0");
    button.title = player ? "Player " + slot + ": " + player.alias : "Empty slot " + slot;
    button.dataset.playerId = player?.id || "";
    button.disabled = !player || !["hunt", "review", "result"].includes(runtime.phase) || commandBusy;
    button.setAttribute("aria-pressed", String(player ? selectedWinners.has(player.id) : false));
    button.classList.toggle("awarded", player ? awarded.has(player.id) : false);
    button.classList.toggle("proposed", player ? proposed.has(player.id) : false);
    button.addEventListener("click", () => {
      if (!player) return;
      if (selectedWinners.has(player.id)) selectedWinners.delete(player.id);
      else selectedWinners.add(player.id);
      renderCandidates();
    });
    grid.append(button);
  }
  const hasProposal = proposed.size > 0;
  const note = $("candidate-note");
  if (runtime.judgeNotice && ["hunt", "review"].includes(runtime.phase)) {
    note.textContent = `${runtime.judgeNotice.message} Choose a winner, tie, or No valid match.`;
    note.title = note.textContent;
    note.classList.remove("has-proposal");
    note.classList.add("is-warning");
  } else if (hasProposal) {
    const source = String(candidate.source || "Judge").replace(/[-_]/g, " ");
    const confidence = Number(candidate.confidence);
    const machineSource = /rule|ai|vision|model|detector/i.test(source);
    const confidenceText = machineSource && candidate.confidence != null && Number.isFinite(confidence) && confidence >= 0
      ? " · " + Math.round(confidence <= 1 ? confidence * 100 : confidence) + "% confidence"
      : "";
    note.textContent = source + " proposal" + confidenceText + (candidate.explanation ? " · " + candidate.explanation : "");
    note.title = note.textContent;
    note.classList.add("has-proposal");
    note.classList.remove("is-warning");
  } else {
    note.textContent = "Select one player, or several for a tie.";
    note.title = "";
    note.classList.remove("has-proposal");
    note.classList.remove("is-warning");
  }
  const canJudge = ["hunt", "review", "result"].includes(runtime.phase) && !commandBusy;
  $("ai-button").textContent = hasProposal ? "Use proposal" : "Propose selected";
  $("ai-button").disabled = !canJudge || (!hasProposal && (!selectedWinners.size || runtime.phase === "result"));
  $("award-button").disabled = !canJudge || !selectedWinners.size;
  $("clear-award-button").disabled = !canJudge;
  $("next-heat-button").disabled = runtime.phase !== "result" || commandBusy;
  $("reset-button").disabled = commandBusy;
}
function pastHeats() { return Array.isArray(runtime?.recentHeats) ? runtime.recentHeats : []; }
function currentPastHeat() { return pastHeats().find((heat) => heat.id === selectedPastHeatId) || null; }
function pastResultText(heat) {
  const players = new Map((heat?.players || []).map((player) => [player.id, player.alias || "Player"]));
  const winners = Array.isArray(heat?.winners) ? heat.winners : [];
  if (!winners.length) return "No valid match";
  const aliases = winners.map((id) => players.get(id) || "Player").join(" + ");
  return winners.length > 1 ? "Tie: " + aliases : "Winner: " + aliases;
}
function selectPastHeat(id) {
  const heat = pastHeats().find((item) => item.id === id);
  selectedPastHeatId = heat?.id || null;
  selectedPastWinners = new Set(heat?.winners || []);
  pastSelectionDirty = false;
  renderPastResults();
}
function renderPastResults() {
  const heats = pastHeats();
  let heat = heats.find((item) => item.id === selectedPastHeatId);
  if (!heat) {
    heat = heats[0] || null;
    selectedPastHeatId = heat?.id || null;
    selectedPastWinners = new Set(heat?.winners || []);
    pastSelectionDirty = false;
  } else if (!pastSelectionDirty) selectedPastWinners = new Set(heat.winners || []);
  $("past-results-count").textContent = String(heats.length);
  $("past-heat-count").textContent = heats.length ? "Showing the last " + heats.length + " completed heat" + (heats.length === 1 ? "" : "s") : "No completed heats yet";
  const list = $("past-heat-list");
  list.replaceChildren();
  const select = $("past-heat-select");
  select.replaceChildren();
  if (!heats.length) {
    const empty = document.createElement("div");
    empty.className = "past-empty";
    empty.textContent = "Finished heats appear here.";
    list.append(empty);
    const option = document.createElement("option");
    option.textContent = "No completed heats";
    select.append(option);
    select.disabled = true;
  } else {
    select.disabled = false;
    for (const item of heats) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "past-heat-row" + (item.id === selectedPastHeatId ? " active" : "");
      row.setAttribute("aria-pressed", item.id === selectedPastHeatId ? "true" : "false");
      const number = document.createElement("strong");
      number.textContent = String(item.heat).padStart(2, "0");
      const text = document.createElement("span");
      const title = document.createElement("b");
      title.textContent = item.prompt?.text || "Completed heat";
      const result = document.createElement("small");
      result.textContent = pastResultText(item);
      text.append(title, result);
      row.append(number, text);
      row.addEventListener("click", () => selectPastHeat(item.id));
      list.append(row);
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = "Heat " + String(item.heat).padStart(2, "0") + " · " + (item.prompt?.text || "Completed heat");
      select.append(option);
    }
    select.value = selectedPastHeatId;
  }
  $("past-heat-number").textContent = heat ? String(heat.heat).padStart(2, "0") : "--";
  $("past-result-label").textContent = !heat ? "Waiting" : heat.winners?.length > 1 ? "TIE" : heat.winners?.length ? "WINNER" : "NO MATCH";
  $("past-heat-prompt").textContent = heat?.prompt?.text || "No completed heat yet.";
  $("past-current-result").textContent = heat ? "Recorded: " + pastResultText(heat) : "Finished heats appear here for corrections.";
  const grid = $("past-player-grid");
  grid.replaceChildren();
  const players = Array.isArray(heat?.players) ? heat.players : [];
  grid.style.gridTemplateColumns = "repeat(" + Math.min(3, Math.max(2, players.length)) + ",minmax(0,1fr))";
  grid.style.gridTemplateRows = players.length <= 3 ? "1fr" : "repeat(2,minmax(0,1fr))";
  if (!players.length) {
    const empty = document.createElement("div");
    empty.className = "past-empty";
    empty.textContent = heat ? "No players recorded for this heat." : "No result to correct yet.";
    grid.append(empty);
  }
  for (const player of players) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "past-player" + ((heat.winners || []).includes(player.id) ? " current" : "");
    button.dataset.playerId = player.id;
    button.setAttribute("aria-pressed", selectedPastWinners.has(player.id) ? "true" : "false");
    button.setAttribute("aria-label", "Player " + (player.slot || "") + ", " + player.alias + (selectedPastWinners.has(player.id) ? ", selected" : ""));
    const slot = document.createElement("small");
    slot.textContent = String(player.slot || "").padStart(2, "0");
    const alias = document.createElement("strong");
    alias.textContent = player.alias || "Player";
    button.append(slot, alias);
    button.addEventListener("click", () => {
      if (selectedPastWinners.has(player.id)) selectedPastWinners.delete(player.id);
      else selectedPastWinners.add(player.id);
      pastSelectionDirty = true;
      renderPastResults();
      [...$("past-player-grid").querySelectorAll("button")].find((item) => item.dataset.playerId === player.id)?.focus();
    });
    grid.append(button);
  }
  const recorded = new Set(heat?.winners || []);
  const sameResult = recorded.size === selectedPastWinners.size && [...recorded].every((id) => selectedPastWinners.has(id));
  $("past-award-button").disabled = !heat || !players.length || !selectedPastWinners.size || sameResult || commandBusy;
  $("past-no-match-button").disabled = !heat || !players.length || !recorded.size || commandBusy;
}
function clockDetails() {
  if (!runtime || !committed) return { seconds: 0, total: 1, label: "Round clock" };
  const phase = runtime.phase || "lobby";
  let seconds = null;
  let total = committed.roundSeconds;
  let label = "Round clock";
  if (phase === "lobby" && runtime.readyDeadline) {
    seconds = remaining(runtime.readyDeadline);
    total = committed.joinSeconds;
    label = "Join window";
  } else if (phase === "lobby" && runtime.paused && runtime.pauseRemaining?.readyDeadline != null) {
    total = committed.joinSeconds;
    label = "Join window";
  } else if (phase === "countdown") {
    seconds = remaining(runtime.countdownEndsAt);
    total = 3;
    label = "Go in";
  } else if (phase === "hunt") {
    seconds = remaining(runtime.roundEndsAt);
    total = runtime.prompt?.seconds || committed.roundSeconds;
    label = "Round clock";
  } else if (phase === "review") {
    seconds = remaining(runtime.reviewEndsAt) ?? 0;
    label = "Judge review";
  } else if (phase === "result") {
    seconds = remaining(runtime.resultEndsAt);
    total = committed.resultSeconds || 8;
    label = "Results";
  }
  if (runtime.paused) {
    const phaseDeadline = { lobby: "readyDeadline", countdown: "countdownEndsAt", hunt: "roundEndsAt", review: "reviewEndsAt", result: "resultEndsAt" }[phase];
    const structuredPause = typeof runtime.pauseRemaining === "object" && runtime.pauseRemaining !== null;
    const serverFrozen = structuredPause
      ? runtime.pauseRemaining[phaseDeadline]
      : runtime.pauseRemaining ?? runtime.remainingSeconds ?? runtime.pauseRemainingSeconds;
    const numeric = Number(serverFrozen);
    if (serverFrozen != null && Number.isFinite(numeric)) seconds = (structuredPause || numeric > 180) ? numeric / 1000 : numeric;
    else if (phase === "lobby") seconds = null;
    label = "Paused";
  }
  const waitingForMinimum = runtime.paused && phase === "lobby" && seconds == null;
  return { seconds: waitingForMinimum ? null : Math.max(0, Math.ceil(seconds ?? total)), total: Math.max(1, total), label };
}
function renderClock() {
  if (!runtime || !committed) return;
  const { seconds, total, label } = clockDetails();
  $("stage-time").textContent = seconds == null ? "—" : String(seconds).padStart(2, "0");
  $("dial").style.setProperty("--progress", String(seconds == null ? 0 : Math.max(0, Math.min(1, seconds / total))));
  $("dial").querySelector(".dial-label").textContent = label;
  $("dial").querySelector(".dial-unit").textContent = seconds == null ? "not started" : "seconds";
}
function renderRun() {
  if (!runtime || !committed) return;
  const phase = runtime.phase || "lobby";
  $("heat-number").textContent = String(runtime.heat || 1).padStart(2, "0");
  $("stage-phase").textContent = runtime.paused ? "Paused" : phaseNames[phase] || phase;
  const clueVisible = ["hunt", "review", "result"].includes(phase) && runtime.prompt;
  $("stage-clue-text").textContent = clueVisible ? runtime.prompt.text : "Clue sealed";
  $("stage-subline").textContent = runtime.paused ? "The show is paused for the operator." : phaseLines[phase] || "Ready for the next heat.";
  const live = ["hunt", "review", "result"].includes(phase);
  $("on-air").classList.toggle("quiet", !live);
  $("on-air-label").textContent = live ? "On air" : "Standby";
  $("metric-players").textContent = Array.isArray(runtime.roster) ? runtime.roster.length : 0;
  $("metric-heats").textContent = runtime.heatsStarted || 0;
  $("metric-overrides").textContent = runtime.overrideCount || 0;
  renderClock();
  renderReady();
  renderCandidates();
  renderPastResults();
  renderManagePlayers();
}
async function sendCommand(type, payload = {}, success = "Command sent.") {
  if (commandBusy) return false;
  commandBusy = true;
  renderRun();
  renderVotes();
  try {
    const result = await request(apiPath + "/command", { method: "POST", body: { type, payload } });
    if (result.state) {
      runtime = result.state;
      renderRun();
      renderVotes();
    }
    if (type === "kickPlayer" && result.mediaDisconnect?.status === "failed")
      flash(`${success} Video disconnect could not be confirmed. Check the Twilio room.`, true);
    else flash(success);
    return true;
  } catch (error) {
    flash(error.message, true);
    return false;
  } finally {
    commandBusy = false;
    renderRun();
    renderVotes();
    renderQueue();
  }
}
async function correctPastHeat(winners) {
  const heat = currentPastHeat();
  if (!heat) return flash("Choose a completed heat first.", true);
  const success = await sendCommand("correctHeat", { heatId: heat.id, winners, reason: "operator correction" }, winners.length > 1 ? "Past tie corrected." : winners.length ? "Past winner corrected." : "Past heat set to no match.");
  if (success) {
    pastSelectionDirty = false;
    renderPastResults();
  }
}
function tallyFor(vote, id) {
  const tallies = vote?.tallies;
  if (Array.isArray(tallies)) {
    const entry = tallies.find((item) => item.choice === id || item.id === id);
    return Math.max(0, Number(entry?.count || entry?.votes || 0));
  }
  if (tallies && typeof tallies === "object") return Math.max(0, Number(tallies[id] || 0));
  return 0;
}
function votePageSize() { return innerWidth <= 360 && innerHeight <= 600 ? 3 : innerWidth <= 760 ? 4 : 5; }
function voteOptionLabel(option) { return typeof option === "string" ? option : option.alias || option.label || option.id || "Option"; }
function voteOptionId(option) { return typeof option === "string" ? option : option.id || option.choice || option.alias; }
function renderVotes() {
  if (!committed || !runtime) return;
  const vote = runtime.vote;
  const open = vote?.status === "open";
  const status = $("vote-window-status");
  status.classList.toggle("open", open);
  status.textContent = !vote ? "No vote open" : vote.type === "creative" ? (open ? runtime.paused ? "Player vote paused" : "Player vote live" : "Player vote closed") : (open ? runtime.paused ? "Category vote paused" : "Category vote live" : "Category vote closed");
  const voteSeconds = runtime.paused && runtime.pauseRemaining?.vote != null
    ? Math.ceil(Number(runtime.pauseRemaining.vote) / 1000)
    : remaining(vote?.closesAt);
  $("vote-countdown").textContent = open ? String(voteSeconds ?? 0).padStart(2, "0") : "--";
  const options = Array.isArray(vote?.options) ? vote.options : [];
  const pageSize = votePageSize();
  const pages = Math.max(1, Math.ceil(options.length / pageSize));
  votePage = Math.max(0, Math.min(votePage, pages - 1));
  const totalVotes = options.reduce((sum, option) => sum + tallyFor(vote, voteOptionId(option)), 0);
  $("vote-tally").replaceChildren();
  if (!options.length) {
    const empty = document.createElement("div");
    empty.className = "vote-tally-empty";
    empty.textContent = "Live vote totals will appear here.";
    $("vote-tally").append(empty);
  }
  options.slice(votePage * pageSize, (votePage + 1) * pageSize).forEach((option) => {
    const id = voteOptionId(option);
    const count = tallyFor(vote, id);
    const percent = totalVotes ? Math.round(count / totalVotes * 100) : 0;
    const row = document.createElement("div");
    row.className = "vote-row";
    const main = document.createElement("div");
    const top = document.createElement("div");
    top.className = "vote-row-top";
    const name = document.createElement("strong");
    name.textContent = voteOptionLabel(option);
    const share = document.createElement("span");
    share.textContent = percent + "%";
    top.append(name, share);
    const bar = document.createElement("div");
    bar.className = "vote-bar";
    const fill = document.createElement("i");
    fill.style.width = percent + "%";
    bar.append(fill);
    main.append(top, bar);
    const number = document.createElement("b");
    number.textContent = String(count);
    row.append(main, number);
    $("vote-tally").append(row);
  });
  $("vote-page-label").textContent = options.length ? totalVotes + " votes · page " + (votePage + 1) + "/" + pages : "Waiting for a vote";
  $("vote-prev").disabled = votePage === 0;
  $("vote-next").disabled = votePage >= pages - 1;
  let resultText = "Live tallies appear here when voting opens.";
  if (vote?.result != null) {
    const result = vote.result;
    resultText = typeof result === "string" ? result : Array.isArray(result)
      ? result.map((id) => voteOptionLabel(options.find((option) => voteOptionId(option) === id) || id)).join(", ")
      : result.label || result.alias || result.choice || JSON.stringify(result);
    resultText = "Result · " + resultText;
  } else if (open) resultText = "Voting closes automatically at the server deadline.";
  $("vote-result").textContent = resultText;
  const config = committed.vote || {};
  const availableCategories = (config.categories || []).filter((category) => committed.prompts.some((prompt) => prompt.enabled && prompt.category === category));
  $("vote-open-category").disabled = !config.enabled || open || commandBusy || runtime.phase !== "lobby" || availableCategories.length < 2;
  $("vote-open-creative").disabled = !config.enabled || open || commandBusy || runtime.phase !== "review" || activeRoster().length < 2;
  $("vote-close").disabled = !open || commandBusy;
  const select = $("vote-category");
  const old = select.value;
  select.replaceChildren();
  for (const category of availableCategories) {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    select.append(option);
  }
  const winningCategory = typeof vote?.result === "string" && availableCategories.includes(vote.result) ? vote.result : null;
  select.value = availableCategories.includes(old) ? old : winningCategory || availableCategories[0] || "";
  $("vote-select-category").disabled = !select.value || commandBusy || runtime.phase !== "lobby";
  const channels = Object.entries(config.channels || {}).filter(([, enabled]) => enabled).map(([name]) => name.toUpperCase());
  $("vote-config-hint").textContent = !config.enabled ? "Audience voting is disabled in Systems." : channels.length ? channels.join(" · ") + " enabled in this event. SMS and WhatsApp require configured senders." : "Choose a vote channel in Systems.";
}
function preflightPageSize() { return innerWidth <= 360 && innerHeight <= 600 ? 2 : innerWidth <= 760 ? 3 : 4; }
function renderPreflight() {
  const size = preflightPageSize();
  const pages = Math.max(1, Math.ceil(preflight.length / size));
  preflightPage = Math.max(0, Math.min(preflightPage, pages - 1));
  const list = $("preflight-list");
  list.replaceChildren();
  if (!preflight.length) {
    const empty = document.createElement("div");
    empty.className = "lead-field-empty";
    empty.textContent = "No checks returned yet.";
    list.append(empty);
  }
  preflight.slice(preflightPage * size, (preflightPage + 1) * size).forEach((check) => {
    const status = String(check.status || "").toLowerCase();
    const tone = ["ok", "ready", "configured", "pass", "healthy"].includes(status) ? "good"
      : ["warning", "warn", "missing", "unconfigured", "rehearsal", "pending"].includes(status) ? "warn" : "bad";
    const row = document.createElement("div");
    row.className = "preflight-row " + tone;
    const dot = document.createElement("i");
    dot.setAttribute("aria-hidden", "true");
    const body = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = check.name || "Check";
    const detail = document.createElement("small");
    detail.textContent = check.detail || check.status || "No detail";
    detail.title = detail.textContent;
    body.append(name, detail);
    row.append(dot, body);
    list.append(row);
  });
  $("preflight-page-label").textContent = preflight.length ? "Checks " + (preflightPage * size + 1) + "–" + Math.min((preflightPage + 1) * size, preflight.length) + " of " + preflight.length : "No checks";
  $("preflight-prev").disabled = preflightPage === 0;
  $("preflight-next").disabled = preflightPage >= pages - 1;
}

function confirmTeamPassword(passwordId, confirmId) {
  const password = $(passwordId);
  const confirmation = $(confirmId);
  const matches = password.value === confirmation.value;
  confirmation.setCustomValidity(matches ? "" : "Passwords do not match.");
  if (!matches) confirmation.reportValidity();
  return matches;
}
function showAdminCollision() {
  $("team-admin-collision").hidden = false;
  $("team-admin-from-create").focus();
}
function editAdminFromCreate() {
  const password = $("team-create-password").value;
  const confirmation = $("team-create-confirm").value;
  $("team-admin-collision").hidden = true;
  showTeamMode("admin");
  $("team-admin-password").value = password;
  $("team-admin-confirm").value = confirmation;
  adminEditorDirty = true;
  adminNeedsReview = false;
  $("team-admin-stale").hidden = true;
  updateAdminSaveState();
  $("team-create-form").reset();
  $("team-admin-password").focus();
}
function resolveAdminStale(useCurrentUsername) {
  if (useCurrentUsername) $("team-admin-username").value = localAdmin?.username || "";
  adminNeedsReview = false;
  $("team-admin-stale").hidden = true;
  updateAdminSaveState();
  $("team-admin-username").focus();
}
async function saveAdminLogin(event) {
  event.preventDefault();
  if (teamBusy || !localAdmin) return;
  const username = $("team-admin-username").value.trim().toLowerCase();
  const password = $("team-admin-password").value;
  const confirmation = $("team-admin-confirm").value;
  if (!password && confirmation) {
    $("team-admin-password").setCustomValidity("Enter a new password first.");
    $("team-admin-password").reportValidity();
    return;
  }
  if (password && !confirmTeamPassword("team-admin-password", "team-admin-confirm")) return;
  if (username === localAdmin.username && !password) return flash("Enter a new username or password to save.", true);
  const body = { username, expectedUsername: localAdmin.username };
  if (password) body.password = password;
  teamBusy = true;
  updateAdminSaveState();
  try {
    const result = await request("/api/admin/local-admin", { method: "POST", body });
    localAdmin = result.admin || { ...localAdmin, username };
    adminEditorDirty = false;
    adminNeedsReview = false;
    $("team-admin-stale").hidden = true;
    $("team-admin-form").reset();
    renderTeam();
    if (result.signedOut) {
      const next = location.pathname + location.search + "#team";
      const params = new URLSearchParams({ notice: "admin-credentials-changed", username: localAdmin.username, next });
      location.assign("/login?" + params);
      return;
    }
    flash(result.passwordChanged ? "Admin login and password saved." : "Admin username saved.");
  } catch (error) {
    if (error.code === "admin_changed") {
      try {
        await loadLocalAdmin();
        adminNeedsReview = true;
        $("team-admin-stale-current").textContent = localAdmin?.username || "unavailable";
        $("team-admin-stale").hidden = false;
        flash("Admin login changed on another screen. Review your draft before saving.", true);
      } catch { flash("Admin login changed. Reload Team and review the latest account before saving.", true); }
    } else flash(error.message, true);
  }
  finally { teamBusy = false; updateAdminSaveState(); }
}
async function createOperator(event) {
  event.preventDefault();
  if (teamBusy || !confirmTeamPassword("team-create-password", "team-create-confirm")) return;
  const username = $("team-create-username").value.trim().toLowerCase();
  const password = $("team-create-password").value;
  if (username === localAdmin?.username) return showAdminCollision();
  teamBusy = true;
  $("team-create-submit").disabled = true;
  try {
    const result = await request("/api/admin/operators", { method: "POST", body: { username, password } });
    $("team-create-form").reset();
    $("team-admin-collision").hidden = true;
    await loadOperators();
    const id = result.operator?.id || operators.find((item) => item.username === username)?.id;
    if (id != null) {
      const index = operators.findIndex((item) => String(item.id) === String(id));
      teamPage = Math.max(0, Math.floor(index / teamPageSize()));
      showTeamMode("manage", id);
    }
    flash("Operator account created.");
  } catch (error) {
    if (error.code === "username_exists" && !localAdmin) {
      try { await loadLocalAdmin(); } catch { /* preserve the original error */ }
    }
    if (error.code === "username_exists" && username === localAdmin?.username) showAdminCollision();
    else flash(error.message, true);
  }
  finally { teamBusy = false; $("team-create-submit").disabled = false; }
}
async function resetOperatorPassword(event) {
  event.preventDefault();
  const selected = operators.find((item) => String(item.id) === String(selectedOperatorId));
  if (teamBusy || !selected || isGoogleOperator(selected) || !confirmTeamPassword("team-reset-password", "team-reset-confirm")) return;
  teamBusy = true;
  $("team-reset-submit").disabled = true;
  try {
    await request("/api/admin/operators/" + encodeURIComponent(selected.id) + "/password", { method: "POST", body: { password: $("team-reset-password").value } });
    $("team-reset-form").reset();
    flash("Password changed. The operator must sign in again.");
  } catch (error) { flash(error.message, true); }
  finally { teamBusy = false; $("team-reset-submit").disabled = false; }
}
async function removeOperator() {
  const selected = operators.find((item) => String(item.id) === String(selectedOperatorId));
  if (teamBusy || !selected || isGoogleOperator(selected)) return;
  if (!confirm("Remove " + operatorLabel(selected) + " from the booth team? Their active sessions will end.")) return;
  teamBusy = true;
  $("team-remove-button").disabled = true;
  try {
    await request("/api/admin/operators/" + encodeURIComponent(selected.id), { method: "DELETE" });
    teamMode = "admin";
    selectedOperatorId = null;
    $("team-workspace").dataset.step = "list";
    await loadOperators();
    flash("Operator access removed.");
  } catch (error) { flash(error.message, true); }
  finally { teamBusy = false; $("team-remove-button").disabled = false; }
}
async function changeOperatorUsername(event) {
  event.preventDefault();
  const selected = operators.find((item) => String(item.id) === String(selectedOperatorId));
  if (teamBusy || !selected || isGoogleOperator(selected)) return;
  const username = $("team-operator-username").value.trim().toLowerCase();
  if (username === selected.username) return flash("Choose a different username.", true);
  teamBusy = true;
  $("team-operator-username-submit").disabled = true;
  try {
    await request("/api/admin/operators/" + encodeURIComponent(selected.id) + "/username", { method: "POST", body: { username } });
    $("team-operator-username-form").reset();
    await loadOperators();
    showTeamMode("manage", selected.id);
    flash("Username changed. The operator must sign in again with their new name.");
  } catch (error) { flash(error.message, true); }
  finally { teamBusy = false; $("team-operator-username-submit").disabled = false; }
}

function wireControls() {
  for (const button of document.querySelectorAll(".nav[data-view]")) button.addEventListener("click", () => { showView(button.dataset.view); if (button.dataset.view === "run") showRunPanel("live"); });
  $("team-admin-button").addEventListener("click", () => showTeamMode("admin"));
  $("team-add-button").addEventListener("click", () => showTeamMode("create"));
  $("team-admin-from-create").addEventListener("click", editAdminFromCreate);
  $("team-admin-use-current").addEventListener("click", () => resolveAdminStale(true));
  $("team-admin-keep-draft").addEventListener("click", () => resolveAdminStale(false));
  $("team-edit-username-button").addEventListener("click", () => showTeamMode("rename-operator", selectedOperatorId));
  $("team-rename-back-button").addEventListener("click", () => showTeamMode("manage", selectedOperatorId));
  $("team-back-button").addEventListener("click", () => { $("team-workspace").dataset.step = "list"; $("team-admin-button").focus(); });
  $("team-list").addEventListener("click", (event) => {
    const row = event.target.closest("button[data-operator-id]");
    if (row) showTeamMode("manage", row.dataset.operatorId);
  });
  $("team-prev").addEventListener("click", () => { teamPage--; renderTeam(); });
  $("team-next").addEventListener("click", () => { teamPage++; renderTeam(); });
  $("team-admin-form").addEventListener("submit", saveAdminLogin);
  $("team-admin-form").addEventListener("input", () => { adminEditorDirty = true; updateAdminSaveState(); });
  $("team-create-username").addEventListener("input", () => { $("team-admin-collision").hidden = true; });
  $("team-create-form").addEventListener("submit", createOperator);
  $("team-reset-form").addEventListener("submit", resetOperatorPassword);
  $("team-operator-username-form").addEventListener("submit", changeOperatorUsername);
  $("team-remove-button").addEventListener("click", removeOperator);
  for (const [passwordId, confirmId] of [["team-admin-password", "team-admin-confirm"], ["team-create-password", "team-create-confirm"], ["team-reset-password", "team-reset-confirm"]]) {
    for (const id of [passwordId, confirmId]) $(id).addEventListener("input", () => { $(passwordId).setCustomValidity(""); $(confirmId).setCustomValidity(""); });
  }
  $("past-results-button").addEventListener("click", () => showRunPanel("past"));
  $("past-back-button").addEventListener("click", () => showRunPanel("live"));
  $("past-heat-select").addEventListener("change", (event) => selectPastHeat(event.target.value));
  $("past-award-button").addEventListener("click", () => correctPastHeat([...selectedPastWinners]));
  $("past-no-match-button").addEventListener("click", () => correctPastHeat([]));
  for (const button of document.querySelectorAll("[data-prompt-step]")) button.addEventListener("click", () => setPromptStep(button.dataset.promptStep));
  for (const button of document.querySelectorAll("[data-game-step]")) button.addEventListener("click", () => setGameStep(button.dataset.gameStep));
  for (const button of document.querySelectorAll("[data-event-step]")) button.addEventListener("click", () => {
    setEventStep(button.dataset.eventStep);
    if (button.dataset.eventStep === "systems") refreshPreflight();
  });
  for (const button of document.querySelectorAll("[data-lead-step]")) button.addEventListener("click", () => setLeadStep(button.dataset.leadStep));
  for (const button of document.querySelectorAll("[data-system-step]")) button.addEventListener("click", () => {
    setSystemStep(button.dataset.systemStep);
    if (button.dataset.systemStep === "preflight") refreshPreflight();
  });
  $("preflight-open-messaging").addEventListener("click", () => setSystemStep("messaging"));
  $("lead-edit-fields").addEventListener("click", () => setLeadStep("fields"));
  $("lead-field-prev").addEventListener("click", () => { leadFieldPage--; renderLeadFields(); });
  $("lead-field-next").addEventListener("click", () => { leadFieldPage++; renderLeadFields(); });
  $("lead-add-field").addEventListener("click", addLeadField);
  $("lead-field-list").addEventListener("input", onLeadFieldInput);
  $("lead-field-list").addEventListener("change", onLeadFieldChange);
  $("lead-field-list").addEventListener("click", onLeadFieldClick);
  $("event-form").addEventListener("input", (event) => {
    if (!isAdmin()) return;
    markDirty();
    if (event.target.id === "vote-event-code") updateMessagingPreview();
    if (["lead-enabled", "lead-guide", "lead-expert", "lead-timing", "primary-cta"].includes(event.target.id)) updateLeadControls();
  });
  $("event-form").addEventListener("change", (event) => {
    if (!isAdmin()) return;
    markDirty();
    if (["lead-enabled", "lead-guide", "lead-expert", "lead-timing", "primary-cta"].includes(event.target.id)) updateLeadControls();
  });
  $("event-form").addEventListener("submit", async (event) => { event.preventDefault(); await saveEvent(true); });
  $("reload-event-button").addEventListener("click", async () => {
    if ((eventDirty || promptDirty) && !confirm("Discard unsaved edits and load the latest event revision?")) return;
    try {
      const payload = await request(apiPath);
      setServerTime(payload.serverTime);
      setCommitted(payload.event);
      runtime = payload.state;
      renderRun();
      renderVotes();
      flash("Latest revision loaded.");
    }
    catch (error) { flash(error.message, true); }
  });
  $("event-select").addEventListener("change", (event) => {
    if (event.target.value === slug) return;
    if (eventDirty || promptDirty || conflict) {
      event.target.value = slug;
      flash("Save or discard your edits before switching events.", true);
      return;
    }
    location.assign("/e/" + encodeURIComponent(event.target.value) + "/operator");
  });
  $("new-event-button").addEventListener("click", () => {
    if (!isAdmin()) return;
    if (eventDirty || promptDirty || conflict) return flash("Save or discard your edits before creating another event.", true);
    $("new-event-name").value = "";
    $("new-event-dialog").showModal();
    $("new-event-name").focus();
  });
  $("new-event-cancel").addEventListener("click", () => $("new-event-dialog").close());
  $("new-event-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = $("new-event-name").value.trim();
    if (!name) return;
    try {
      const result = await request("/api/admin/events", { method: "POST", body: { name } });
      $("new-event-dialog").close();
      location.assign("/e/" + encodeURIComponent(result.event.slug) + "/operator");
    } catch (error) { flash(error.message, true); }
  });
  $("prompt-filter").addEventListener("change", () => { promptPage = 0; renderPromptList(); });
  $("prompt-prev").addEventListener("click", () => { promptPage--; renderPromptList(); });
  $("prompt-next").addEventListener("click", () => { promptPage++; renderPromptList(); });
  $("add-prompt-button").addEventListener("click", addPrompt);
  for (const id of ["prompt-text", "prompt-category", "prompt-judge", "prompt-seconds", "prompt-priority", "prompt-enabled"]) $(id).addEventListener("input", onPromptInput);
  $("prompt-form").addEventListener("submit", async (event) => { event.preventDefault(); await saveEvent(true); });
  $("queue-editor-button").addEventListener("click", async () => {
    if (!promptBuffer?.enabled) return flash("Enable this prompt before queueing it.", true);
    if (isAdmin() && (eventDirty || promptDirty) && !await saveEvent(true)) return;
    if (!committed.prompts.some((item) => item.id === selectedPromptId && item.enabled)) return flash("Save this prompt before queueing it.", true);
    await sendCommand("queuePrompt", { promptId: selectedPromptId }, "Prompt queued for the next heat.");
  });
  $("discard-prompt-button").addEventListener("click", discardPromptBuffer);
  $("queue-button").addEventListener("click", () => {
    const promptId = $("queue-select").value;
    if (promptId) sendCommand("queuePrompt", { promptId }, "Prompt queued for the next heat.");
  });
  $("start-button").addEventListener("click", () => sendCommand("start", {}, "Heat starting. The clue stays sealed until GO."));
  $("pause-button").addEventListener("click", () => sendCommand(runtime?.paused ? "resume" : "pause", {}, runtime?.paused ? "Heat resumed." : "Heat paused."));
  $("manage-players-button").addEventListener("click", () => openManagePlayers());
  $("manage-players-close").addEventListener("click", () => $("manage-players-dialog").close());
  $("manage-players-dialog").addEventListener("close", () => { pendingKickId = null; manageSignature = ""; });
  $("manage-cancel-kick").addEventListener("click", () => { pendingKickId = null; renderManagePlayers(true); $("manage-players-close").focus(); });
  $("manage-confirm-kick").addEventListener("click", async () => {
    const player = managedPlayers().find(person => person.id === pendingKickId);
    if (!player || commandBusy) return;
    const removed = await sendCommand("kickPlayer", { playerId: player.id }, `${player.alias} removed from the game.`);
    if (removed) {
      selectedWinners.delete(player.id);
      $("manage-players-dialog").close();
    }
  });
  $("manage-players-prev").addEventListener("click", () => { managePage -= 1; renderManagePlayers(true); });
  $("manage-players-next").addEventListener("click", () => { managePage += 1; renderManagePlayers(true); });
  $("ai-button").addEventListener("click", async () => {
    if (runtime?.candidate?.winners?.length) {
      selectedWinners = new Set(runtime.candidate.winners);
      renderCandidates();
      flash("Proposal selected. Review it, then award.");
    } else if (selectedWinners.size) {
      await sendCommand("proposeWinner", { winners: [...selectedWinners], reason: "operator-proposal" }, "Selection proposed for review.");
    }
  });
  $("award-button").addEventListener("click", () => {
    if (!selectedWinners.size) return;
    sendCommand("award", { winners: [...selectedWinners], reason: selectedWinners.size > 1 ? "operator-tie" : "operator-award" }, selectedWinners.size > 1 ? "Tie awarded." : "Winner awarded.");
  });
  $("clear-award-button").addEventListener("click", () => sendCommand("noMatch", { reason: "operator-no-match" }, "No valid match awarded."));
  $("reset-button").addEventListener("click", () => {
    const people = (runtime?.roster?.length || 0) + (runtime?.queuedCount || 0);
    if ((people || ["countdown", "hunt", "review"].includes(runtime?.phase)) && !confirm("Reset this event and remove connected players from the current heat?")) return;
    sendCommand("reset", {}, "Heat reset.");
  });
  $("next-heat-button").addEventListener("click", () => sendCommand("nextHeat", {}, "Next heat is ready."));
  $("vote-open-category").addEventListener("click", () => sendCommand("openVote", { type: "category" }, "Category vote opened."));
  $("vote-open-creative").addEventListener("click", () => sendCommand("openVote", { type: "creative" }, "Player vote opened."));
  $("vote-close").addEventListener("click", () => sendCommand("closeVote", {}, "Vote closed."));
  $("vote-select-category").addEventListener("click", () => {
    const category = $("vote-category").value;
    if (category) sendCommand("selectCategory", { category }, category + " selected for the next challenge.");
  });
  $("vote-prev").addEventListener("click", () => { votePage--; renderVotes(); });
  $("vote-next").addEventListener("click", () => { votePage++; renderVotes(); });
  $("preflight-refresh").addEventListener("click", refreshPreflight);
  $("preflight-prev").addEventListener("click", () => { preflightPage--; renderPreflight(); });
  $("preflight-next").addEventListener("click", () => { preflightPage++; renderPreflight(); });
  for (const id of ["logout-button", "mobile-logout-button"]) $(id).addEventListener("click", async () => {
    try {
      await request("/api/auth/logout", { method: "POST" });
      redirectToLogin();
    } catch (error) { flash(error.message, true); }
  });
  window.addEventListener("resize", () => { renderPromptList(); renderLeadFields(); renderVotes(); renderPreflight(); renderManagePlayers(); renderTeam(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshEvent().catch(() => {}); });
  window.addEventListener("beforeunload", () => stream?.close());
}
async function boot() {
  wireControls();
  if (!slug) return location.assign("/");
  try {
    session = await request("/api/auth/session");
    if (!session?.user || !session.csrfToken) return redirectToLogin();
    csrfToken = session.csrfToken;
    await refreshEvent();
    await Promise.allSettled([refreshEvents(), refreshPreflight(), loadAuthProviders()]);
    $("vote-qr-image").src = publicApiPath + "/qr.svg?target=vote";
    $("vote-link").href = eventPath + "/vote";
    renderRole();
    connectStream();
    const hash = location.hash.slice(1);
    if (["leads", "systems", "rules", "basics"].includes(hash)) { showView("event"); setEventStep(hash === "leads" ? "leads" : hash); }
    else showView(["run", "prompts", "event", "votes", "team"].includes(hash) ? hash : "run");
    setInterval(() => {
      renderClock();
      if (runtime?.vote?.status === "open" && !runtime.paused) $("vote-countdown").textContent = String(remaining(runtime.vote.closesAt) ?? 0).padStart(2, "0");
    }, 500);
    setInterval(() => refreshEvent().catch(() => { if (!eventDirty && !conflict) saveStatus("Connection interrupted", "error"); }), 15000);
  } catch (error) {
    if (error.status === 401) return redirectToLogin();
    saveStatus("Unable to connect", "error");
    flash(error.message, true);
  }
}
boot();
