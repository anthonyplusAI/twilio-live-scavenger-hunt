const slug = decodeURIComponent(location.pathname.split('/')[2] || 'demo');
const apiBase = `/api/e/${encodeURIComponent(slug)}`;
const arenaUrl = `/e/${encodeURIComponent(slug)}/arena`;
const voteUrl = `/e/${encodeURIComponent(slug)}/vote`;
const sessionKey = `signal-stadium-player:${slug}`;
const demoMode = new URLSearchParams(location.search).get('demo');
const isResultDemo = demoMode === 'win' || demoMode === 'lose' || demoMode === 'tie' || demoMode === 'no-match';
const screen = document.getElementById('screen');
const eventName = document.getElementById('eventName');
const modeLabel = document.getElementById('modeLabel');
const sessionDialog = document.getElementById('sessionDialog');
for (const link of document.querySelectorAll('[data-arena-link]')) {
  link.href = arenaUrl;
  link.target = '_blank';
  link.rel = 'noopener';
}

const app = {
  event: null,
  state: null,
  serverOffset: 0,
  token: sessionStorage.getItem(sessionKey),
  player: null,
  view: 'intro',
  alias: '',
  consent: false,
  camera: null,
  cameraVideo: null,
  media: null,
  mediaMode: null,
  mediaBusy: null,
  resultReleaseTimer: null,
  resultCameraStopAt: null,
  frameTimer: null,
  frameBusy: false,
  error: '',
  connection: 'connecting',
  leadIntent: 'guide',
  leadPage: 0,
  leadDraft: { fieldValues: {}, marketingOptIn: false },
  leadResult: null,
  outcome: null,
  resultRevealSeen: new Set(),
  idleSince: null,
  idleKey: null,
  idlePromptAt: null,
  sessionDialogMode: null,
  lastRender: '',
  lastPayloadAt: 0,
  activity: new Set(),
};

const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const button = (label, action, secondary = false, disabled = false) => `<button type="button" class="${secondary ? 'secondary' : 'primary'}" data-action="${action}" ${disabled ? 'disabled' : ''}><span>${label}</span><span aria-hidden="true">↗</span></button>`;
const now = () => Date.now() + app.serverOffset;
const timeLeft = deadline => deadline ? Math.max(0, Math.ceil((new Date(deadline).getTime() - now()) / 1000)) : 0;
const pad = number => String(number || 0).padStart(2, '0');
const visibleRoster = () => Array.isArray(app.state?.roster) ? app.state.roster : [];
const rosterPlayer = () => visibleRoster().find(entry => entry.id === app.player?.id);
const hasSlot = () => Boolean(rosterPlayer()?.slot) && !['queued', 'left'].includes(app.player?.status);
const phase = () => app.state?.phase || 'lobby';

