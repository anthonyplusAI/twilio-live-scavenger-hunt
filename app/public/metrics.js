const $ = id => document.getElementById(id);
const number = value => new Intl.NumberFormat().format(Number(value) || 0);
const percent = value => `${Math.max(0, Math.min(100, Math.round(value || 0)))}%`;
const safeObject = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const isoDay = date => date.toISOString().slice(0, 10);
const dayFormatters = new Map();
function reportTimeZone() { return state.event === "all" ? "UTC" : state.events.find(event => event.slug === state.event)?.timeZone || "UTC"; }
function dayInZone(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  if (timeZone === "UTC") return isoDay(date);
  try {
    if (!dayFormatters.has(timeZone)) dayFormatters.set(timeZone, new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }));
    const parts = Object.fromEntries(dayFormatters.get(timeZone).formatToParts(date).filter(part => ["year", "month", "day"].includes(part.type)).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch { return isoDay(date); }
}
const shortDate = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) : "—";
};
const make = (tag, className = "", value = null) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== null) node.textContent = String(value);
  return node;
};
const setText = (id, value) => { $(id).textContent = String(value); };

const slugMatch = location.pathname.match(/\/e\/([^/]+)\/metrics\/?$/);
const routeSlug = slugMatch ? decodeURIComponent(slugMatch[1]) : "";
const initialParams = new URLSearchParams(location.search);
const views = new Set(["overview", "play", "audience", "leads"]);
const ranges = new Set(["today", "7d", "30d", "all", "custom"]);
const state = {
  activeView: views.has(location.hash.slice(1)) ? location.hash.slice(1) : "overview",
  event: initialParams.get("event") || routeSlug || "all",
  range: ranges.has(initialParams.get("range")) ? initialParams.get("range") : "7d",
  customFrom: initialParams.get("from") || "",
  customTo: initialParams.get("to") || "",
  events: [], activity: [], leads: [], reportSummary: null,
  promptPage: 0, voteChoicePage: 0, leadPage: 0,
  detailLeadId: null, detailPage: 0, detailReturnFocus: null,
  requestId: 0,
};
if (state.customFrom && state.customTo) state.range = "custom";

