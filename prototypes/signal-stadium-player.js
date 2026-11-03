/* Player-facing browser demo. Camera preview stays local; lead requests stay in this browser. */
(() => {
  const store = window.SignalStadiumStore;
  const host = document.getElementById("screen");
  const eventName = document.getElementById("eventName");
  const PARTICIPANT_KEY = "signal-stadium-demo-participant-v1";
  const landingTracked = new Set();
  const resultsTracked = new Set();
  let eventId = store.getActiveEventId();
  let mode = "intro";
  let alias = "Player";
  let slot = 0;
  let cameraStream = null;
  let error = "";
  let leadIntent = "guide";
  let leadDraft = {fieldValues:{}, marketingOptIn:false};
  let leadPage = 0;
  let playerResult = null;
  let lastSignature = "";
  const previewStage = new URLSearchParams(location.search).get("stage");
  if (["build","lead"].includes(previewStage)) mode = previewStage;
  function getParticipantId() {
    try {
      let id = sessionStorage.getItem(PARTICIPANT_KEY);
      if (!id) { id = store.uid("participant"); sessionStorage.setItem(PARTICIPANT_KEY, id); }
      return id;
    } catch { return store.uid("participant"); }
  }
  const participantId = getParticipantId();
  const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  const button = (label, action, secondary=false) => `<button type="button" class="${secondary ? "secondary" : "primary"}" data-action="${action}"><span>${label}</span><span aria-hidden="true">↗</span></button>`;
  const config = () => store.getEvent(eventId);
  const state = () => store.getState(eventId);
  const secondsUntil = time => Math.max(0, Math.ceil((Number(time) - Date.now()) / 1000));
  const heatId = heat => `${eventId}:heat-${Number(heat) || 1}`;
  const preview = () => `<div class="preview"><div class="ghost" ${cameraStream ? "hidden" : ""}></div><video id="camera" autoplay muted playsinline ${cameraStream ? "" : "hidden"}></video><div class="frame"></div><span class="slot">${slot ? `SLOT ${String(slot).padStart(2,"0")}` : "LOCAL PREVIEW"}</span></div>`;

  function record(type, properties={}) {
    try { window.SignalStadiumMetrics?.record?.(eventId, type, {participantId, ...properties}); }
    catch { /* Analytics must never interrupt play. */ }
  }
  function recordLanding() {
    if (landingTracked.has(eventId)) return;
    landingTracked.add(eventId);
    record("landing_opened", {surface:"player_page"});
  }
  function leadSettings(event) {
    const raw = event.leadCapture || {};
    const legacyFields = [
      ...(raw.nameMode === "hidden" ? [] : [{id:"name", label:"Name", type:"text", required:raw.nameMode !== "optional"}]),
      {id:"email", label:"Work email", type:"email", required:true},
      ...(raw.companyMode === "hidden" ? [] : [{id:"company", label:"Company", type:"text", required:raw.companyMode === "required"}]),
    ];
    const source = Array.isArray(raw.fields) ? raw.fields : legacyFields;
    const seen = new Set();
    const fields = source.slice(0, 8).filter(field => {
      if (!field || typeof field.id !== "string" || !/^[a-z][a-z0-9-]{0,79}$/i.test(field.id)
        || !["text", "email", "tel"].includes(field.type) || !String(field.label || "").trim() || seen.has(field.id)) return false;
      seen.add(field.id); return true;
    }).map(field => ({id:field.id, label:String(field.label).trim().slice(0, 40), type:field.type, required:Boolean(field.required)}));
    return {
      enabled: raw.enabled !== false,
      guideEnabled: raw.guideEnabled !== false,
      expertEnabled: raw.expertEnabled !== false,
      fields,
      marketingOptIn: raw.marketingOptIn !== false,
    };
  }

  function viewFor(runtime) {
    if (mode !== "waiting") return mode;
    if (["countdown","locked"].includes(runtime.phase)) return "countdown";
    if (["hunt","playing","active"].includes(runtime.phase)) return "hunt";
    if (["review","judging"].includes(runtime.phase)) return "review";
    if (["result","winner","complete"].includes(runtime.phase)) return "result";
    return "waiting";
  }

  function leadPageSize() { return innerHeight < 540 ? 2 : 3; }
  function leadPageCount(settings) { return Math.max(1, Math.ceil(settings.fields.length / leadPageSize())); }
  function fieldMarkup(field) {
    const id = `lead-field-${field.id}`;
    const autocomplete = {name:"name", email:"email", company:"organization", phone:"tel", jobTitle:"organization-title"}[field.id] || "off";
    const inputmode = field.type === "email" ? "email" : field.type === "tel" ? "tel" : "text";
    const max = field.type === "email" ? 254 : field.type === "tel" ? 40 : 160;
    return `<div class="field"><label for="${id}">${escapeHTML(field.label)}${field.required ? " *" : " · optional"}</label><input id="${id}" name="field-${field.id}" data-lead-field="${field.id}" type="${field.type}" inputmode="${inputmode}" maxlength="${max}" autocomplete="${autocomplete}" ${field.required ? "required" : ""} value="${escapeHTML(leadDraft.fieldValues[field.id] || "")}"></div>`;
  }
  function leadForm(settings) {
    const request = leadIntent === "expert" ? "expert conversation" : "build guide";
    const eyebrow = leadIntent === "expert" ? "Request an expert conversation" : "Request a build guide";
    const pages = leadPageCount(settings);
    leadPage = Math.max(0, Math.min(leadPage, pages - 1));
    const pageFields = settings.fields.slice(leadPage * leadPageSize(), (leadPage + 1) * leadPageSize());
    const last = leadPage === pages - 1;
    const progress = pages > 1 ? `<span class="lead-step-count">${leadPage + 1} / ${pages}</span>` : "";
    const marketing = last && settings.marketingOptIn && settings.fields.some(field => field.type === "email")
      ? `<label class="check"><input name="marketingOptIn" type="checkbox" ${leadDraft.marketingOptIn ? "checked" : ""}><span>I'd also like occasional Twilio product updates by email. Optional.</span></label>` : "";
    const note = last ? `<p class="lead-note">Submitting asks the booth team to contact you about this ${request} using the details you provide. Demo only: no message is sent.</p>` : "";
    const previous = leadPage > 0 ? `<button type="button" class="lead-prev" data-action="previous-lead-fields">← Previous fields</button>` : "";
    return `<div class="card cardpad lead-card"><button type="button" class="back-link" data-action="build">← Back to products</button><div class="lead-heading"><p class="eyebrow">${eyebrow}</p>${progress}</div><h1 class="section-title">Stay in<br>touch.</h1><form id="leadForm"><div class="lead-fields-layout">${pageFields.map(fieldMarkup).join("")}</div>${marketing}${note}<p class="error" role="alert">${escapeHTML(error)}</p>${previous}<div class="actions">${button(last ? "SAVE DEMO REQUEST" : "CONTINUE", last ? "submit-lead" : "next-lead-fields")}</div></form></div>`;
  }

  function render(force=false) {
    if (mode === "intro") {
      const activeId = store.getActiveEventId();
      if (activeId !== eventId) { eventId = activeId; leadDraft = {fieldValues:{}, marketingOptIn:false}; leadPage = 0; }
    }
    const event = config();
    const lead = leadSettings(event);
    if (!lead.marketingOptIn || !lead.fields.some(field => field.type === "email")) leadDraft.marketingOptIn = false;
    if (mode === "lead" && (!lead.enabled || (leadIntent === "guide" && !lead.guideEnabled) || (leadIntent === "expert" && !lead.expertEnabled))) mode = "build";
    recordLanding();
    const runtime = state();
    if (mode === "waiting" && ["result","winner","complete"].includes(runtime.phase)) {
      playerResult = {heat:runtime.heat, winners:Array.isArray(runtime.winners) ? [...runtime.winners] : []};
      mode = "result";
      cameraStream?.getTracks().forEach(track => track.stop());
      cameraStream = null;
    }
    if (mode === "result" && runtime.phase === "result" && Number(runtime.heat) === Number(playerResult?.heat)) {
      playerResult.winners = Array.isArray(runtime.winners) ? [...runtime.winners] : [];
    }
    const view = viewFor(runtime);
    const prompt = runtime.promptSnapshot || event.prompts.find(p => p.id === runtime.promptId) || null;
    const huntSeconds = runtime.roundEndsAt ? secondsUntil(runtime.roundEndsAt) : Number(runtime.secondsLeft ?? prompt?.seconds ?? event.roundSeconds);
    const countdownSeconds = runtime.countdownEndsAt ? secondsUntil(runtime.countdownEndsAt) : Number(runtime.countdownValue ?? 3);
    if (view === "result") {
      const outcome = playerResult || runtime;
      const key = `${eventId}:${outcome.heat}`;
      if (!resultsTracked.has(key)) {
        resultsTracked.add(key);
        const winners = Array.isArray(outcome.winners) ? outcome.winners.map(Number) : [];
        record("result_viewed", {heatId:heatId(outcome.heat), heat:Number(outcome.heat) || 1, slot, won:winners.includes(slot), tie:winners.length > 1, noMatch:winners.length === 0});
      }
    }
    const liveView = ["waiting", "countdown", "hunt", "review", "result"].includes(view);
    const signature = JSON.stringify({eventId, revision:event.revision, view, mode, error, slot, leadIntent, leadPage, leadPageSize:leadPageSize(), camera:!!cameraStream, live: liveView ? {phase:runtime.phase, ready:runtime.readyCount, winners:runtime.winners, prompt:runtime.promptId, huntSeconds, countdownSeconds, result:playerResult} : null});
    if (!force && signature === lastSignature) return;
    lastSignature = signature;
    eventName.textContent = event.name;

    if (view === "intro") host.innerHTML = `<p class="eyebrow">The live camera challenge</p><h1 class="hero">FIND IT<br><em>FIRST.</em></h1><p class="sub">Step into the arena. The clue stays secret until everyone is ready.</p><div class="signal" aria-hidden="true"><div class="core"></div></div><div class="actions">${button("STEP INTO THE ARENA","intro-next")}<p class="caption">${event.minPlayers}–${event.maxPlayers} players per heat · camera optional for this preview</p></div>`;
    else if (view === "consent") host.innerHTML = `<div class="card cardpad"><p class="eyebrow">01 / Get ready</p><h1 class="section-title">Your moment<br>on the wall.</h1><p class="body">In the live game, your camera appears on the public arena screen while you play.</p><form id="consentForm"><div class="field"><label for="alias">Your screen name</label><input id="alias" name="alias" maxlength="20" value="${escapeHTML(alias === "Player" ? "" : alias)}" placeholder="e.g. Pixel Pilot" autocomplete="nickname"></div><label class="check"><input id="consent" type="checkbox" required><span>I agree to appear on the public game display during my heat.</span></label><p class="error">${escapeHTML(error)}</p><div class="actions">${button("CONTINUE","consent-next")}</div></form></div>`;
    else if (view === "preview") host.innerHTML = `<p class="eyebrow">02 / Camera check</p><h1 class="section-title">Take your place.</h1>${preview()}<p class="caption">${cameraStream ? "Local camera preview is on. This prototype does not broadcast it." : "Use your camera for a local preview, or continue with an illustrated demo feed."}</p><p class="error">${escapeHTML(error)}</p><div class="actions">${cameraStream ? button("I'M READY","ready") : button("ENABLE CAMERA PREVIEW","camera")}${cameraStream ? "" : button("USE DEMO FEED","ready",true)}</div>`;
    else if (view === "waiting") host.innerHTML = `<p class="eyebrow">03 / Your signal is in</p><h1 class="hero">READY<br><em>TO GO.</em></h1><div class="signal" aria-hidden="true"><div class="core"></div></div><div class="status">SLOT ${String(slot).padStart(2,"0")} · ${runtime.readyCount || 0} / ${event.maxPlayers} READY</div><p class="sub">Eyes on the arena screen. The clue appears only when the heat begins.</p><div class="actions">${button("VIEW ARENA","wall",true)}</div>`;
    else if (view === "countdown") host.innerHTML = `<p class="eyebrow">Heat ${escapeHTML(runtime.heat || 1)} · Stand by</p><div class="result-mark" style="color:#fff">${countdownSeconds || "GO"}</div><h1 class="hero" style="font-size:clamp(38px,10vw,62px)">CLUE<br><em>SEALED.</em></h1><p class="sub">Hold your camera steady. Everyone sees the challenge at GO.</p>`;
    else if (view === "hunt") host.innerHTML = `<p class="eyebrow">Heat ${escapeHTML(runtime.heat || 1)} · Find it first</p><h1 class="section-title" style="font-size:clamp(34px,8.6vw,54px)">${escapeHTML(prompt?.text || "FIND IT FIRST")}</h1><div class="status">${String(huntSeconds).padStart(2,"0")} SEC LEFT</div><div style="height:12px"></div>${preview()}<p class="caption">Bring the find into the camera guide and hold it steady.</p>`;
    else if (view === "review") host.innerHTML = `<p class="eyebrow">Heat ${escapeHTML(runtime.heat || 1)} · Checking</p><h1 class="hero">SIGNAL<br><em>FOUND?</em></h1><div class="signal" aria-hidden="true"><div class="core"></div></div><p class="sub">The referee is checking the first verified match. Close calls can be ties.</p>`;
    else if (view === "result") {
      const outcome = playerResult || runtime;
      const winners = Array.isArray(outcome.winners) ? outcome.winners.map(Number) : [];
      const won = Boolean(slot && winners.includes(slot));
      const tie = winners.length > 1;
      host.innerHTML = `<p class="eyebrow">Heat ${escapeHTML(outcome.heat || 1)} · Result</p><div class="result-mark">${won ? "✦" : "↗"}</div><h1 class="hero">${won ? (tie ? "CO-<br><em>WINNER.</em>" : "YOU<br><em>WON.</em>") : winners.length ? "NICE<br><em>RUN.</em>" : "NEXT<br><em>TIME.</em>"}</h1><p class="sub">${won ? "Your signal lit up the stadium." : "Every heat starts with a new surprise."}</p><div class="actions">${button("SEE HOW TWILIO BUILT THIS","build")}</div>`;
    }
    else if (view === "build") {
      const ctas = [];
      if (lead.enabled && lead.guideEnabled) ctas.push(button("GET THE BUILD GUIDE", "guide"));
      if (lead.enabled && lead.expertEnabled) ctas.push(button("TALK TO A TWILIO EXPERT", "expert", ctas.length > 0));
      if (!ctas.length) ctas.push(button("PLAY ANOTHER HEAT", "replay"));
      host.innerHTML = `<p class="eyebrow">Behind the signal</p><h1 class="section-title">A game built<br>to connect.</h1><p class="body">The arena is a quick look at what customer experiences can do with Twilio.</p><div class="stack"><div class="stack-row"><i class="stack-dot"></i><b>Video</b><span>Players appear together in the live arena.</span></div><div class="stack-row"><i class="stack-dot" style="background:#8ab8ff;box-shadow:0 0 14px #8ab8ff66"></i><b>Messaging</b><span>Messaging can let the crowd choose the next category between heats.</span></div><div class="stack-row"><i class="stack-dot" style="background:#f7f8ff;box-shadow:0 0 14px #fff5"></i><b>Segment</b><span>Engagement becomes useful event insights.</span></div></div><div class="actions">${ctas.join("")}</div>`;
    }
    else if (view === "lead") host.innerHTML = leadForm(lead);
    else if (view === "thanks") host.innerHTML = `<p class="eyebrow">Request saved</p><div class="result-mark">✓</div><h1 class="hero">YOU'RE<br><em>ALL SET.</em></h1><p class="sub">Your ${leadIntent === "expert" ? "expert conversation" : "build guide"} request is saved on this device for the demo. No message or email was sent.</p><div class="actions">${button("PLAY ANOTHER HEAT", "replay")}</div>`;
    if (cameraStream) {
      const video = document.getElementById("camera");
      if (video) { video.srcObject = cameraStream; video.play().catch(() => {}); }
    }
  }

  async function enableCamera() {
    error = "";
    if (!navigator.mediaDevices?.getUserMedia) { error = "Camera preview is unavailable here. Use the demo feed."; record("camera_failed", {reason:"unavailable"}); render(true); return; }
    try { cameraStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:"user"},audio:false}); render(true); }
    catch { error = "Camera access was blocked. You can still use the demo feed."; record("camera_failed", {reason:"permission_or_device"}); render(true); }
  }

  function syncLeadForm() {
    const form = document.getElementById("leadForm");
    if (!form) return;
    form.querySelectorAll("[data-lead-field]").forEach(input => { leadDraft.fieldValues[input.dataset.leadField] = input.value; });
    const marketing = form.elements.namedItem("marketingOptIn");
    if (marketing) leadDraft.marketingOptIn = marketing.checked;
  }
  function validateLeadForm() {
    const form = document.getElementById("leadForm");
    if (!form) return false;
    form.querySelectorAll("[data-lead-field]").forEach(input => {
      input.setCustomValidity("");
      if (input.type === "tel" && input.value.trim()) {
        const value = input.value.trim(), digits = value.replace(/\D/g, "");
        if (!/^[+0-9().\-\s]+$/.test(value) || digits.length < 7 || digits.length > 20) input.setCustomValidity("Enter a phone number with at least seven digits.");
      }
    });
    return form.reportValidity();
  }
  function rememberLeadField(event) {
    if (!event.target.closest("#leadForm")) return;
    const input = event.target;
    if (input.dataset.leadField) { leadDraft.fieldValues[input.dataset.leadField] = input.value; input.setCustomValidity(""); }
    else if (input.name === "marketingOptIn") leadDraft.marketingOptIn = input.checked;
  }
  host.addEventListener("input", rememberLeadField);
  host.addEventListener("change", rememberLeadField);
  host.addEventListener("click", async event => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    if (action === "intro-next") { mode = "consent"; error = ""; render(true); }
    else if (action === "consent-next") {
      const form = document.getElementById("consentForm");
      if (!form.reportValidity()) return;
      alias = form.elements.alias.value.trim() || "Player";
      mode = "preview"; error = ""; render(true);
    }
    else if (action === "camera") await enableCamera();
    else if (action === "ready") {
      const runtime = state();
      const eventConfig = config();
      if (runtime.phase !== "lobby") { error = "A heat is underway. Join when the next lobby opens."; render(true); return; }
      if ((Number(runtime.readyCount) || 0) >= eventConfig.maxPlayers) { error = "This heat is full. Join the next one."; render(true); return; }
      const proposedSlot = Math.min(eventConfig.maxPlayers, (Number(runtime.readyCount) || 0) + 1);
      const count = Math.max(Number(runtime.readyCount) || 0, proposedSlot);
      const saved = store.setState(eventId, {readyCount:count});
      if (!saved.ok) { error = saved.error || "Could not join this heat."; render(true); return; }
      store.sendCommand(eventId, "setReady", {count});
      slot = proposedSlot;
      record("player_joined", {heatId:heatId(runtime.heat), heat:Number(runtime.heat) || 1, slot, cameraPreview:!!cameraStream});
      mode = "waiting"; render(true);
    }
    else if (action === "wall") location.href = "signal-stadium-wall.html";
    else if (action === "build") {
      if (mode === "lead") syncLeadForm();
      if (mode === "result") {
        const heat = Number(playerResult?.heat || state().heat) || 1;
        record("cta_opened", {surface:"product_explainer", heatId:heatId(heat), heat, slot});
      }
      mode = "build"; error = ""; render(true);
    }
    else if (action === "guide" || action === "expert") {
      const settings = leadSettings(config());
      if (!settings.enabled || (action === "guide" && !settings.guideEnabled) || (action === "expert" && !settings.expertEnabled)) { mode = "build"; render(true); return; }
      const heat = Number(playerResult?.heat || state().heat) || 1;
      record("lead_form_opened", {intent:action, heatId:heatId(heat), heat, slot});
      leadIntent = action; leadPage = 0; mode = "lead"; error = ""; render(true);
    }
    else if (action === "next-lead-fields") {
      if (!validateLeadForm()) return;
      syncLeadForm();
      leadPage = Math.min(leadPage + 1, leadPageCount(leadSettings(config())) - 1);
      error = ""; render(true);
    }
    else if (action === "previous-lead-fields") {
      syncLeadForm();
      leadPage = Math.max(0, leadPage - 1);
      error = ""; render(true);
    }
    else if (action === "submit-lead") {
      const settings = leadSettings(config());
      if (!validateLeadForm()) return;
      syncLeadForm();
      const firstContact = settings.fields.findIndex(field => field.type === "email" || field.type === "tel");
      const hasContact = settings.fields.some(field => (field.type === "email" || field.type === "tel") && String(leadDraft.fieldValues[field.id] || "").trim());
      const hasEmail = settings.fields.some(field => field.type === "email" && String(leadDraft.fieldValues[field.id] || "").trim());
      if (!hasContact && firstContact >= 0) {
        leadPage = Math.floor(firstContact / leadPageSize());
        error = "Add an email or phone number so the booth team can follow up.";
        render(true); return;
      }
      if (leadDraft.marketingOptIn && !hasEmail) {
        error = "Add an email for product updates, or leave that choice unchecked.";
        render(true); return;
      }
      const heat = Number(playerResult?.heat || state().heat) || 1;
      const payload = {fieldValues:{...leadDraft.fieldValues}, marketingOptIn:leadDraft.marketingOptIn,
        intent:leadIntent, participantId, heatId:heatId(heat), heat, slot};
      const saved = window.SignalStadiumLeads?.submit?.(eventId, payload);
      if (!saved?.ok) {
        const missing = settings.fields.findIndex(field => field.required && !String(leadDraft.fieldValues[field.id] || "").trim());
        if (missing >= 0) leadPage = Math.floor(missing / leadPageSize());
        error = saved?.error || "Could not save this request in the browser."; render(true); return;
      }
      mode = "thanks"; error = ""; render(true);
    }
    else if (action === "replay") {
      mode = "intro"; slot = 0; playerResult = null; error = "";
      leadDraft = {fieldValues:{}, marketingOptIn:false}; leadPage = 0;
      render(true);
    }
  });
  store.subscribe(() => render());
  setInterval(() => { if (mode === "waiting") render(); }, 300);
  window.addEventListener("resize", () => { if (mode === "lead") { syncLeadForm(); render(true); } });
  window.addEventListener("pagehide", () => { cameraStream?.getTracks().forEach(track => track.stop()); });
  render(true);
})();