async function request(path, { method = 'GET', body, auth = false, headers = {} } = {}) {
  const options = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (auth && app.token) options.headers.Authorization = `Bearer ${app.token}`;
  if (body !== undefined) {
    if (body instanceof Blob) {
      options.body = body;
      options.headers['Content-Type'] = body.type || 'image/jpeg';
    } else {
      options.body = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
    }
  }
  const response = await fetch(`${apiBase}${path}`, options);
  let value;
  try { value = await response.json(); } catch { value = {}; }
  if (!response.ok) {
    const error = new Error(value.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = value.code;
    if (error.code === 'player_kicked') queueMicrotask(sessionRemoved);
    throw error;
  }
  return value;
}

function activity(type) {
  if (isResultDemo) return;
  const onceKey = type === 'landing_opened' ? type : type === 'result_viewed' ? `${type}:${app.state?.heat}` : null;
  if (onceKey && app.activity.has(onceKey)) return;
  if (onceKey) app.activity.add(onceKey);
  request('/activity', { method: 'POST', body: { type } }).catch(() => {});
}

function applyState(payload) {
  if (!payload || !payload.state) return;
  const hadSlot = hasSlot();
  if (payload.serverTime) app.serverOffset = new Date(payload.serverTime).getTime() - Date.now();
  if (payload.event) app.event = payload.event;
  app.state = payload.state;
  app.lastPayloadAt = Date.now();
  app.connection = 'live';
  const roster = rosterPlayer();
  if (roster && app.player) app.player = { ...app.player, ...roster, heat: app.state.heat };
  if (app.player && app.view === 'live') {
    if (!hasSlot() && (app.media || app.camera)) releaseMedia(true);
    if (!hadSlot && hasSlot() && !app.camera && phase() !== 'result')
      app.error = 'Your spot is open. Reconnect your camera to join the wall.';
    if (hasSlot() && !app.outcome && app.camera && !app.media && phase() !== 'result') ensureMediaReady().catch(showError);
    if (phase() === 'result' && hasSlot() && !app.outcome) {
      app.outcome = { heat: app.state.heat, winners: [...(app.state.winners || [])] };
      activity('result_viewed');
    }
    if (phase() === 'result' && app.outcome?.heat === app.state.heat) {
      app.outcome.winners = [...(app.state.winners || [])];
      app.outcome.winnerNames = visibleRoster()
        .filter(player => app.outcome.winners.includes(player.id))
        .map(player => player.alias);
    }
    if (app.outcome && phase() === 'result' && app.state.heat === app.outcome.heat) scheduleResultRelease();
    else if (app.outcome && app.state.heat !== app.outcome.heat) releaseMedia(true);
  }
  render();
  updateIdleCheck();
}

function showError(error) {
  if (app.view === 'removed') return;
  app.error = error?.message || 'Something went wrong. Please try again.';
  render(true);
}

function leadSettings() {
  const raw = app.event?.leadCapture || {};
  const fallback = [
    { id: 'name', label: 'Name', type: 'text', required: true },
    { id: 'email', label: 'Work email', type: 'email', required: true },
    { id: 'company', label: 'Company', type: 'text', required: false },
  ];
  const fields = (Array.isArray(raw.fields) ? raw.fields : fallback).slice(0, 8).filter(field =>
    field && /^[a-z][a-z0-9-]{0,79}$/i.test(field.id) && ['text', 'email', 'tel'].includes(field.type) && field.label
  ).map(field => ({ id: field.id, label: String(field.label), type: field.type, required: !!field.required }));
  return {
    enabled: raw.enabled !== false,
    guideEnabled: raw.guideEnabled !== false,
    expertEnabled: raw.expertEnabled !== false,
    marketingOptIn: raw.marketingOptIn !== false,
    fields,
  };
}

function currentView() {
  if (app.view !== 'live') return app.view;
  if (app.outcome) return 'result';
  if (app.player?.status === 'finished' || (app.player?.heat && app.state?.heat > app.player.heat)) return 'complete';
  if (!hasSlot()) return 'queued';
  if (phase() === 'countdown' || phase() === 'locked') return 'countdown';
  if (phase() === 'hunt' || phase() === 'active') return 'hunt';
  if (phase() === 'review' || phase() === 'judging') return 'review';
  if (phase() === 'result') return 'result';
  return 'waiting';
}

function resultConfetti() {
  return `<div class="result-confetti" aria-hidden="true">${Array.from({ length: 22 }, (_, index) => {
    const x = (index * 47) % 100;
    const delay = (index * 7) % 10;
    const drift = ((index * 19) % 61) - 30;
    return `<i style="--x:${x}%;--delay:${delay * 70}ms;--drift:${drift}px;--spin:${360 + index * 23}deg"></i>`;
  }).join('')}</div>`;
}

function resultMarkup(winners, heat) {
  const won = winners.includes(app.player?.id);
  const tied = winners.length > 1;
  const noMatch = winners.length === 0;
  const variant = won ? 'win' : noMatch ? 'no-match' : 'lose';
  const revealKey = `${heat}:${[...winners].sort().join(',')}:${variant}`;
  const entering = !app.resultRevealSeen.has(revealKey);
  app.resultRevealSeen.add(revealKey);
  const winnerName = app.outcome?.winnerNames?.[0];
  const label = won ? (tied ? 'TIED FOR FIRST' : 'FIRST FIND') : noMatch ? 'NO VERIFIED FIND' : 'NOT THIS ROUND';
  const heading = won ? (tied ? 'YOU TIED<br><em>FOR FIRST.</em>' : 'YOU FOUND<br><em>IT FIRST.</em>') : noMatch ? 'NO MATCH<br><em>THIS TIME.</em>' : 'NICE<br><em>HUNT.</em>';
  const note = won ? (tied ? 'A close finish. You share the spotlight.' : 'The arena is celebrating your find.') : noMatch ? 'New clue, fresh chance. Come back for another heat.' : `${winnerName ? `${escapeHtml(winnerName)} found it first. ` : ''}There is always another clue to chase.`;
  const emblem = won
    ? `<svg viewBox="0 0 160 160" aria-hidden="true"><path d="M38 34h84v40c0 37-20 59-42 59S38 111 38 74V34Z" fill="currentColor"/><path d="M38 49H19v19c0 22 14 35 34 35M122 49h19v19c0 22-14 35-34 35" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round"/><path d="M80 132v15M55 148h50" stroke="currentColor" stroke-width="10" stroke-linecap="round"/><path d="m80 50 6 13 14 2-10 10 3 14-13-7-13 7 3-14-10-10 14-2 6-13Z" fill="#fff"/></svg>`
    : `<svg viewBox="0 0 160 160" aria-hidden="true"><circle cx="80" cy="80" r="58" fill="none" stroke="currentColor" stroke-width="5"/><circle cx="80" cy="80" r="38" fill="none" stroke="currentColor" stroke-width="5" opacity=".65"/><circle cx="80" cy="80" r="16" fill="none" stroke="currentColor" stroke-width="5" opacity=".4"/><path d="m97 63 35-35m-12 0h12v12" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `<div class="result-scene result-${variant} ${entering ? 'result-entering' : ''}">${won ? resultConfetti() : ''}<div class="result-halo" aria-hidden="true"></div><p class="result-kicker">HEAT ${pad(heat)} <span aria-hidden="true">/</span> ${label}</p><div class="result-emblem">${emblem}</div><h1 class="result-title">${heading}</h1><p class="result-note">${note}</p><div class="result-actions">${button('SEE HOW TWILIO BUILT THIS', 'build')}</div>${isResultDemo ? '<span class="result-demo-note">Visual preview · no live game data</span>' : ''}</div>`;
}

function preview() {
  const slot = rosterPlayer()?.slot ?? app.player?.slot;
  return `<div class="preview ${app.camera ? 'has-camera' : ''}"><div class="preview-placeholder" ${app.camera ? 'hidden' : ''}>${portraitArt()}<span class="camera-waiting">${cameraIcon()}<span>Camera off</span></span></div><video id="camera" autoplay muted playsinline ${app.camera ? '' : 'hidden'}></video><div class="frame" aria-hidden="true"><i></i><i></i><i></i><i></i></div><span class="preview-topline"><b></b>${app.camera ? 'CAMERA ON' : 'CAMERA CHECK'}</span><span class="slot">${slot ? `SLOT ${pad(slot)}` : 'YOUR CAMERA'}</span></div>`;
}

function cameraIcon() {
  return '<svg viewBox="0 0 28 22" fill="none" aria-hidden="true"><rect x="1.5" y="4.5" width="17" height="13" rx="3" stroke="currentColor" stroke-width="2"/><path d="m19 8 7-3v12l-7-3" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="10" cy="11" r="2.3" fill="currentColor"/></svg>';
}

function portraitArt() {
  return '<svg class="portrait-art" viewBox="0 0 180 260" fill="none" aria-hidden="true" focusable="false"><defs><linearGradient id="portrait-face" x1="65" y1="64" x2="119" y2="171" gradientUnits="userSpaceOnUse"><stop stop-color="#E3EAFA"/><stop offset=".55" stop-color="#A9B9D9"/><stop offset="1" stop-color="#697DA8"/></linearGradient><linearGradient id="portrait-jacket" x1="31" y1="177" x2="147" y2="265" gradientUnits="userSpaceOnUse"><stop stop-color="#7087AF"/><stop offset=".56" stop-color="#354B75"/><stop offset="1" stop-color="#182943"/></linearGradient></defs><path d="M72 158h36v41H72z" fill="#8296BD"/><path d="M19 260v-21c0-39 27-68 71-68s71 29 71 68v21H19Z" fill="url(#portrait-jacket)"/><path d="m72 180 18 26 18-26-10-11H82l-10 11Z" fill="#CED8ED"/><path d="m70 181-13 11 14 68h19l-20-79Zm40 0 13 11-14 68H90l20-79Z" fill="#243A62" fill-opacity=".62"/><ellipse cx="90" cy="112" rx="38" ry="47" fill="url(#portrait-face)"/><path d="M51 111c-3-18 0-39 15-52 12-11 31-16 48-9 22 8 33 31 28 63-9-6-14-18-16-31-11 9-29 14-47 13-11 0-19-3-25-8l-3 24Z" fill="#23395F"/><path d="M55 105c-6 2-8 9-5 17 3 7 8 11 13 9l-8-26Zm70 1c6 2 8 9 5 17-3 7-8 11-13 9l8-26Z" fill="#8297BF"/><path d="M73 126c4 3 9 3 13 0m18 0c4 3 9 3 13 0" stroke="#667DAA" stroke-width="2" stroke-linecap="round"/><path d="M84 143c4 3 9 4 13 0" stroke="#7187AD" stroke-width="2" stroke-linecap="round"/></svg>';
}

function playerVisual(label = 'YOUR PLAYER SPOT') {
  return `<div class="player-visual" aria-hidden="true"><div class="player-visual-card"><div class="player-visual-top">${cameraIcon()}<span>PHONE CAMERA</span><i></i></div><div class="player-visual-person">${portraitArt()}</div><div class="player-visual-bottom"><span>01</span><strong>${label}</strong></div></div></div>`;
}

// Keep mobile pagination stable when the virtual keyboard changes viewport height.
function leadPageSize() { return innerWidth <= 600 || innerHeight < 680 ? 2 : 3; }
let renderedLeadPageSize = leadPageSize();
function leadPages(settings) { return Math.max(1, Math.ceil(settings.fields.length / leadPageSize())); }
function fieldMarkup(field) {
  const id = `lead-${field.id}`;
  const autocomplete = ({ name: 'name', email: 'email', company: 'organization', phone: 'tel', jobTitle: 'organization-title' })[field.id] || 'off';
  return `<div class="field"><label for="${id}">${escapeHtml(field.label)}${field.required ? ' *' : ' · optional'}</label><input id="${id}" data-lead-field="${field.id}" type="${field.type}" autocomplete="${autocomplete}" maxlength="${field.type === 'email' ? 254 : field.type === 'tel' ? 40 : 160}" ${field.required ? 'required' : ''} value="${escapeHtml(app.leadDraft.fieldValues[field.id] || '')}"></div>`;
}
function leadMarkup(settings) {
  const pages = leadPages(settings);
  app.leadPage = Math.max(0, Math.min(app.leadPage, pages - 1));
  const fields = settings.fields.slice(app.leadPage * leadPageSize(), (app.leadPage + 1) * leadPageSize());
  const final = app.leadPage === pages - 1;
  const hasEmailField = settings.fields.some(field => field.type === 'email');
  const marketing = final && settings.marketingOptIn && hasEmailField
    ? `<label class="check"><input type="checkbox" name="marketingOptIn" ${app.leadDraft.marketingOptIn ? 'checked' : ''}><span>Yes, send me occasional Twilio product updates by email. Optional.</span></label>` : '';
  return `<div class="card cardpad lead-card"><button type="button" class="back-link" data-action="build">← Back to products</button><div class="lead-heading"><p class="eyebrow">${app.leadIntent === 'guide' ? 'Build guide' : 'Twilio expert'}</p><span class="lead-step-count">${app.leadPage + 1} / ${pages}</span></div><h1 class="section-title">Stay in<br>touch.</h1><form id="leadForm"><div class="lead-fields-layout">${fields.map(fieldMarkup).join('')}</div>${marketing}${final ? '<p class="lead-note">The booth team will use these details for your request. Product updates are a separate choice.</p>' : ''}<p class="error" role="alert">${escapeHtml(app.error)}</p>${app.leadPage ? '<button type="button" class="lead-prev" data-action="lead-previous">← Previous fields</button>' : ''}<div class="actions">${button(final ? 'SEND REQUEST' : 'CONTINUE', final ? 'lead-submit' : 'lead-next')}</div></form></div>`;
}

function render(force = false) {
  if (!app.event || !app.state) return;
  const lead = leadSettings();
  if (app.view === 'lead' && (!lead.enabled || (app.leadIntent === 'guide' && !lead.guideEnabled) || (app.leadIntent === 'expert' && !lead.expertEnabled))) app.view = 'build';
  const view = currentView();
  const signature = JSON.stringify({ view, error: app.error, event: app.event, player: app.player?.id, slot: rosterPlayer()?.slot ?? app.player?.slot, status: app.player?.status, phase: phase(), heat: app.state.heat, ready: app.state.readyCount, prompt: app.state.prompt, winners: app.outcome?.winners || app.state.winners, camera: !!app.camera, media: !!app.media, leadPage: app.leadPage, leadIntent: app.leadIntent, connection: app.connection });
  if (!force && signature === app.lastRender) { updateClock(); return; }
  app.lastRender = signature;
  screen.dataset.view = view;
  const customEventName = String(app.event.name || '').trim();
  eventName.textContent = customEventName.toUpperCase() === 'LIVE SCAVENGER HUNT' ? '' : customEventName;
  eventName.hidden = !eventName.textContent;
  modeLabel.textContent = isResultDemo ? 'Visual preview · no live camera' : app.event.mediaMode === 'twilio' ? 'Powered by Twilio Video' : app.event.mediaMode === 'rehearsal' ? 'Local rehearsal · camera snapshots' : 'Waiting for booth setup';
  $('leaveButton').hidden = isResultDemo || !['queued', 'waiting', 'countdown', 'hunt', 'review'].includes(view);

  if (view === 'intro') {
    screen.innerHTML = `<p class="eyebrow">A live camera game</p><h1 class="hero intro-title" aria-label="Live Scavenger Hunt">LIVE<br>SCAVENGER<br><em>HUNT.</em></h1><p class="sub">Find it. Show it. Beat the clock.</p>${playerVisual()}<div class="actions">${button('JOIN THE GAME', 'intro-next')}<p class="caption">${app.event.minPlayers || 2}–${app.event.maxPlayers || 6} players per heat · ${app.event.roundSeconds || 20} seconds per challenge</p></div>`;
  } else if (view === 'consent') {
    screen.innerHTML = `<div class="card cardpad"><p class="eyebrow">01 / Get ready</p><h1 class="section-title">Your moment<br>on the wall.</h1><p class="body">Your camera appears on the public booth display during your heat. The game may check camera images to judge a match.</p><form id="consentForm"><div class="field"><label for="alias">Screen name</label><input id="alias" name="alias" maxlength="20" autocomplete="nickname" placeholder="e.g. Pixel Pilot" value="${escapeHtml(app.alias)}" required></div><label class="check"><input id="consent" type="checkbox" required ${app.consent ? 'checked' : ''}><span>I agree to appear on the public game display while I play.</span></label><p class="error" role="alert">${escapeHtml(app.error)}</p><div class="actions">${button('CONTINUE', 'consent-next')}</div></form></div>`;
  } else if (view === 'preview') {
    screen.innerHTML = `<p class="eyebrow">02 / Camera check</p><h1 class="section-title">Take your place.</h1>${preview()}<p class="caption">${app.camera ? 'You look ready. Keep this page open while your heat runs.' : 'Allow camera access to play on the arena wall.'}</p><p class="error" role="alert">${escapeHtml(app.error)}</p><div class="actions">${app.camera ? button(app.event.mediaMode === 'unconfigured' ? 'WAITING FOR BOOTH SETUP' : 'JOIN WITH CAMERA', 'join', false, app.event.mediaMode === 'unconfigured') : button('ENABLE CAMERA', 'camera')}<a class="secondary text-link" href="${voteUrl}"><span>Watch and vote instead</span><span aria-hidden="true">↗</span></a></div>`;
  } else if (view === 'queued') {
    screen.innerHTML = `<p class="eyebrow">You’re in line</p><h1 class="hero">NEXT<br><em>UP.</em></h1>${playerVisual('WAITING FOR A SPOT')}<div class="status">NEXT HEAT · ${app.state.queuedCount || 1} QUEUED</div><p class="sub">Your camera is off while you wait. Reconnect it when a spot opens.</p><p class="error" role="alert">${escapeHtml(app.error)}</p>`;
  } else if (view === 'waiting') {
    const slot = rosterPlayer()?.slot ?? app.player?.slot;
    screen.innerHTML = `<p class="eyebrow">03 / Your spot is set</p><h1 class="hero">READY<br><em>TO GO.</em></h1>${preview()}<div class="status">SLOT ${pad(slot)} · ${app.state.readyCount || 0} / ${app.event.maxPlayers || 6} READY</div><p class="caption">${app.media ? 'You are live on the arena wall. The clue appears at GO.' : app.camera ? 'Connecting your camera to the arena…' : 'Your spot is open. Turn your camera back on to play.'}</p><p class="error" role="alert">${escapeHtml(app.error)}</p>${app.media ? '' : `<div class="actions">${button(app.camera ? 'RETRY CONNECTION' : 'RECONNECT CAMERA', 'retry-media', true)}</div>`}`;
  } else if (view === 'countdown') {
    screen.innerHTML = `<p class="eyebrow">Heat ${pad(app.state.heat)} · Stand by</p><div class="result-mark countdown-figure" data-clock>3</div><h1 class="hero sealed-title">CLUE<br><em>SEALED.</em></h1><p class="sub">Everyone sees the challenge at GO. Hold your camera steady.</p>`;
  } else if (view === 'hunt') {
    // The server omits prompt before GO. Never infer it from an event deck or a URL.
    const clue = app.state.prompt?.text || 'LOOK AT THE ARENA';
    const clueSize = clue.length > 80 ? 'is-extra-long' : clue.length > 50 ? 'is-long' : '';
    const reconnect = !app.camera || !app.media;
    screen.innerHTML = `<p class="eyebrow">Heat ${pad(app.state.heat)} · Find it first</p><h1 class="section-title hunt-prompt ${clueSize}">${escapeHtml(clue)}</h1><div class="status"><span data-clock>00</span> SEC LEFT</div><div class="hunt-preview">${preview()}</div>${reconnect ? '<button type="button" class="hunt-reconnect" data-action="retry-media">Reconnect camera ↗</button>' : '<p class="caption">Bring your find into the camera guide and hold it steady.</p>'}<p class="error" role="alert">${escapeHtml(app.error)}</p>`;
  } else if (view === 'review') {
    screen.innerHTML = `<p class="eyebrow">Heat ${pad(app.state.heat)} · Checking</p><h1 class="hero">DID YOU<br><em>FIND IT?</em></h1>${playerVisual('REVIEWING FINDS')}<p class="sub">The judge is checking each find. Close calls can be ties.</p>${!app.camera || !app.media ? '<button type="button" class="hunt-reconnect" data-action="retry-media">Reconnect camera ↗</button>' : ''}`;
  } else if (view === 'result') {
    const winners = app.outcome?.winners || app.state.winners || [];
    screen.innerHTML = resultMarkup(winners, app.outcome?.heat || app.state.heat);
  } else if (view === 'complete') {
    screen.innerHTML = `<p class="eyebrow">Heat ${pad(app.player?.heat)} · Complete</p><div class="result-mark">↗</div><h1 class="hero">NICE<br><em>RUN.</em></h1><p class="sub">Your heat has finished. See what you can build with Twilio.</p><div class="actions">${button('SEE HOW TWILIO BUILT THIS', 'build')}</div>`;
  } else if (view === 'build') {
    const ctas = [];
    if (lead.enabled && lead.guideEnabled) ctas.push(button('GET THE BUILD GUIDE', 'guide'));
    if (lead.enabled && lead.expertEnabled) ctas.push(button('TALK TO A TWILIO EXPERT', 'expert', ctas.length > 0));
    screen.innerHTML = `<p class="eyebrow">Behind the hunt</p><h1 class="section-title">A game built<br>to connect.</h1><p class="body">This live scavenger hunt is a glimpse of what your team can build with Twilio.</p><div class="stack"><div class="stack-row"><i class="stack-dot"></i><b>Video</b><span>Phone cameras become a live shared arena.</span></div><div class="stack-row"><i class="stack-dot dot-blue"></i><b>Messaging</b><span>SMS or WhatsApp can let the crowd choose a category.</span></div><div class="stack-row"><i class="stack-dot dot-white"></i><b>Segment</b><span>Event signals become useful engagement insights.</span></div></div><div class="actions">${ctas.join('')}${button('PLAY ANOTHER HEAT', 'replay', true)}</div>`;
  } else if (view === 'lead') {
    screen.innerHTML = leadMarkup(lead);
  } else if (view === 'thanks') {
    screen.innerHTML = `<p class="eyebrow">Request received</p><div class="result-mark">✓</div><h1 class="hero">YOU'RE<br><em>ALL SET.</em></h1><p class="sub">Your ${app.leadIntent === 'expert' ? 'expert conversation' : 'build guide'} request is saved for this event. Visit the Twilio booth to keep the conversation going.</p><div class="actions">${button('PLAY ANOTHER HEAT', 'replay')}</div>`;
  } else if (view === 'left') {
    screen.innerHTML = `<p class="eyebrow">You're out of this heat</p><div class="result-mark">↗</div><h1 class="hero">CAMERA<br><em>OFF.</em></h1><p class="sub">Your spot is open for someone else. You can join another heat when you're ready.</p><div class="actions">${button('JOIN AGAIN', 'rejoin')}</div>`;
  } else if (view === 'removed') {
    screen.innerHTML = `<p class="eyebrow">Session ended</p><div class="result-mark">×</div><h1 class="hero">YOU'VE<br><em>LEFT THE GAME.</em></h1><p class="sub">Booth staff removed this player from the heat. Your camera is off. Please see a booth team member if you have questions.</p>`;
  }
  attachCameraPreview();
  updateClock();
}