function showNotice(title, detail) {
  const notice = $("report-notice");
  notice.replaceChildren(make("strong", "", title), make("span", "", detail));
  notice.hidden = false;
}
function hideNotice() { $("report-notice").hidden = true; }
function redirectToLogin() {
  const next = `${location.pathname}${location.search}${location.hash}`;
  location.replace(`/login?next=${encodeURIComponent(next)}`);
}
function filters() {
  if (state.range === "all") return { event: state.event };
  if (state.range === "custom") return { event: state.event, from: state.customFrom, to: state.customTo };
  const today = dayInZone(new Date(), reportTimeZone()), start = new Date(`${today}T00:00:00.000Z`);
  if (state.range === "7d") start.setUTCDate(start.getUTCDate() - 6);
  if (state.range === "30d") start.setUTCDate(start.getUTCDate() - 29);
  return { event: state.event, from: isoDay(start), to: today };
}
function filterQuery() {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters())) if (value) query.set(key, value);
  return query;
}
function rangeText() {
  if (state.range === "all") return "All time";
  if (state.range === "today") return "Today";
  if (state.range === "7d") return "Last 7 days";
  if (state.range === "30d") return "Last 30 days";
  return state.customFrom && state.customTo ? `${shortDate(`${state.customFrom}T12:00:00Z`)} – ${shortDate(`${state.customTo}T12:00:00Z`)}` : "Custom range";
}
function updateHistory() {
  const query = new URLSearchParams();
  if (state.event !== routeSlug) query.set("event", state.event);
  if (state.range !== "7d") query.set("range", state.range);
  if (state.range === "custom") { query.set("from", state.customFrom); query.set("to", state.customTo); }
  history.replaceState(null, "", `${location.pathname}${query.size ? `?${query}` : ""}#${state.activeView}`);
}
function resetPages() { state.promptPage = state.voteChoicePage = state.leadPage = 0; closeLeadDetail(); }
function renderEventOptions() {
  const select = $("event-filter"), list = [...state.events];
  if (state.event !== "all" && !list.some(item => item.slug === state.event)) list.push({ slug: state.event, name: state.event });
  select.replaceChildren(new Option("All events", "all"));
  for (const event of list) select.add(new Option(event.name || event.slug, event.slug));
  select.value = state.event;
  const controlSlug = state.event !== "all" ? state.event : routeSlug || list[0]?.slug;
  document.querySelectorAll("[data-control-link]").forEach(link => { link.href = controlSlug ? `/e/${encodeURIComponent(controlSlug)}/operator` : "/"; });
}
function normalizeActivity(input) {
  if (!Array.isArray(input)) return [];
  return input.map((row, index) => ({
    id: String(row.id ?? `activity-${index}`),
    eventId: String(row.eventId ?? row.event_id ?? ""),
    type: String(row.type ?? ""),
    at: row.at ?? row.createdAt ?? row.timestamp,
    properties: safeObject(row.properties ?? row.data),
  })).filter(row => row.type && Number.isFinite(Date.parse(row.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
function normalizeLeads(input) {
  if (!Array.isArray(input)) return [];
  return input.map((row, index) => {
    const values = safeObject(row.fieldValues ?? row.field_values);
    const snapshot = Array.isArray(row.fieldSnapshot ?? row.field_snapshot) ? row.fieldSnapshot ?? row.field_snapshot : [];
    return {
      ...row, id: String(row.id ?? `lead-${index}`),
      eventId: String(row.eventId ?? row.event_id ?? ""),
      createdAt: row.createdAt ?? row.created_at ?? row.at,
      fieldValues: values, fieldSnapshot: snapshot,
      marketingOptIn: row.marketingOptIn === true || row.marketing_opt_in === true,
    };
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
function uniquePeople(rows, keys = ["participantId", "playerId", "sessionId"]) {
  const people = new Set();
  rows.forEach(row => {
    const id = keys.map(key => row.properties?.[key]).find(Boolean);
    people.add(`${row.eventId}:${id || `activity:${row.id}`}`);
  });
  return people.size;
}
const engagementTypes = new Set(["player_joined", "result_viewed", "cta_opened", "guide_cta_opened", "expert_cta_opened", "twilio_product_link_opened", "github_cta_opened", "lead_form_opened", "lead_captured", "lead_submitted", "vote_accepted"]);
function buildSummary(records, leads) {
  const byType = type => records.filter(row => row.type === type);
  const landings = byType("landing_opened"), joins = byType("player_joined"), heatStarts = byType("heat_started"), heatEnds = byType("heat_completed");
  const resultViews = byType("result_viewed"), genericCtaOpens = byType("cta_opened"), ctaOpens = genericCtaOpens.length ? genericCtaOpens : [...byType("guide_cta_opened"), ...byType("expert_cta_opened")], leadForms = byType("lead_form_opened"), votes = byType("vote_accepted");
  const proposals = [...byType("judge_proposed"), ...byType("ai_proposed")], verified = byType("match_verified"), promptReveals = byType("prompt_revealed");
  const awardActions = byType("winner_finalized"), finalByHeat = new Map();
  awardActions.forEach(row => finalByHeat.set(`${row.eventId}:${row.properties.heatId || row.id}`, row));
  const awards = [...finalByHeat.values()];
  const winners = row => Array.isArray(row.properties.winners) ? row.properties.winners : Array.isArray(row.properties.playerIds) ? row.properties.playerIds : [];
  const playerEntries = heatStarts.reduce((sum, row) => sum + (Number(row.properties.playerCount) || (Array.isArray(row.properties.players) ? row.properties.players.length : 0)), 0);
  const prompts = new Map();
  const ensurePrompt = row => {
    const id = String(row.properties.promptId || "unknown"), key = `${row.eventId}:${id}`;
    if (!prompts.has(key)) prompts.set(key, { promptId: id, text: String(row.properties.promptText || id), category: String(row.properties.category || ""), plays: 0, matches: 0 });
    return prompts.get(key);
  };
  promptReveals.forEach(row => { ensurePrompt(row).plays++; });
  awards.forEach(row => { if (row.properties.promptId && winners(row).length) ensurePrompt(row).matches++; });
  const daily = new Map();
  records.forEach(row => {
    const day = dayInZone(row.at, reportTimeZone());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    if (!daily.has(day)) daily.set(day, { day, landings: 0, joins: 0, leads: 0, votes: 0 });
    const current = daily.get(day);
    if (row.type === "landing_opened") current.landings++;
    if (row.type === "player_joined") current.joins++;
    if (row.type === "vote_accepted") current.votes++;
  });
  leads.forEach(lead => {
    const day = dayInZone(lead.createdAt, reportTimeZone());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    if (!daily.has(day)) daily.set(day, { day, landings: 0, joins: 0, leads: 0, votes: 0 });
    daily.get(day).leads++;
  });
  const uniqueLeads = leads.length;
  const voterIds = votes.map(row => row.properties.voterId || row.properties.voterHash || row.properties.voterKey || row.properties.sessionId);
  const channelVotes = { web: 0, sms: 0, whatsapp: 0 }, voteTypes = { category: 0, creative: 0 }, choices = new Map();
  votes.forEach(row => {
    const p = row.properties, channel = String(p.channel || "web").toLowerCase();
    channelVotes[channel] = (channelVotes[channel] || 0) + 1;
    const type = String(p.windowType || p.voteType || p.type || "category").toLowerCase();
    if (type.includes("creative")) voteTypes.creative++; else voteTypes.category++;
    const choice = String(p.choice ?? "").trim();
    if (!choice) return;
    const kind = type.includes("creative") ? "Creative" : "Category", key = `${kind}:${choice}`;
    if (!choices.has(key)) choices.set(key, { label: String(p.choiceLabel || choice), kind, votes: 0 });
    choices.get(key).votes++;
  });
  const durations = verified.map(row => Number(row.properties.timeToMatchMs)).filter(value => Number.isFinite(value) && value >= 0);
  const uniqueVisitors = uniquePeople(landings), uniquePlayers = uniquePeople(joins);
  const productLinkRows = byType("twilio_product_link_opened");
  const twilioProductLinkClicks = productLinkRows.length;
  const twilioProductLinkClicksByProduct = { video: 0, messaging: 0, segment: 0 };
  productLinkRows.forEach(row => {
    const product = row.properties.product;
    if (Object.hasOwn(twilioProductLinkClicksByProduct, product)) twilioProductLinkClicksByProduct[product]++;
  });
  const githubLinkRows = byType("github_cta_opened");
  const githubRepoClicks = githubLinkRows.length;
  const githubRepoClicksBySource = { phone: 0, spectator: 0, arenaQr: 0, arenaLink: 0 };
  githubLinkRows.forEach(row => {
    const source = row.properties.source;
    const key = source === "arena_qr" ? "arenaQr" : source === "arena_link" ? "arenaLink" : source === "spectator" ? "spectator" : "phone";
    githubRepoClicksBySource[key]++;
  });
  return {
    totalEvents: records.length, uniqueVisitors, uniquePlayers,
    engagementActions: records.filter(row => engagementTypes.has(row.type)).length,
    twilioProductLinkClicks, twilioProductLinkClicksByProduct, githubRepoClicks, githubRepoClicksBySource,
    playerEntries,
    heatsCompleted: new Set(heatEnds.map(row => `${row.eventId}:${row.properties.heatId || row.id}`)).size,
    averagePlayers: heatStarts.length ? playerEntries / heatStarts.length : 0,
    ties: awards.filter(row => winners(row).length > 1).length,
    noMatches: awards.filter(row => winners(row).length === 0).length,
    overrides: awardActions.filter(row => row.properties.isOverride === true || row.properties.source === "override").length,
    verifiedMatches: verified.length, judgeProposals: proposals.length, cameraFailures: byType("camera_failed").length,
    avgMatchMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
    promptsPlayed: promptReveals.length,
    prompts: [...prompts.values()].sort((a, b) => b.plays - a.plays || a.text.localeCompare(b.text)),
    leadFormOpens: leadForms.length, uniqueLeads, votes: votes.length,
    ballotVisitors: uniquePeople(byType("vote_page_opened")),
    uniqueVoters: voterIds.every(Boolean) ? new Set(votes.map((row, index) => `${row.eventId}:${voterIds[index]}`)).size : null,
    channelVotes, voteTypes,
    voteChoices: [...choices.values()].sort((a, b) => b.votes - a.votes || a.label.localeCompare(b.label)),
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
    funnel: [
      { label: "Opened", count: uniqueVisitors },
      { label: "Joined", count: uniquePlayers },
      { label: "Saw result", count: uniquePeople(resultViews) },
      { label: "Opened CTA", count: uniquePeople(ctaOpens) },
      { label: "Twilio pages", count: twilioProductLinkClicks, title: "Clicks on official Twilio product pages" },
      { label: "GitHub repo", count: githubRepoClicks, title: "Clicks to open the GitHub repository; stars are not tracked" },
      { label: "Shared details", count: uniqueLeads },
    ],
  };
}

function makeEmpty(title, detail) {
  const box = make("div", "empty-state");
  box.append(make("strong", "", title), make("span", "", detail));
  return box;
}
function chartDays(summary) {
  const selected = filters(), latest = selected.to || summary.daily.at(-1)?.day || isoDay(new Date());
  const last = new Date(`${latest}T12:00:00.000Z`);
  let fullDays = state.range === "today" ? 1 : state.range === "7d" ? 7 : state.range === "30d" ? 30 : 1;
  if (state.range === "custom") fullDays = Math.max(1, Math.round((Date.parse(`${state.customTo}T12:00:00Z`) - Date.parse(`${state.customFrom}T12:00:00Z`)) / 86400000) + 1);
  if (state.range === "all" && summary.daily.length) fullDays = Math.max(1, Math.round((Date.parse(`${summary.daily.at(-1).day}T12:00:00Z`) - Date.parse(`${summary.daily[0].day}T12:00:00Z`)) / 86400000) + 1);
  const count = Math.min(14, fullDays), byDay = new Map(summary.daily.map(row => [row.day, row]));
  const rows = Array.from({ length: count }, (_, index) => {
    const date = new Date(last); date.setUTCDate(last.getUTCDate() - count + index + 1);
    const day = isoDay(date);
    return byDay.get(day) || { day, joins: 0, leads: 0 };
  });
  return { rows, scope: fullDays > 14 ? "latest 14 days" : count === 1 ? "today" : `${count}-day view`, truncated: fullDays > 14 };
}
function renderChart(summary) {
  const chart = $("activity-chart"), axis = $("chart-axis");
  chart.replaceChildren(); axis.replaceChildren();
  const window = chartDays(summary);
  setText("chart-scope", window.scope);
  $("chart-scope").title = window.truncated ? "The chart shows the latest 14 days; totals cover the entire selected range." : "Player joins across the selected range.";
  if (!summary.totalEvents) { chart.append(makeEmpty("No activity yet", "Visitors and heats will appear here.")); return; }
  const max = Math.max(1, ...window.rows.map(row => row.joins));
  for (const row of window.rows) {
    const column = make("div", "bar-column"), bar = make("div", "bar");
    const height = row.joins ? Math.max(4, row.joins / max * 100) : 0;
    bar.style.height = `${height}%`; bar.style.minHeight = row.joins ? "3px" : "0";
    column.title = `${shortDate(`${row.day}T12:00:00Z`)}: ${row.joins} player joins, ${row.leads} leads`;
    column.setAttribute("aria-label", column.title);
    column.append(bar);
    if (row.leads) { const tip = make("span", "lead-tip"); tip.style.setProperty("--bar-height", `${height}%`); column.append(tip); }
    chart.append(column);
    const label = make("span", "", shortDate(`${row.day}T12:00:00Z`).replace(/^[A-Za-z]+\s/, ""));
    label.title = shortDate(`${row.day}T12:00:00Z`); axis.append(label);
  }
}
function renderFunnel(summary) {
  const host = $("funnel-rows"); host.replaceChildren();
  const max = Math.max(1, ...summary.funnel.map(row => row.count));
  for (const row of summary.funnel) {
    const element = make("div", "funnel-row"), track = make("div", "funnel-track"), fill = make("div", "funnel-fill");
    if (row.title) element.title = row.title;
    fill.style.width = `${row.count / max * 100}%`;
    track.append(fill); element.append(make("span", "", row.label), track, make("strong", "", number(row.count))); host.append(element);
  }
  setText("funnel-rate", summary.uniqueVisitors ? `${percent(summary.uniqueLeads / summary.uniqueVisitors * 100)} lead rate` : "— lead rate");
}
function renderOverview(summary) {
  setText("kpi-visitors", number(summary.uniqueVisitors));
  setText("kpi-players", number(summary.uniquePlayers));
  setText("kpi-actions", number(summary.engagementActions));
  setText("kpi-leads", number(state.leads.length));
  for (const product of ["video", "messaging", "segment"]) setText(`product-${product}-clicks`, number(summary.twilioProductLinkClicksByProduct[product]));
  for (const [source, id] of [["phone", "repo-phone-clicks"], ["spectator", "repo-spectator-clicks"], ["arenaQr", "repo-arena-qr-clicks"], ["arenaLink", "repo-arena-link-clicks"]])
    setText(id, number(summary.githubRepoClicksBySource[source]));
  renderChart(summary); renderFunnel(summary);
}
function pageSize(kind) {
  const compact = innerWidth <= 760;
  if (kind === "detail") return compact ? 1 : 2;
  if (kind === "lead") return compact ? innerHeight <= 640 ? 3 : 4 : 6;
  return compact ? innerHeight <= 640 ? 3 : 4 : 5;
}
function renderPrompts(summary) {
  const rows = summary.prompts, size = pageSize("prompt"), pages = Math.max(1, Math.ceil(rows.length / size));
  state.promptPage = Math.min(state.promptPage, pages - 1);
  const host = $("prompt-rows"); host.replaceChildren();
  if (!rows.length) host.append(makeEmpty("No prompts played", "Revealed challenges will appear here."));
  else for (const prompt of rows.slice(state.promptPage * size, (state.promptPage + 1) * size)) {
    const row = make("div", "prompt-row"), name = make("span", "name", prompt.text);
    name.title = prompt.text; name.append(make("small", "", prompt.category || "Challenge"));
    row.append(name, make("strong", "", number(prompt.plays)), make("strong", "rate", prompt.plays ? percent(prompt.matches / prompt.plays * 100) : "—"));
    host.append(row);
  }
  setText("prompt-total", `${number(summary.promptsPlayed)} reveals`);
  setText("prompt-page", rows.length ? `${state.promptPage * size + 1}–${Math.min((state.promptPage + 1) * size, rows.length)} of ${rows.length} prompts` : "0 prompts");
  $("prompt-prev").disabled = state.promptPage <= 0;
  $("prompt-next").disabled = state.promptPage >= pages - 1;
}
function renderPlay(summary) {
  setText("play-entries", number(summary.playerEntries));
  setText("play-heats", number(summary.heatsCompleted));
  setText("play-average", `avg ${summary.averagePlayers ? summary.averagePlayers.toFixed(1) : "0"} players`);
  setText("play-ties", number(summary.ties)); setText("play-overrides", number(summary.overrides));
  setText("judge-verified", number(summary.verifiedMatches)); setText("judge-no-match", number(summary.noMatches));
  setText("judge-proposals", number(summary.judgeProposals)); setText("judge-cameras", number(summary.cameraFailures));
  setText("judge-speed", summary.avgMatchMs == null ? "—" : `${(summary.avgMatchMs / 1000).toFixed(1)}s`);
  renderPrompts(summary);
}
function renderAudience(summary) {
  setText("audience-votes", number(summary.votes));
  setText("audience-voters", summary.uniqueVoters == null ? "—" : number(summary.uniqueVoters));
  $("audience-voters").parentElement.querySelector("small").textContent = summary.uniqueVoters == null ? "anonymous ID unavailable" : "across selected events";
  setText("audience-categories", number(summary.voteTypes.category));
  setText("audience-creatives", number(summary.voteTypes.creative));
  setText("vote-conversion", summary.ballotVisitors ? `${percent(summary.channelVotes.web / summary.ballotVisitors * 100)} web rate` : "— web rate");
  setText("vote-visit-note", `${number(summary.ballotVisitors)} ballot visits · Voting never creates a lead.`);
  const choices = summary.voteChoices, size = pageSize("choice"), pages = Math.max(1, Math.ceil(choices.length / size));
  state.voteChoicePage = Math.min(state.voteChoicePage, pages - 1);
  const host = $("vote-choice-rows"); host.replaceChildren();
  if (!choices.length) host.append(makeEmpty("No votes yet", "Ballot choices will appear here."));
  else for (const choice of choices.slice(state.voteChoicePage * size, (state.voteChoicePage + 1) * size)) {
    const row = make("div", "vote-choice-row"), name = make("span", "choice-name", choice.label);
    name.title = choice.label;
    row.append(name, make("span", "choice-type", choice.kind), make("strong", "", number(choice.votes)));
    host.append(row);
  }
  setText("vote-choice-count", `${number(choices.length)} choices`);
  setText("vote-choice-page", choices.length ? `${state.voteChoicePage * size + 1}–${Math.min((state.voteChoicePage + 1) * size, choices.length)} of ${choices.length} choices` : "0 choices");
  $("vote-choice-prev").disabled = state.voteChoicePage <= 0;
  $("vote-choice-next").disabled = state.voteChoicePage >= pages - 1;
  const channels = $("vote-channel-rows"); channels.replaceChildren();
  const max = Math.max(1, ...Object.values(summary.channelVotes));
  for (const [key, label] of [["web", "Web"], ["sms", "SMS"], ["whatsapp", "WhatsApp"]]) {
    const row = make("div", "vote-channel-row"), track = make("div", "vote-channel-track"), fill = make("div", "vote-channel-fill");
    fill.style.width = `${summary.channelVotes[key] / max * 100}%`;
    track.append(fill); row.append(make("span", "", label), track, make("strong", "", number(summary.channelVotes[key]))); channels.append(row);
  }
}

function leadValue(lead, id, type = "") {
  const direct = lead.fieldValues[id] ?? lead[id];
  if (direct !== undefined && direct !== null && String(direct).trim()) return String(direct);
  const field = type ? lead.fieldSnapshot.find(item => item?.type === type) : null;
  return field ? String(lead.fieldValues[field.id] ?? "") : "";
}
function leadFieldEntries(lead) {
  const values = lead.fieldValues, seen = new Set(), entries = [];
  const historic = { name: "Name", email: "Work email", phone: "Phone number", company: "Company", useCase: "Use case" };
  const labelFor = id => historic[id] || String(id).replace(/[-_]/g, " ").replace(/\b\w/g, char => char.toUpperCase());
  const snapshot = lead.fieldSnapshot.length ? lead.fieldSnapshot : Object.keys(historic).filter(id => lead[id] != null).map(id => ({ id, label: labelFor(id) }));
  for (const field of snapshot) {
    if (!field || typeof field.id !== "string" || seen.has(field.id)) continue;
    seen.add(field.id);
    const value = Object.hasOwn(values, field.id) ? values[field.id] : lead[field.id];
    entries.push({ label: String(field.label || labelFor(field.id)), value: String(value ?? "") });
  }
  for (const [id, value] of Object.entries(values)) if (!seen.has(id)) entries.push({ label: labelFor(id), value: String(value ?? "") });
  return entries;
}
function leadDetailPages(entries) {
  const capacity = innerWidth <= 760 ? 2 : 4, pages = [];
  let current = [], start = 0;
  const flush = () => { if (current.length) { pages.push({ start, items: current }); current = []; } };
  entries.forEach((entry, index) => {
    if (!current.length) start = index;
    if (entry.value.length > 180) { flush(); pages.push({ start: index, items: [entry] }); return; }
    current.push(entry);
    if (current.length === capacity) flush();
  });
  flush();
  return pages;
}
function maskedEmail(value) {
  const [local, domain] = String(value || "").split("@");
  return local && domain ? `${local.slice(0, 1)}•••@${domain}` : String(value || "");
}
function maskedPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 4 ? `••• ••• ${digits.slice(-4)}` : "Phone on file";
}
function closeLeadDetail() {
  if ($("lead-detail-overlay").hidden) return;
  const formerId = state.detailLeadId, formerFocus = state.detailReturnFocus;
  $("lead-detail-overlay").hidden = true;
  document.querySelector(".app").inert = false;
  state.detailLeadId = null; state.detailPage = 0; state.detailReturnFocus = null;
  const replacement = [...document.querySelectorAll(".lead-detail-button")].find(button => button.dataset.leadId === formerId);
  (formerFocus?.isConnected ? formerFocus : replacement || $("event-filter")).focus();
}
function requestedFollowup(lead) {
  const guide = Boolean(lead.guideRequestedAt) || lead.intent === "guide";
  const expert = Boolean(lead.expertRequestedAt) || lead.intent === "expert";
  if (guide && expert) return "Guide + expert";
  if (guide) return "Build guide";
  if (expert) return "Expert conversation";
  return "None requested";
}
function renderLeadDetail() {
  if (!state.detailLeadId) return;
  const lead = state.leads.find(item => item.id === state.detailLeadId);
  if (!lead) { closeLeadDetail(); return; }
  const email = leadValue(lead, "email", "email"), phone = leadValue(lead, "phone", "tel");
  setText("lead-detail-heading", leadValue(lead, "name") || (email ? "Email contact" : phone ? "Phone contact" : "Visitor"));
  const when = new Date(lead.createdAt);
  const date = Number.isFinite(when.getTime()) ? when.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Date unavailable";
  setText("lead-detail-summary", `Captured ${date} · ${requestedFollowup(lead)}`);
  const entries = leadFieldEntries(lead), pages = leadDetailPages(entries);
  state.detailPage = Math.min(state.detailPage, Math.max(0, pages.length - 1));
  const current = pages[state.detailPage] || { start: 0, items: [] }, start = current.start, visible = current.items, host = $("lead-detail-fields");
  host.replaceChildren();
  host.style.setProperty("--detail-rows", innerWidth <= 760 ? visible.length || 1 : Math.max(1, Math.ceil(visible.length / 2)));
  host.classList.toggle("single-field", visible.length === 1);
  if (!entries.length) host.append(makeEmpty("No answers saved", "This record has no saved form fields."));
  for (const entry of visible) {
    const card = make("div", "lead-detail-field"), label = make("span", "lead-detail-label", entry.label), value = make("strong", "lead-detail-value", entry.value.trim() || "Not provided");
    card.setAttribute("role", "listitem");
    if (!entry.value.trim()) value.classList.add("empty");
    if (entry.value.length > 180) value.classList.add("long");
    value.title = entry.value;
    card.append(label, value); host.append(card);
  }
  setText("lead-detail-page", entries.length ? `${start + 1}–${Math.min(start + visible.length, entries.length)} of ${entries.length} fields` : "0 fields");
  $("lead-detail-prev").disabled = state.detailPage <= 0;
  $("lead-detail-next").disabled = state.detailPage >= pages.length - 1;
}
function openLeadDetail(lead, button) {
  state.detailLeadId = lead.id; state.detailPage = 0; state.detailReturnFocus = button;
  $("lead-detail-overlay").hidden = false;
  document.querySelector(".app").inert = true;
  renderLeadDetail(); $("lead-detail-close").focus();
}
function renderLeadRows() {
  const leads = state.leads, size = pageSize("lead"), pages = Math.max(1, Math.ceil(leads.length / size));
  state.leadPage = Math.min(state.leadPage, pages - 1);
  const host = $("lead-rows"); host.replaceChildren();
  if (!leads.length) host.append(makeEmpty("No leads in this range", "Players who share details at join appear here."));
  else for (const lead of leads.slice(state.leadPage * size, (state.leadPage + 1) * size)) {
    const email = leadValue(lead, "email", "email"), phone = leadValue(lead, "phone", "tel");
    const contactName = leadValue(lead, "name") || (email ? "Email contact" : phone ? "Phone contact" : "Visitor");
    const row = make("div", "lead-row"), contact = make("span", "contact", contactName), details = make("button", "lead-detail-button", "Details");
    contact.append(make("small", "", email ? maskedEmail(email) : phone ? maskedPhone(phone) : "—"));
    details.type = "button"; details.dataset.leadId = lead.id;
    details.setAttribute("aria-label", `View saved answers for ${contactName}`);
    details.addEventListener("click", () => openLeadDetail(lead, details));
    row.append(contact, make("span", "request", requestedFollowup(lead)), make("span", "date", shortDate(lead.createdAt)), details);
    host.append(row);
  }
  setText("lead-page", leads.length ? `${state.leadPage * size + 1}–${Math.min((state.leadPage + 1) * size, leads.length)} of ${leads.length} leads` : "0 leads");
  $("lead-prev").disabled = state.leadPage <= 0;
  $("lead-next").disabled = state.leadPage >= pages - 1;
  $("export-leads").disabled = !leads.length;
}
function renderLeads(summary) {
  setText("lead-count", number(state.leads.length));
  setText("lead-conversion", summary.leadFormOpens ? percent(state.leads.length / summary.leadFormOpens * 100) : "—");
  const guides = state.reportSummary?.guideRequests ?? state.leads.filter(lead => Boolean(lead.guideRequestedAt) || lead.intent === "guide").length;
  const experts = state.reportSummary?.expertRequests ?? state.leads.filter(lead => Boolean(lead.expertRequestedAt) || lead.intent === "expert").length;
  setText("lead-guides", number(guides)); setText("lead-experts", number(experts));
  setText("intent-guide", number(guides)); setText("intent-expert", number(experts));
  const selected = state.events.find(event => event.slug === state.event);
  const leadStatus = state.event === "all" ? "Lead forms are configured per event."
    : selected?.leadCaptureEnabled === false ? "Lead capture is off for this event."
      : selected?.leadCaptureEnabled === true ? `Capture at join · ${selected.leadFieldCount || 0} fields.`
        : `Showing follow-up from ${selected?.name || state.event}.`;
  setText("lead-status", leadStatus);
  renderLeadRows(); renderLeadDetail();
}
function render() {
  renderEventOptions(); $("date-filter").value = state.range;
  setText("range-caption", `${rangeText()} · ${reportTimeZone()}`);
  $("range-caption").title = `Date boundaries use ${reportTimeZone()}.`;
  const summary = buildSummary(state.activity, state.leads);
  $("export-activity").disabled = !state.activity.length;
  renderOverview(summary); renderPlay(summary); renderAudience(summary); renderLeads(summary);
}
function showView(view) {
  if (!views.has(view)) return;
  closeLeadDetail(); state.activeView = view;
  document.querySelectorAll(".nav[data-view]").forEach(button => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  document.querySelectorAll(".panel").forEach(panel => panel.classList.toggle("active", panel.id === `panel-${view}`));
  updateHistory(); render();
}

async function loadReport() {
  const requestId = ++state.requestId;
  const requestedQuery = filterQuery().toString();
  setText("data-badge", "LOADING"); hideNotice();
  try {
    const response = await fetch(`/api/admin/report?${requestedQuery}`, { credentials: "same-origin", cache: "no-store" });
    if (response.status === 401) { redirectToLogin(); return; }
    if (response.status === 403) { showNotice("Admin access required", "Ask an event administrator to open this private report."); setText("data-badge", "RESTRICTED"); return; }
    if (!response.ok) throw new Error(`Report request failed (${response.status})`);
    const payload = await response.json();
    if (requestId !== state.requestId) return;
    if (Array.isArray(payload.events)) {
      const previous = new Map(state.events.map(event => [event.slug, event]));
      state.events = payload.events.filter(item => item?.slug).map(item => ({ ...previous.get(item.slug), ...item, slug: item.slug, name: item.name || item.slug, timeZone: item.timeZone || previous.get(item.slug)?.timeZone || "UTC" }));
      if (["today", "7d", "30d"].includes(state.range) && filterQuery().toString() !== requestedQuery) { await loadReport(); return; }
    }
    state.activity = normalizeActivity(payload.activity);
    state.leads = normalizeLeads(payload.leads);
    state.reportSummary = safeObject(payload.summary);
    setText("data-badge", "EVENT DATA"); render();
  } catch (error) {
    if (requestId !== state.requestId) return;
    setText("data-badge", "UNAVAILABLE");
    showNotice("Report unavailable", error.message || "Could not load the selected event report. Try Refresh.");
  }
}
function exportFilename(kind) {
  const event = String(state.event === "all" ? "all-events" : state.event).toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 80);
  const selected = filters(), range = selected.from && selected.to ? `${selected.from}-to-${selected.to}` : "all-time";
  return `live-scavenger-hunt-${event}-${range}-${kind}.csv`;
}
async function exportCsv(kind) {
  const button = $(kind === "leads" ? "export-leads" : "export-activity"), prior = button.textContent;
  button.disabled = true; button.textContent = "Preparing…";
  try {
    const query = filterQuery(); query.set("kind", kind);
    const response = await fetch(`/api/admin/export?${query}`, { credentials: "same-origin", cache: "no-store" });
    if (response.status === 401) { redirectToLogin(); return; }
    if (!response.ok) throw new Error(`Export failed (${response.status})`);
    const blob = await response.blob(), url = URL.createObjectURL(blob), anchor = document.createElement("a");
    anchor.href = url; anchor.download = exportFilename(kind); document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (error) { showNotice("Export unavailable", error.message || "Try again after refreshing the report."); }
  finally { button.textContent = prior; button.disabled = false; }
}
async function init() {
  renderEventOptions(); showView(state.activeView);
  try {
    const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
    if (response.status === 401) { redirectToLogin(); return; }
    if (!response.ok) throw new Error(`Session check failed (${response.status})`);
    const session = await response.json();
    if (!session.user) { redirectToLogin(); return; }
    if (String(session.user.role).toLowerCase() !== "admin") { showNotice("Admin access required", "Ask an event administrator to open this private report."); setText("data-badge", "RESTRICTED"); return; }
    try {
      const eventResponse = await fetch("/api/admin/events", { credentials: "same-origin", cache: "no-store" });
      if (eventResponse.ok) {
        const data = await eventResponse.json();
        state.events = Array.isArray(data.events) ? data.events.filter(item => item?.slug).map(item => ({ slug: item.slug, name: item.name || item.slug, timeZone: item.timeZone || "UTC" })) : [];
      }
    } catch { /* A failed event menu request does not block the report. */ }
    await loadReport();
  } catch (error) { setText("data-badge", "UNAVAILABLE"); showNotice("Could not verify session", error.message || "Reload to try again."); }
}

document.querySelectorAll(".nav[data-view]").forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));
$("event-filter").addEventListener("change", event => { state.event = event.target.value; resetPages(); updateHistory(); loadReport(); });
$("date-filter").addEventListener("change", event => {
  const choice = event.target.value;
  if (choice === "custom") {
    const today = dayInZone(new Date(), reportTimeZone()), week = new Date(`${today}T00:00:00Z`); week.setUTCDate(week.getUTCDate() - 6);
    $("date-from").value = state.customFrom || isoDay(week); $("date-to").value = state.customTo || today;
    $("custom-range").hidden = false; $("date-from").focus();
  } else { state.range = choice; $("custom-range").hidden = true; resetPages(); updateHistory(); loadReport(); }
});
$("cancel-range").addEventListener("click", () => { $("custom-range").hidden = true; $("date-filter").value = state.range; });
$("apply-range").addEventListener("click", () => {
  const from = $("date-from").value, to = $("date-to").value;
  if (!from || !to || from > to) { $("date-from").setCustomValidity("Choose a valid date range."); $("date-from").reportValidity(); $("date-from").setCustomValidity(""); return; }
  state.customFrom = from; state.customTo = to; state.range = "custom";
  $("custom-range").hidden = true; resetPages(); updateHistory(); loadReport();
});
$("refresh-report").addEventListener("click", loadReport);
$("export-activity").addEventListener("click", () => exportCsv("events"));
$("export-leads").addEventListener("click", () => exportCsv("leads"));
$("prompt-prev").addEventListener("click", () => { state.promptPage--; render(); });
$("prompt-next").addEventListener("click", () => { state.promptPage++; render(); });
$("vote-choice-prev").addEventListener("click", () => { state.voteChoicePage--; render(); });
$("vote-choice-next").addEventListener("click", () => { state.voteChoicePage++; render(); });
$("lead-prev").addEventListener("click", () => { state.leadPage--; render(); });
$("lead-next").addEventListener("click", () => { state.leadPage++; render(); });
$("lead-detail-close").addEventListener("click", closeLeadDetail);
$("lead-detail-prev").addEventListener("click", () => { state.detailPage--; renderLeadDetail(); });
$("lead-detail-next").addEventListener("click", () => { state.detailPage++; renderLeadDetail(); });
$("lead-detail-overlay").addEventListener("click", event => { if (event.target === $("lead-detail-overlay")) closeLeadDetail(); });
document.addEventListener("keydown", event => {
  if (!$("lead-detail-overlay").hidden) {
    if (event.key === "Escape") { event.preventDefault(); closeLeadDetail(); }
    if (event.key === "Tab") {
      const controls = [$("lead-detail-close"), $("lead-detail-prev"), $("lead-detail-next")].filter(button => !button.disabled);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    return;
  }
  if (event.key === "Escape" && !$("custom-range").hidden) { $("custom-range").hidden = true; $("date-filter").value = state.range; }
});
window.addEventListener("resize", render);
init();
