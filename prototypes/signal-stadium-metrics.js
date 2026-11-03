(() => {
  const store = window.SignalStadiumStore;
  const metrics = window.SignalStadiumMetrics;
  const leadsStore = window.SignalStadiumLeads;
  const $ = id => document.getElementById(id);
  const number = value => new Intl.NumberFormat().format(Number(value) || 0);
  const clampPercent = value => `${Math.max(0, Math.min(100, Math.round(value || 0)))}%`;
  const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const shortDate = value => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]));
  let activeView = ["overview", "play", "leads"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview";
  let eventId = store.getActiveEventId();
  let range = "7d";
  let lastRange = "7d";
  let customFrom = "";
  let customTo = "";
  let sampleMode = new URLSearchParams(location.search).get("sample") === "1";
  let promptPage = 0;
  let leadPage = 0;
  let currentRecords = [];
  let currentLeads = [];
  let detailLeadId = null;
  let detailPage = 0;
  let detailReturnFocus = null;

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function makeEmpty(title, detail, sampleButton = false) {
    const box = make("div", "empty-state");
    box.append(make("strong", "", title), make("span", "", detail));
    if (sampleButton && !sampleMode) { const button = make("button", "", "Preview sample activity"); button.type = "button"; button.addEventListener("click", toggleSample); box.append(button); }
    return box;
  }
  function currentFilters() {
    if (range === "all") return { eventId };
    if (range === "custom") return { eventId, from: customFrom || null, to: customTo || null };
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (range === "7d") start.setDate(start.getDate() - 6);
    if (range === "30d") start.setDate(start.getDate() - 29);
    return { eventId, from: dateKey(start), to: dateKey(today) };
  }
  function rangeText() {
    if (range === "all") return "All time";
    if (range === "today") return "Today";
    if (range === "7d") return "Last 7 days";
    if (range === "30d") return "Last 30 days";
    return customFrom && customTo ? `${shortDate(`${customFrom}T12:00:00`)} – ${shortDate(`${customTo}T12:00:00`)}` : "Custom range";
  }
  function renderEventOptions() {
    const select = $("event-filter");
    const events = store.listEvents();
    select.replaceChildren(new Option("All events", "all"));
    for (const event of events) select.add(new Option(event.name, event.id));
    if (!events.some(event => event.id === eventId)) eventId = "all";
    select.value = eventId;
  }
  function showView(view) {
    closeLeadDetail();
    activeView = view;
    for (const button of document.querySelectorAll(".nav[data-view]")) {
      const active = button.dataset.view === view;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    }
    for (const panel of document.querySelectorAll(".panel")) panel.classList.toggle("active", panel.id === `panel-${view}`);
    history.replaceState(null, "", `${location.pathname}${location.search}#${view}`);
    render();
  }
  function toggleSample() {
    closeLeadDetail();
    sampleMode = !sampleMode;
    promptPage = 0; leadPage = 0;
    $("sample-toggle").textContent = sampleMode ? "View real data" : "Preview sample";
    $("data-badge").textContent = sampleMode ? "SAMPLE PREVIEW" : "LOCAL DEMO";
    $("data-badge").classList.toggle("sample", sampleMode);
    render();
  }

  function sampleData() {
    const events = [], leads = [];
    const profiles = store.listEvents();
    const names = ["Alex Rivera", "Morgan Chen", "Sam Patel", "Jordan Lee", "Taylor Brooks", "Riley Kim", "Avery Davis", "Casey Nguyen", "Jamie Parker", "Devin Johnson", "Skylar Jones", "Robin Garcia"];
    const companies = ["Northstar", "Atlas Labs", "Arc Systems", "Lumen", "Bridgepoint", "Orion Digital"];
    const titles = ["Developer", "Product manager", "Solutions architect", "Founder", "Engineer", "Designer"];
    const defaultFields = [
      { id: "name", label: "Name", type: "text", required: true },
      { id: "email", label: "Work email", type: "email", required: true },
      { id: "company", label: "Company", type: "text", required: false },
    ];
    let sequence = 0;
    function add(eventId, type, at, properties = {}) { events.push({ id: `sample-${++sequence}`, eventId, type, at: at.toISOString(), properties: { ...properties, sample: true } }); }
    profiles.forEach((profile, profileIndex) => {
      const prompts = profile.prompts?.filter(item => item.enabled) || [];
      const fields = Array.isArray(profile.leadCapture?.fields) ? profile.leadCapture.fields : defaultFields;
      const canContact = fields.some(field => field.type === "email" || field.type === "tel");
      const offers = profile.leadCapture?.enabled === false || !canContact ? [] : [
        ...(profile.leadCapture?.guideEnabled === false ? [] : ["guide"]),
        ...(profile.leadCapture?.expertEnabled === false ? [] : ["expert"]),
      ];
      for (let day = 6; day >= 0; day--) {
        const base = new Date(); base.setHours(10, 0, 0, 0); base.setDate(base.getDate() - day);
        const visitors = 11 + ((day * 7 + profileIndex * 5) % 13);
        const joins = Math.max(3, Math.round(visitors * (.43 + ((day + profileIndex) % 3) * .04)));
        const ctas = Math.max(2, Math.round(joins * .56));
        const leadCount = offers.length ? Math.max(1, Math.round(ctas * .31)) : 0;
        const formOpens = offers.length ? Math.min(ctas, leadCount + Math.max(1, Math.round(ctas * .28))) : 0;
        for (let visitor = 0; visitor < visitors; visitor++) {
          const at = new Date(base.getTime() + (visitor * 18 + 4) * 60000);
          const participantId = `sample-${profileIndex}-${day}-${visitor}`;
          add(profile.id, "landing_opened", at, { participantId });
          if (visitor < joins) add(profile.id, "player_joined", new Date(at.getTime() + 60000), { participantId, heatId: `sample-heat-${profileIndex}-${day}-${Math.floor(visitor / 4)}` });
          if (visitor < Math.round(joins * .76)) add(profile.id, "result_viewed", new Date(at.getTime() + 6 * 60000), { participantId });
          if (visitor < ctas) add(profile.id, "cta_opened", new Date(at.getTime() + 7 * 60000), { participantId });
          if (visitor < formOpens) {
            const intent = offers[(visitor + day + profileIndex) % offers.length];
            add(profile.id, "lead_form_opened", new Date(at.getTime() + 8 * 60000), { participantId, intent });
          }
          if (visitor < leadCount) {
            const intent = offers[(visitor + day + profileIndex) % offers.length];
            const leadId = `sample-lead-${profileIndex}-${day}-${visitor}`;
            add(profile.id, "lead_submitted", new Date(at.getTime() + 9 * 60000), { participantId, intent, leadId });
            add(profile.id, intent === "guide" ? "guide_requested" : "expert_requested", new Date(at.getTime() + 9 * 60000), { participantId, intent, leadId });
            const name = names[(visitor + day + profileIndex) % names.length];
            const company = companies[(visitor + profileIndex) % companies.length];
            const email = `${name.toLowerCase().replace(/\s+/g, ".")}@example.com`;
            const phone = `+1 202 555 01${String((profileIndex * 19 + day * 13 + visitor) % 100).padStart(2, "0")}`;
            const fieldSnapshot = fields.map(field => ({ id: field.id, label: field.label, type: field.type, required: Boolean(field.required) }));
            const fieldValues = {};
            for (const field of fieldSnapshot) {
              if (field.id === "name") fieldValues[field.id] = name;
              else if (field.id === "company") fieldValues[field.id] = company;
              else if (field.type === "email") fieldValues[field.id] = email;
              else if (field.type === "tel") fieldValues[field.id] = phone;
              else if (/job[ -]?title/i.test(`${field.id} ${field.label}`)) fieldValues[field.id] = titles[(visitor + day) % titles.length];
              else fieldValues[field.id] = ["Customer engagement", "Notifications", "Support", "AI assistance"][visitor % 4];
            }
            const emailField = fieldSnapshot.find(field => field.type === "email");
            const phoneField = fieldSnapshot.find(field => field.type === "tel");
            leads.push({ id: leadId, eventId: profile.id, createdAt: new Date(at.getTime() + 9 * 60000).toISOString(), intent,
              name: fieldValues.name || "", email: emailField ? fieldValues[emailField.id] : "",
              phone: phoneField ? fieldValues[phoneField.id] : "", company: fieldValues.company || "",
              fieldValues, fieldSnapshot, participantId,
              heatId: `sample-heat-${profileIndex}-${day}-${Math.floor(visitor / 4)}`,
              marketingOptIn: Boolean(emailField && profile.leadCapture?.marketingOptIn !== false && (visitor + day) % 4 === 0) });
          }
        }
        const heats = Math.max(1, Math.ceil(joins / 4));
        for (let heat = 0; heat < heats; heat++) {
          const at = new Date(base.getTime() + (heat * 65 + 15) * 60000);
          const heatId = `sample-heat-${profileIndex}-${day}-${heat}`;
          const prompt = prompts[(day + heat) % Math.max(1, prompts.length)] || { id: "sample-prompt", text: "SHOW A RED CUP", category: "Combination" };
          const playerCount = Math.min(4, joins - heat * 4);
          add(profile.id, "heat_started", at, { heatId, playerCount });
          add(profile.id, "prompt_revealed", new Date(at.getTime() + 3000), { heatId, promptId: prompt.id, promptText: prompt.text, category: prompt.category });
          const noMatch = (day + heat) % 9 === 0;
          if (!noMatch) add(profile.id, "match_verified", new Date(at.getTime() + 9300), { heatId, promptId: prompt.id, timeToMatchMs: 6300 });
          if ((day + heat) % 3 === 0) add(profile.id, "judge_proposed", new Date(at.getTime() + 9500), { heatId, promptId: prompt.id });
          add(profile.id, "winner_finalized", new Date(at.getTime() + 11000), { heatId, promptId: prompt.id, promptText: prompt.text, winners: noMatch ? [] : (day + heat) % 11 === 0 ? [1, 2] : [1], source: (day + heat) % 8 === 0 ? "override" : "auto", isOverride: (day + heat) % 8 === 0 });
          add(profile.id, "heat_completed", new Date(at.getTime() + 14000), { heatId, promptId: prompt.id });
        }
      }
    });
    return { events, leads };
  }
  function filterLeads(rows, filters) {
    let from = filters.from ? new Date(`${filters.from}T00:00:00`).getTime() : -Infinity;
    let to = filters.to ? new Date(`${filters.to}T00:00:00`).getTime() + 86400000 - 1 : Infinity;
    if (!Number.isFinite(from)) from = -Infinity;
    if (!Number.isFinite(to)) to = Infinity;
    return rows.filter(row => (filters.eventId === "all" || !filters.eventId || row.eventId === filters.eventId) && Date.parse(row.createdAt) >= from && Date.parse(row.createdAt) <= to)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
  function getReport() {
    const filters = currentFilters();
    if (sampleMode) {
      const sample = sampleData();
      return { records: metrics.select(sample.events, filters), leads: filterLeads(sample.leads, filters) };
    }
    const records = metrics.query(filters);
    const leads = leadsStore?.list ? leadsStore.list(filters) : [];
    return { records, leads: Array.isArray(leads) ? leads : [] };
  }
  function setText(id, value) { $(id).textContent = String(value); }
  function chartDays(summary) {
    const filters = currentFilters();
    const last = filters.to ? new Date(`${filters.to}T12:00:00`) : summary.daily.length ? new Date(`${summary.daily.at(-1).day}T12:00:00`) : new Date();
    let fullDays = range === "today" ? 1 : range === "7d" ? 7 : range === "30d" ? 30 : 1;
    if (range === "custom" && filters.from && filters.to) fullDays = Math.max(1, Math.round((new Date(`${filters.to}T12:00:00`) - new Date(`${filters.from}T12:00:00`)) / 86400000) + 1);
    if (range === "all" && summary.daily.length) fullDays = Math.max(1, Math.round((new Date(`${summary.daily.at(-1).day}T12:00:00`) - new Date(`${summary.daily[0].day}T12:00:00`)) / 86400000) + 1);
    const count = Math.min(14, fullDays);
    const scope = fullDays > 14 ? "latest 14 days" : count === 1 ? "today" : `${count}-day view`;
    const map = new Map(summary.daily.map(row => [row.day, row]));
    const rows = Array.from({ length: count }, (_, index) => {
      const date = new Date(last); date.setDate(last.getDate() - count + index + 1);
      return map.get(dateKey(date)) || { day: dateKey(date), landings: 0, joins: 0, heats: 0, leads: 0, interactions: 0 };
    });
    return { rows, scope, truncated: fullDays > 14 };
  }
  function renderChart(summary) {
    const chart = $("activity-chart"), axis = $("chart-axis");
    chart.replaceChildren(); axis.replaceChildren();
    const window = chartDays(summary);
    setText("chart-scope", window.scope);
    $("chart-scope").title = window.truncated ? "Bars show only the latest 14 days of the selected date range; totals above cover the full range." : "Bars show player joins across the selected date range.";
    if (!summary.totalEvents) { chart.append(makeEmpty("No activity yet", "Run a heat or preview the sample report.", true)); return; }
    const days = window.rows;
    const max = Math.max(1, ...days.map(row => row.joins));
    for (const row of days) {
      const column = make("div", "bar-column");
      const bar = make("div", "bar");
      const height = row.joins ? Math.max(4, row.joins / max * 100) : 0;
      bar.style.height = `${height}%`;
      bar.style.minHeight = row.joins ? "3px" : "0";
      column.title = `${shortDate(`${row.day}T12:00:00`)}: ${row.joins} player joins, ${row.leads} leads`;
      column.setAttribute("aria-label", column.title);
      column.append(bar);
      if (row.leads) { const tip = make("span", "lead-tip"); tip.style.setProperty("--bar-height", `${height}%`); column.append(tip); }
      chart.append(column);
      const label = make("span", "", shortDate(`${row.day}T12:00:00`).replace(/^[A-Za-z]+\s/, ""));
      label.title = shortDate(`${row.day}T12:00:00`);
      axis.append(label);
    }
  }
  function renderFunnel(summary) {
    const host = $("funnel-rows"); host.replaceChildren();
    const max = Math.max(1, ...summary.funnel.map(row => row.count));
    for (const row of summary.funnel) {
      const element = make("div", "funnel-row");
      const name = make("span", "", row.label), track = make("div", "funnel-track"), fill = make("div", "funnel-fill"), count = make("strong", "", number(row.count));
      fill.style.width = `${row.count / max * 100}%`;
      track.append(fill); element.append(name, track, count); host.append(element);
    }
    const rate = summary.uniqueVisitors ? summary.uniqueLeads / summary.uniqueVisitors * 100 : 0;
    setText("funnel-rate", `${clampPercent(rate)} lead rate`);
  }
  function renderOverview(summary, leads) {
    setText("kpi-visitors", number(summary.uniqueVisitors));
    setText("kpi-players", number(summary.uniquePlayers));
    setText("kpi-actions", number(summary.engagementActions));
    setText("kpi-leads", number(leads.length));
    renderChart(summary); renderFunnel(summary);
  }
  function promptPageSize() { return innerWidth <= 760 ? innerHeight <= 640 ? 3 : 4 : 5; }
  function renderPrompts(summary) {
    const rows = summary.prompts;
    const size = promptPageSize(), pages = Math.max(1, Math.ceil(rows.length / size));
    promptPage = Math.min(promptPage, pages - 1);
    const host = $("prompt-rows"); host.replaceChildren();
    if (!rows.length) host.append(makeEmpty("No prompts played", "Revealed challenges will appear here."));
    else for (const prompt of rows.slice(promptPage * size, (promptPage + 1) * size)) {
      const row = make("div", "prompt-row");
      const name = make("span", "name", prompt.text); name.title = prompt.text;
      name.append(make("small", "", prompt.category || "Challenge"));
      const plays = make("strong", "", number(prompt.plays));
      const rate = make("strong", "rate", prompt.plays ? clampPercent(prompt.matches / prompt.plays * 100) : "—");
      row.append(name, plays, rate); host.append(row);
    }
    setText("prompt-total", `${number(summary.promptsPlayed)} reveals`);
    setText("prompt-page", rows.length ? `${promptPage * size + 1}–${Math.min((promptPage + 1) * size, rows.length)} of ${rows.length} prompts` : "0 prompts");
    $("prompt-prev").disabled = promptPage <= 0;
    $("prompt-next").disabled = promptPage >= pages - 1;
  }
  function renderPlay(summary) {
    setText("play-entries", number(summary.playerEntries));
    setText("play-heats", number(summary.heatsCompleted));
    setText("play-average", `avg ${summary.averagePlayers ? summary.averagePlayers.toFixed(1) : "0"} players`);
    setText("play-ties", number(summary.ties));
    setText("play-overrides", number(summary.overrides));
    setText("judge-verified", number(summary.verifiedMatches));
    setText("judge-no-match", number(summary.noMatches));
    setText("judge-proposals", number(summary.judgeProposals));
    setText("judge-cameras", number(summary.cameraFailures));
    setText("judge-speed", summary.avgMatchMs == null ? "—" : `${(summary.avgMatchMs / 1000).toFixed(1)}s`);
    renderPrompts(summary);
  }
  function leadPageSize() { return innerWidth <= 760 ? innerHeight <= 640 ? 3 : 4 : 6; }
  function maskedEmail(value) {
    const email = String(value || "");
    const [local, domain] = email.split("@");
    return local && domain ? `${local.slice(0, 1)}•••@${domain}` : email;
  }
  function maskedPhone(value) {
    const digits = String(value || "").replace(/\D/g, "");
    return digits.length >= 4 ? `••• ••• ${digits.slice(-4)}` : "Phone on file";
  }
  function fieldValue(lead, id, type = null) {
    const direct = lead[id] || lead.fieldValues?.[id];
    if (direct) return String(direct);
    const field = type && Array.isArray(lead.fieldSnapshot) ? lead.fieldSnapshot.find(item => item.type === type) : null;
    return field ? String(lead.fieldValues?.[field.id] || "") : "";
  }
  function leadFieldEntries(lead) {
    const values = lead.fieldValues && typeof lead.fieldValues === "object" && !Array.isArray(lead.fieldValues) ? lead.fieldValues : {};
    const historic = [
      { id: "name", label: "Name" }, { id: "email", label: "Work email" },
      { id: "phone", label: "Phone number" }, { id: "company", label: "Company" },
      { id: "useCase", label: "Use case (historic)" },
    ];
    const snapshot = Array.isArray(lead.fieldSnapshot) && lead.fieldSnapshot.length
      ? lead.fieldSnapshot : historic.filter(field => String(lead[field.id] ?? "").trim());
    const entries = [], seen = new Set();
    const labelFor = id => historic.find(field => field.id === id)?.label || String(id).replace(/[-_]/g, " ").replace(/\b\w/g, char => char.toUpperCase());
    for (const field of snapshot) {
      if (!field || typeof field.id !== "string" || seen.has(field.id)) continue;
      seen.add(field.id);
      const value = Object.prototype.hasOwnProperty.call(values, field.id) ? values[field.id] : lead[field.id];
      entries.push({ label: String(field.label || labelFor(field.id)), value: String(value ?? "") });
    }
    for (const [id, value] of Object.entries(values)) {
      if (seen.has(id)) continue;
      entries.push({ label: labelFor(id), value: String(value ?? "") });
    }
    return entries;
  }
  function detailPageSize() { return innerWidth <= 760 ? innerHeight <= 500 ? 1 : 2 : 4; }
  function closeLeadDetail() {
    const overlay = $("lead-detail-overlay");
    if (!overlay || overlay.hidden) return;
    const closedLeadId = detailLeadId;
    overlay.hidden = true;
    document.querySelector(".app").inert = false;
    detailLeadId = null; detailPage = 0;
    const focusTarget = detailReturnFocus; detailReturnFocus = null;
    const replacement = [...document.querySelectorAll(".lead-detail-button")].find(button => button.dataset.leadId === closedLeadId);
    (focusTarget?.isConnected ? focusTarget : replacement || $("sample-toggle")).focus();
  }
  function renderLeadDetail() {
    if (!detailLeadId) return;
    const lead = currentLeads.find(item => item.id === detailLeadId);
    if (!lead) { closeLeadDetail(); return; }
    const email = fieldValue(lead, "email", "email"), phone = fieldValue(lead, "phone", "tel");
    setText("lead-detail-heading", fieldValue(lead, "name") || (email ? "Email contact" : phone ? "Phone contact" : "Visitor"));
    const when = new Date(lead.createdAt);
    const date = Number.isFinite(when.getTime()) ? when.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Date unavailable";
    setText("lead-detail-summary", `${lead.intent === "expert" ? "Expert conversation" : "Build guide"} · ${date} · Email updates: ${lead.marketingOptIn ? "yes" : "no"}`);
    const entries = leadFieldEntries(lead), size = detailPageSize(), pages = Math.max(1, Math.ceil(entries.length / size));
    detailPage = Math.min(detailPage, pages - 1);
    const start = detailPage * size, visible = entries.slice(start, start + size);
    const host = $("lead-detail-fields"); host.replaceChildren();
    host.style.setProperty("--detail-rows", Math.max(1, Math.ceil(visible.length / (innerWidth <= 760 ? 1 : 2))));
    if (!entries.length) host.append(makeEmpty("No form answers saved", "This lead record has no saved fields."));
    for (const entry of visible) {
      const item = make("div", "lead-detail-field"); item.setAttribute("role", "listitem");
      const label = make("span", "lead-detail-label", entry.label);
      const value = make("strong", "lead-detail-value", entry.value.trim() || "Not provided");
      if (!entry.value.trim()) value.classList.add("empty");
      item.append(label, value); host.append(item);
    }
    setText("lead-detail-page", entries.length ? `${start + 1}–${Math.min(start + size, entries.length)} of ${entries.length} fields` : "0 fields");
    $("lead-detail-prev").disabled = detailPage <= 0;
    $("lead-detail-next").disabled = detailPage >= pages - 1;
  }
  function openLeadDetail(lead, button) {
    detailLeadId = lead.id; detailPage = 0; detailReturnFocus = button;
    $("lead-detail-overlay").hidden = false;
    document.querySelector(".app").inert = true;
    renderLeadDetail();
    $("lead-detail-close").focus();
  }
  function renderLeadRows(leads) {
    const size = leadPageSize(), pages = Math.max(1, Math.ceil(leads.length / size));
    leadPage = Math.min(leadPage, pages - 1);
    const host = $("lead-rows"); host.replaceChildren();
    if (!leads.length) host.append(makeEmpty("No leads in this range", "Follow-up requests will appear here."));
    else for (const lead of leads.slice(leadPage * size, (leadPage + 1) * size)) {
      const row = make("div", "lead-row");
      const email = fieldValue(lead, "email", "email"), phone = fieldValue(lead, "phone", "tel");
      const contact = make("span", "contact", fieldValue(lead, "name") || (email ? "Email contact" : phone ? "Phone contact" : "Visitor"));
      contact.append(make("small", "", email ? maskedEmail(email) : phone ? maskedPhone(phone) : "—"));
      const request = make("span", "request", lead.intent === "expert" ? "Expert" : "Guide");
      const date = make("span", "date", shortDate(lead.createdAt));
      const details = make("button", "lead-detail-button", "Details"); details.type = "button";
      details.dataset.leadId = lead.id;
      details.setAttribute("aria-label", `View saved answers for ${fieldValue(lead, "name") || (email ? "email contact" : phone ? "phone contact" : "visitor")}`);
      details.addEventListener("click", () => openLeadDetail(lead, details));
      row.append(contact, request, date, details); host.append(row);
    }
    setText("lead-page", leads.length ? `${leadPage * size + 1}–${Math.min((leadPage + 1) * size, leads.length)} of ${leads.length} leads` : "0 leads");
    $("lead-prev").disabled = leadPage <= 0;
    $("lead-next").disabled = leadPage >= pages - 1;
    $("export-leads").disabled = !leads.length;
  }
  function renderLeads(summary, leads) {
    setText("lead-count", number(leads.length));
    setText("lead-conversion", summary.leadFormOpens ? clampPercent(leads.length / summary.leadFormOpens * 100) : "—");
    setText("lead-guides", number(leads.filter(lead => lead.intent === "guide").length));
    setText("lead-experts", number(leads.filter(lead => lead.intent === "expert").length));
    setText("intent-guide", number(leads.filter(lead => lead.intent === "guide").length));
    setText("intent-expert", number(leads.filter(lead => lead.intent === "expert").length));
    setText("intent-marketing", number(leads.filter(lead => lead.marketingOptIn).length));
    let status = "Each event controls lead capture independently.";
    if (eventId !== "all") {
      const capture = store.getEvent(eventId).leadCapture;
      status = capture?.enabled === false ? "Lead capture is off for this event."
        : !capture?.guideEnabled && !capture?.expertEnabled ? "No follow-up offers enabled for this event."
        : `Capture on · ${capture?.fields?.length || 0} form fields`;
    }
    setText("lead-status", status);
    renderLeadRows(leads);
  }
  function render() {
    renderEventOptions();
    const report = getReport();
    currentRecords = report.records;
    currentLeads = report.leads;
    const summary = metrics.summarizeEvents(currentRecords);
    setText("range-caption", `${rangeText()} · browser time`);
    $("range-caption").title = "Demo date filters use this browser's local time zone.";
    $("date-filter").value = range;
    $("data-badge").textContent = sampleMode ? "SAMPLE PREVIEW" : "LOCAL DEMO";
    $("data-badge").classList.toggle("sample", sampleMode);
    $("sample-toggle").textContent = sampleMode ? "View real data" : "Preview sample";
    $("export-activity").disabled = !currentRecords.length;
    renderOverview(summary, currentLeads);
    renderPlay(summary);
    renderLeads(summary, currentLeads);
    renderLeadDetail();
  }
  function csvCell(value) {
    let text = String(value == null ? "" : value);
    if (/^\s*[=+@\-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }
  function downloadCsv(filename, headings, rows) {
    const content = [headings, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n");
    downloadRawCsv(filename, content);
  }
  function downloadRawCsv(filename, content) {
    const url = URL.createObjectURL(new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }
  function exportName(kind) {
    const eventPart = String(eventId === "all" ? "all-events" : eventId).toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 80);
    const rangePart = range === "custom" ? `${customFrom}-to-${customTo}` : range === "all" ? "all-time" : range;
    return `signal-stadium-${eventPart}-${rangePart}-${sampleMode ? "sample-" : ""}${kind}.csv`;
  }
  function exportActivity() {
    const rows = currentRecords.map(item => [item.at, item.eventId, item.type, metrics.isEngagementAction(item.type) ? "yes" : "no", item.properties?.participantId || "", item.properties?.heatId || "", item.properties?.promptId || "", item.properties?.source || "", JSON.stringify(item.properties || {})]);
    downloadCsv(exportName("events"), ["timestamp", "event_id", "type", "engagement_action", "participant_id", "heat_id", "prompt_id", "source", "properties_json"], rows);
  }
  function exportLeads() {
    if (!leadsStore?.toCSV) return;
    downloadRawCsv(exportName("leads"), leadsStore.toCSV(currentLeads));
  }

  document.querySelectorAll(".nav[data-view]").forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));
  $("event-filter").addEventListener("change", event => { eventId = event.target.value; promptPage = 0; leadPage = 0; render(); });
  $("date-filter").addEventListener("change", event => {
    const choice = event.target.value;
    if (choice === "custom") {
      lastRange = range;
      const today = new Date(), start = new Date(today); start.setDate(today.getDate() - 6);
      $("date-from").value = customFrom || dateKey(start);
      $("date-to").value = customTo || dateKey(today);
      $("custom-range").hidden = false;
      $("date-from").focus();
    } else { range = choice; lastRange = choice; $("custom-range").hidden = true; promptPage = 0; leadPage = 0; render(); }
  });
  $("cancel-range").addEventListener("click", () => { $("custom-range").hidden = true; $("date-filter").value = lastRange; });
  $("apply-range").addEventListener("click", () => {
    const from = $("date-from").value, to = $("date-to").value;
    if (!from || !to || from > to) { $("date-from").setCustomValidity("Choose a valid date range."); $("date-from").reportValidity(); $("date-from").setCustomValidity(""); return; }
    customFrom = from; customTo = to; range = "custom"; lastRange = range; $("custom-range").hidden = true; promptPage = 0; leadPage = 0; render();
  });
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
    if (event.key === "Escape" && !$("custom-range").hidden) { $("custom-range").hidden = true; $("date-filter").value = range; }
  });
  $("lead-detail-overlay").addEventListener("click", event => { if (event.target === $("lead-detail-overlay")) closeLeadDetail(); });
  $("lead-detail-close").addEventListener("click", closeLeadDetail);
  $("lead-detail-prev").addEventListener("click", () => { detailPage--; renderLeadDetail(); });
  $("lead-detail-next").addEventListener("click", () => { detailPage++; renderLeadDetail(); });
  $("sample-toggle").addEventListener("click", toggleSample);
  $("export-activity").addEventListener("click", exportActivity);
  $("export-leads").addEventListener("click", exportLeads);
  $("prompt-prev").addEventListener("click", () => { promptPage--; render(); });
  $("prompt-next").addEventListener("click", () => { promptPage++; render(); });
  $("lead-prev").addEventListener("click", () => { leadPage--; render(); });
  $("lead-next").addEventListener("click", () => { leadPage++; render(); });
  metrics.subscribe(render);
  store.subscribe(render);
  window.addEventListener("storage", render);
  window.addEventListener("resize", render);
  showView(activeView);
})();