function attachCameraPreview() {
  const video = $('camera');
  if (video && app.camera) {
    video.srcObject = app.camera;
    video.play().catch(() => {});
  }
}
function updateClock() {
  if (!app.state) return;
  const view = currentView();
  const clock = screen.querySelector('[data-clock]');
  if (!clock) return;
  if (view === 'countdown') clock.textContent = timeLeft(app.state.countdownEndsAt) || 'GO';
  if (view === 'hunt') clock.textContent = pad(timeLeft(app.state.roundEndsAt));
}

async function enableCamera() {
  app.error = '';
  if (!navigator.mediaDevices?.getUserMedia) {
    activity('camera_failed');
    throw new Error('Camera access needs HTTPS or localhost. You can still watch and vote.');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 540 }, height: { ideal: 960 } }, audio: false });
  } catch (error) {
    activity('camera_failed');
    throw new Error('Camera access was blocked or no camera was found. You can try again or vote as a spectator.');
  }
  app.camera = stream;
  app.cameraVideo = document.createElement('video');
  app.cameraVideo.muted = true;
  app.cameraVideo.autoplay = true;
  app.cameraVideo.playsInline = true;
  app.cameraVideo.srcObject = stream;
  app.cameraVideo.className = 'capture-source';
  document.body.append(app.cameraVideo);
  app.cameraVideo.play().catch(() => {});
  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    app.error = 'Your camera stopped. Reconnect it to keep playing.';
    releaseMedia(false);
    app.camera = null;
    app.cameraVideo?.remove();
    app.cameraVideo = null;
    render(true);
  }, { once: true });
  render(true);
}

function frameBlob(quality = 0.52, maxWidth = 360) {
  return new Promise(resolve => {
    const source = app.cameraVideo;
    if (!source?.videoWidth || !source?.videoHeight) return resolve(null);
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(maxWidth, source.videoWidth);
    canvas.height = Math.round(canvas.width * source.videoHeight / source.videoWidth);
    canvas.getContext('2d', { alpha: false }).drawImage(source, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(resolve, 'image/jpeg', quality);
  });
}
async function uploadFrame() {
  if (app.frameBusy || !app.token || !app.camera || !hasSlot()) return;
  if (!['lobby', 'countdown', 'locked', 'hunt', 'active', 'review', 'judging'].includes(phase())) return;
  app.frameBusy = true;
  try {
    let blob = await frameBlob();
    if (blob?.size > 150_000) blob = await frameBlob(0.36, 260);
    if (blob?.size && blob.size <= 150_000) await request('/frame', { method: 'POST', body: blob, auth: true });
  } catch (error) {
    if (error.status === 401) sessionExpired();
  } finally { app.frameBusy = false; }
}

async function ensureMediaReady() {
  if (app.mediaBusy) return app.mediaBusy;
  if (app.media || !app.camera || !app.token || !hasSlot()) return;
  app.mediaBusy = (async () => {
    const data = await request('/media-token', { auth: true });
    app.mediaMode = data.mode;
    if (data.mode === 'twilio') {
      if (!data.token || !data.roomName) throw new Error('Twilio Video is not ready for this heat. Ask the booth team for help.');
      const sdk = await import('/vendor/video-client.js');
      app.media = await sdk.connectPlayer({
        token: data.token,
        roomName: data.roomName,
        stream: app.camera,
        onDisconnected: () => { app.media = null; if (!app.outcome && hasSlot()) { app.error = 'Video disconnected. Tap retry to reconnect.'; render(true); } },
        onReconnecting: () => { app.error = 'Video reconnecting…'; render(true); },
        onReconnected: () => { app.error = ''; render(true); },
      });
      // Low-rate transient snapshots keep vision judging available if the wall
      // browser reconnects or has not been authenticated yet.
      await uploadFrame();
      app.frameTimer = setInterval(uploadFrame, 1600);
    } else if (data.mode === 'rehearsal') {
      app.media = { disconnect() {} };
      await uploadFrame();
      app.frameTimer = setInterval(uploadFrame, 800);
    } else {
      throw new Error('The booth has not configured a video mode yet.');
    }
    app.error = '';
    render(true);
    // The Video webhook can arrive just after connect; retry while it catches up.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const response = await request('/ready', { method: 'POST', auth: true });
        if (response.player) app.player = response.player;
        if (response.state) applyState({ state: response.state });
        render(true);
        return;
      } catch (error) {
        if (error.status === 401) { sessionExpired(); return; }
        if (attempt === 7) throw error;
        await new Promise(resolve => setTimeout(resolve, 650));
      }
    }
  })().catch(error => {
    releaseMedia(false);
    throw error;
  }).finally(() => { app.mediaBusy = null; });
  return app.mediaBusy;
}

function releaseMedia(stopCamera) {
  if (app.resultReleaseTimer) clearTimeout(app.resultReleaseTimer);
  app.resultReleaseTimer = null;
  if (app.frameTimer) clearInterval(app.frameTimer);
  app.frameTimer = null;
  app.media?.disconnect?.();
  app.media = null;
  if (stopCamera) {
    app.resultCameraStopAt = null;
    app.camera?.getTracks().forEach(track => track.stop());
    app.camera = null;
    app.cameraVideo?.remove();
    app.cameraVideo = null;
  }
}

function scheduleResultRelease() {
  if (app.resultReleaseTimer) clearTimeout(app.resultReleaseTimer);
  app.resultReleaseTimer = null;
  if (!app.camera) return;
  app.resultCameraStopAt ??= Date.now() + Math.min(35_000, (app.event?.resultSeconds || 8) * 1_000 + 2_000);
  const deadline = app.state.resultEndsAt ? new Date(app.state.resultEndsAt).getTime() : NaN;
  const serverDelay = Number.isFinite(deadline) ? deadline - now() + 400 : Infinity;
  const delay = Math.max(0, Math.min(serverDelay, app.resultCameraStopAt - Date.now()));
  app.resultReleaseTimer = setTimeout(() => releaseMedia(true), delay);
}

function sessionExpired() {
  if (!app.token || ['left', 'removed'].includes(app.view)) return;
  releaseMedia(true);
  sessionStorage.removeItem(sessionKey);
  app.token = null;
  app.player = null;
  app.view = 'intro';
  app.error = 'Your session ended. Join a new heat to play again.';
  render(true);
}

function sessionRemoved() {
  if (!app.token || ['left', 'removed'].includes(app.view)) return;
  closeSessionDialog();
  app.view = 'removed';
  app.token = null;
  app.player = null;
  app.outcome = null;
  app.error = '';
  sessionStorage.removeItem(sessionKey);
  releaseMedia(true);
  render(true);
}

function closeSessionDialog() {
  if (sessionDialog.open) sessionDialog.close();
  app.sessionDialogMode = null;
  app.idlePromptAt = null;
}

function openSessionDialog(mode) {
  if (app.sessionDialogMode && app.sessionDialogMode !== mode) return;
  app.sessionDialogMode = mode;
  $('sessionDialogTitle').textContent = mode === 'idle' ? 'Still here?' : 'Leave the game?';
  $('sessionDialogText').textContent = mode === 'idle'
    ? 'Keep your spot if you are still at the booth. Your camera turns off when you leave.'
    : 'Your camera will turn off and your spot will open for another player.';
  $('sessionStayButton').textContent = mode === 'idle' ? 'Keep my spot' : 'Keep playing';
  $('sessionLeaveButton').textContent = 'Leave game';
  $('sessionDialogCountdown').hidden = false;
  app.idlePromptAt = Date.now();
  if (!sessionDialog.open) sessionDialog.showModal();
}

async function leaveGame(destination = 'left') {
  closeSessionDialog();
  const token = app.token;
  app.token = null;
  sessionStorage.removeItem(sessionKey);
  app.view = destination;
  app.player = null;
  app.outcome = null;
  app.error = '';
  app.idleKey = null;
  app.idleSince = null;
  releaseMedia(true);
  if (destination === 'intro') {
    app.alias = '';
    app.consent = false;
    app.leadDraft = { fieldValues: {}, marketingOptIn: false };
  }
  render(true);
  if (!token) return;
  try {
    await fetch(`${apiBase}/leave`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'same-origin',
      keepalive: true,
    });
  } catch { /* The server will also expire an abandoned player session. */ }
}

function updateIdleCheck() {
  if (isResultDemo) return;
  const view = currentView();
  const idleView = ['queued', 'waiting', 'review'].includes(view) ||
    (app.state?.paused && ['countdown', 'hunt'].includes(view));
  const eligible = app.view === 'live' && !!app.token && idleView;
  if (!eligible) {
    app.idleKey = null;
    app.idleSince = null;
    if (app.sessionDialogMode === 'idle') closeSessionDialog();
  } else {
    const key = `${app.state?.heat}:${view}`;
    if (app.idleKey !== key) {
      app.idleKey = key;
      app.idleSince = Date.now();
    }
    if (!app.sessionDialogMode && Date.now() - app.idleSince >= 180_000) openSessionDialog('idle');
  }
  if (app.sessionDialogMode && app.idlePromptAt) {
    const remaining = Math.max(0, 30 - Math.floor((Date.now() - app.idlePromptAt) / 1_000));
    $('sessionDialogCountdown').textContent = `Spot releases in ${remaining}s`;
    if (!remaining) void leaveGame();
  }
}

async function join() {
  if (!app.camera) throw new Error('Enable your camera before joining.');
  const response = await request('/join', { method: 'POST', body: { alias: app.alias, displayConsent: true } });
  app.token = response.token;
  sessionStorage.setItem(sessionKey, app.token);
  app.player = response.player;
  app.view = 'live';
  app.error = '';
  if (response.state) applyState({ state: response.state });
  render(true);
  if (hasSlot()) await ensureMediaReady();
}

function syncLeadDraft() {
  const form = $('leadForm');
  if (!form) return;
  for (const input of form.querySelectorAll('[data-lead-field]')) app.leadDraft.fieldValues[input.dataset.leadField] = input.value.trim();
  const marketing = form.elements.namedItem('marketingOptIn');
  if (marketing) app.leadDraft.marketingOptIn = marketing.checked;
}
function validateCurrentLeadPage() {
  const form = $('leadForm');
  if (!form) return false;
  for (const input of form.querySelectorAll('[data-lead-field]')) {
    input.setCustomValidity('');
    if (input.type === 'tel' && input.value.trim()) {
      const digits = input.value.replace(/\D/g, '');
      if (!/^[+0-9().\-\s]+$/.test(input.value) || digits.length < 7 || digits.length > 20) input.setCustomValidity('Enter a phone number with at least seven digits.');
    }
  }
  return form.reportValidity();
}
async function submitLead() {
  if (!validateCurrentLeadPage()) return;
  syncLeadDraft();
  const settings = leadSettings();
  const missing = settings.fields.findIndex(field => field.required && !app.leadDraft.fieldValues[field.id]);
  if (missing >= 0) {
    app.leadPage = Math.floor(missing / leadPageSize());
    app.error = 'Complete the required field to continue.';
    render(true);
    return;
  }
  const hasContact = settings.fields.some(field => ['email', 'tel'].includes(field.type) && app.leadDraft.fieldValues[field.id]);
  if (!hasContact) {
    const index = settings.fields.findIndex(field => ['email', 'tel'].includes(field.type));
    app.leadPage = Math.max(0, Math.floor(index / leadPageSize()));
    app.error = 'Add an email or phone number so the booth team can follow up.';
    render(true);
    return;
  }
  const hasEmail = settings.fields.some(field => field.type === 'email' && app.leadDraft.fieldValues[field.id]);
  if (app.leadDraft.marketingOptIn && !hasEmail) {
    app.error = 'Add an email for product updates, or leave that choice unchecked.';
    render(true);
    return;
  }
  app.leadResult = await request('/leads', { method: 'POST', auth: true, body: { intent: app.leadIntent, fieldValues: app.leadDraft.fieldValues, marketingOptIn: app.leadDraft.marketingOptIn } });
  app.error = '';
  app.view = 'thanks';
  render(true);
}

screen.addEventListener('input', event => {
  if (event.target.id === 'alias') app.alias = event.target.value;
  if (event.target.dataset.leadField) app.leadDraft.fieldValues[event.target.dataset.leadField] = event.target.value;
});
screen.addEventListener('change', event => {
  if (event.target.id === 'consent') app.consent = event.target.checked;
  if (event.target.name === 'marketingOptIn') app.leadDraft.marketingOptIn = event.target.checked;
});
screen.addEventListener('click', async event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  try {
    if (action === 'intro-next') { app.view = 'consent'; app.error = ''; render(true); }
    if (action === 'consent-next') {
      const form = $('consentForm');
      if (!form.reportValidity()) return;
      app.alias = form.elements.alias.value.trim();
      app.consent = form.elements.consent.checked;
      app.view = 'preview'; app.error = ''; render(true);
    }
    if (action === 'camera') await enableCamera();
    if (action === 'join') await join();
    if (action === 'retry-media') { if (!app.camera) await enableCamera(); await ensureMediaReady(); }
    if (action === 'build') { syncLeadDraft(); releaseMedia(true); app.view = 'build'; app.error = ''; activity('cta_opened'); render(true); }
    if (action === 'guide' || action === 'expert') {
      app.leadIntent = action;
      app.leadPage = 0;
      app.view = 'lead';
      app.error = '';
      activity('lead_form_opened');
      render(true);
    }
    if (action === 'lead-next') {
      if (!validateCurrentLeadPage()) return;
      syncLeadDraft();
      app.leadPage += 1;
      app.error = '';
      render(true);
    }
    if (action === 'lead-previous') { syncLeadDraft(); app.leadPage -= 1; app.error = ''; render(true); }
    if (action === 'lead-submit') await submitLead();
    if (action === 'replay') await leaveGame('intro');
    if (action === 'rejoin') { app.view = 'intro'; app.error = ''; render(true); }
  } catch (error) { showError(error); }
});

$('leaveButton').addEventListener('click', () => openSessionDialog('manual'));
$('sessionStayButton').addEventListener('click', () => {
  app.idleSince = Date.now();
  closeSessionDialog();
});
$('sessionLeaveButton').addEventListener('click', () => { void leaveGame(); });
sessionDialog.addEventListener('cancel', event => {
  event.preventDefault();
  app.idleSince = Date.now();
  closeSessionDialog();
});

function initializeDemo() {
  const roster = [
    { id: 'preview-you', alias: 'You', slot: 1, status: 'finished' },
    { id: 'preview-pixel', alias: 'Pixel Pilot', slot: 2, status: 'finished' },
    { id: 'preview-nova', alias: 'Nova', slot: 3, status: 'finished' },
    { id: 'preview-echo', alias: 'Echo', slot: 4, status: 'finished' },
  ];
  const winners = demoMode === 'no-match' ? [] : demoMode === 'lose' ? ['preview-pixel']
    : demoMode === 'tie' ? ['preview-you', 'preview-pixel'] : ['preview-you'];
  app.event = { name: 'Live Scavenger Hunt', mediaMode: 'rehearsal', leadCapture: { enabled: false } };
  app.token = null;
  app.state = { phase: 'result', heat: 4, winners, roster };
  app.player = { ...roster[0], heat: 4 };
  app.outcome = { heat: 4, winners, winnerNames: roster.filter(player => winners.includes(player.id)).map(player => player.alias) };
  app.view = 'live';
  app.connection = 'preview';
  render(true);
}

async function initialize() {
  if (isResultDemo) { initializeDemo(); return; }
  try {
    applyState(await request(''));
    activity('landing_opened');
    if (app.token) {
      try {
        const me = await request('/me', { auth: true });
        app.player = me.player;
        app.alias = me.player?.alias || '';
        app.view = 'live';
        if (me.state) applyState({ state: me.state });
        if (hasSlot() && phase() !== 'result') {
          app.error = 'Reconnect your camera to stay in this heat.';
        }
      } catch (error) {
        if (error.status === 401 || error.status === 404) sessionExpired();
        else showError(error);
      }
    }
    render(true);
    const stream = new EventSource(`${apiBase}/stream`);
    stream.addEventListener('state', event => { try { applyState(JSON.parse(event.data)); } catch {} });
    stream.onerror = () => { app.connection = 'reconnecting'; };
    stream.onopen = () => { app.connection = 'live'; };
    setInterval(async () => {
      updateClock();
      if (app.token) {
        try {
          const response = await request('/heartbeat', { method: 'POST', auth: true });
          if (response.player) app.player = { ...app.player, ...response.player };
          if (response.state) applyState({ state: response.state });
        } catch (error) { if (error.status === 401) sessionExpired(); }
      }
      if (Date.now() - app.lastPayloadAt > 12_000) {
        try { applyState(await request('')); } catch { app.connection = 'reconnecting'; }
      }
    }, 5_000);
  } catch (error) {
    screen.innerHTML = `<div class="card cardpad"><p class="eyebrow">Connection interrupted</p><h1 class="section-title">The arena is offline.</h1><p class="body">${escapeHtml(error.message)}</p>${button('RETRY', 'reload')}</div>`;
  }
}
screen.addEventListener('click', event => { if (event.target.closest('[data-action="reload"]')) location.reload(); });
window.addEventListener('resize', () => {
  const nextPageSize = leadPageSize();
  if (app.view === 'lead' && nextPageSize !== renderedLeadPageSize) {
    syncLeadDraft();
    renderedLeadPageSize = nextPageSize;
    render(true);
  }
});
window.addEventListener('pagehide', () => releaseMedia(true));
setInterval(updateClock, 200);
setInterval(updateIdleCheck, 1_000);
initialize();
