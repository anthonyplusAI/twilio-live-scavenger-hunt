const slug = decodeURIComponent(location.pathname.split('/')[2] || 'demo');
const apiBase = `/api/e/${encodeURIComponent(slug)}`;
const arenaUrl = `/e/${encodeURIComponent(slug)}/arena`;
const voteUrl = `/e/${encodeURIComponent(slug)}/vote`;
const githubUrl = 'https://github.com/anthonyplusAI/twilio-live-scavenger-hunt';
const sessionKey = `signal-stadium-player:${slug}`;
const replayIntentKey = `${sessionKey}:replay-pending`;
const cameraLeaseKey = `${sessionKey}:camera-lease`;
const tabId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
function readPlayerToken() {
  let token = null;
  try { token = localStorage.getItem(sessionKey); } catch { /* Use this tab's session when storage is unavailable. */ }
  if (!token) try { token = sessionStorage.getItem(sessionKey); } catch { /* A private browser may block storage. */ }
  if (token) savePlayerToken(token);
  return token;
}
function savePlayerToken(token) {
  try { localStorage.setItem(sessionKey, token); } catch { /* A private browser may block storage. */ }
  try { sessionStorage.setItem(sessionKey, token); } catch { /* The current page still has the token. */ }
}
function clearPlayerToken() {
  try { localStorage.removeItem(sessionKey); } catch { /* Storage may be unavailable. */ }
  try { sessionStorage.removeItem(sessionKey); } catch { /* Storage may be unavailable. */ }
}
function readReplayPending() {
  try { return sessionStorage.getItem(replayIntentKey) === '1'; }
  catch { return false; }
}
const initialToken = readPlayerToken();
const demoMode = new URLSearchParams(location.search).get('demo');
const isResultDemo = ['win', 'lose', 'tie', 'no-match', 'decision', 'build'].includes(demoMode);
const screen = document.getElementById('screen');
const eventName = document.getElementById('eventName');
const modeLabel = document.getElementById('modeLabel');
const githubFooterLink = document.getElementById('githubFooterLink');
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
  token: initialToken,
  player: null,
  view: initialToken ? 'resuming' : 'intro',
  alias: '',
  consent: false,
  camera: null,
  cameraVideo: null,
  cameraInput: null,
  cameraCanvas: null,
  cameraDrawTimer: null,
  cameraFacing: 'user',
  cameraBusy: false,
  cameraHelp: '',
  restoring: false,
  mediaLinkUp: false,
  mediaGeneration: 0,
  joinBusy: false,
  replayBusy: false,
  leaveBusy: false,
  replayPending: readReplayPending(),
  replayExpired: false,
  media: null,
  mediaMode: null,
  mediaBusy: null,
  mediaBusyGeneration: null,
  resultReleaseTimer: null,
  resultCameraStopAt: null,
  frameTimer: null,
  frameBusy: false,
  error: '',
  connection: 'connecting',
  leadIntent: 'guide',
  buildProduct: 'video',
  leadPage: 0,
  leadDraft: { fieldValues: {} },
  returningLead: false,
  leadResult: null,
  followupBusy: false,
  followupPage: 0,
  queueRefreshBusy: false,
  renderedLeadKey: '',
  renderedFollowupKey: '',
  outcome: null,
  resultRevealSeen: new Set(),
  idleSince: null,
  idleKey: null,
  idlePromptAt: null,
  sessionDialogMode: null,
  lastRender: '',
  lastPayloadAt: 0,
  publicRefresh: null,
  deadlineRefreshKey: '',
  deadlineRefreshAttempts: 0,
  deadlineRefreshNextAt: 0,
  activity: new Set(),
};

const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const button = (label, action, secondary = false, disabled = false, type = 'button') => `<button type="${type}" class="${secondary ? 'secondary' : 'primary'}" data-action="${action}" ${disabled ? 'disabled' : ''}><span>${label}</span><span aria-hidden="true">↗</span></button>`;
const now = () => Date.now() + app.serverOffset;
const minimumResultRevealMs = () => Math.min(8_000, (app.event?.resultSeconds || 15) * 1_000);
const timeLeft = deadline => deadline ? Math.max(0, Math.ceil((new Date(deadline).getTime() - now()) / 1000)) : 0;
const pad = number => String(number || 0).padStart(2, '0');
const visibleRoster = () => Array.isArray(app.state?.roster) ? app.state.roster : [];
const rosterPlayer = () => visibleRoster().find(entry => entry.id === app.player?.id);
const hasSlot = () => Boolean(rosterPlayer()?.slot) && !['queued', 'left'].includes(app.player?.status);
const phase = () => app.state?.phase || 'lobby';
const cameraOnline = () => Boolean(app.camera && app.media && (app.mediaMode !== 'twilio' || app.mediaLinkUp));
function setReplayPending(pending) {
  app.replayPending = pending;
  try {
    if (pending) sessionStorage.setItem(replayIntentKey, '1');
    else sessionStorage.removeItem(replayIntentKey);
  } catch { /* The choice still works in this tab. */ }
}

function applyPrivatePlayer(player) {
  if (!player) return;
  app.player = { ...app.player, ...player };
  if (player.status === 'finished' && player.lastExitReason === 'replay_timeout') app.replayExpired = true;
  else if (['joined', 'ready', 'queued', 'left'].includes(player.status)) app.replayExpired = false;
}

function cameraLease() {
  try { return JSON.parse(localStorage.getItem(cameraLeaseKey) || 'null'); }
  catch { return null; }
}

function ownsCameraLease() {
  const lease = cameraLease();
  return !lease || lease.id === tabId || lease.expiresAt <= Date.now();
}

function claimCameraLease(takeOver = false) {
  const lease = cameraLease();
  if (!takeOver && lease && lease.id !== tabId && lease.expiresAt > Date.now()) return false;
  try {
    localStorage.setItem(cameraLeaseKey, JSON.stringify({ id: tabId, expiresAt: Date.now() + 10_000 }));
    return cameraLease()?.id === tabId;
  } catch { return true; }
}

function releaseCameraLease() {
  try { if (cameraLease()?.id === tabId) localStorage.removeItem(cameraLeaseKey); }
  catch { /* Storage may be unavailable. */ }
}

function cameraMovedToAnotherTab() {
  if (!app.camera && !app.cameraBusy) return;
  releaseMedia(true);
  app.cameraHelp = 'another-tab';
  app.error = 'Your camera is open in another tab. Continue there, or tap Use camera here.';
  render(true);
}

async function request(path, { method = 'GET', body, auth = false, headers = {}, keepalive = false } = {}) {
  const options = { method, headers: { ...headers }, credentials: 'same-origin', keepalive };
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

function activity(type, properties = {}) {
  if (isResultDemo) return;
  const onceKey = type === 'landing_opened' ? type : type === 'result_viewed' ? `${type}:${app.state?.heat}` : null;
  if (onceKey && app.activity.has(onceKey)) return;
  if (onceKey) app.activity.add(onceKey);
  request('/activity', { method: 'POST', body: { type, ...properties }, keepalive: true }).catch(() => {});
}
githubFooterLink.addEventListener('click', () => activity('github_cta_opened', { source: 'phone' }));

async function refreshQueuePosition() {
  if (app.queueRefreshBusy || !app.token || app.player?.status !== 'queued') return;
  const playerId = app.player.id;
  app.queueRefreshBusy = true;
  try {
    const response = await request('/me', { auth: true });
    if (app.player?.id !== playerId || app.view !== 'live') return;
    if (response.player?.status === 'left') { enterLeftSession(response); return; }
    applyPrivatePlayer(response.player);
    if (response.state) applyState({ state: response.state });
    else render();
  } catch (error) {
    if (error.status === 401) await reconcileAfterUnauthorized();
  } finally { app.queueRefreshBusy = false; }
}

function applyState(payload) {
  if (!payload || !payload.state) return;
  if (Number.isFinite(app.state?.version) && Number.isFinite(payload.state.version) &&
      payload.state.version < app.state.version) return;
  const hadSlot = hasSlot();
  const previousQueueCount = app.state?.queuedCount;
  if (payload.serverTime) app.serverOffset = new Date(payload.serverTime).getTime() - Date.now();
  if (payload.event) app.event = payload.event;
  app.state = payload.state;
  app.lastPayloadAt = Date.now();
  app.connection = 'live';
  const roster = rosterPlayer();
  if (roster && app.player && !(app.player.status === 'queued' && phase() === 'result'))
    app.player = { ...app.player, ...roster, heat: app.state.heat };
  if (app.player && app.view === 'preview' && !hasSlot()) {
    releaseMedia(true);
    app.view = 'live';
  }
  if (app.player && app.view === 'live') {
    if (!hasSlot() && (app.media || app.camera)) releaseMedia(true);
    if (!app.restoring && !hadSlot && hasSlot() && !app.camera && phase() !== 'result')
      void reconnectCamera().catch(showError);
    if (hasSlot() && !app.outcome && app.camera && !app.media && phase() !== 'result') ensureMediaReady().catch(showError);
    if (phase() === 'result' && hasSlot() && !app.outcome) {
      setReplayPending(false);
      app.replayExpired = false;
      const resultDeadline = Date.parse(app.state.resultEndsAt || '');
      app.outcome = {
        heat: app.state.heat,
        winners: [...(app.state.winners || [])],
        decisionAt: Number.isFinite(resultDeadline) ? resultDeadline : now() + (app.event?.resultSeconds || 15) * 1_000,
        minRevealUntil: Date.now() + minimumResultRevealMs(),
      };
      activity('result_viewed');
    }
    if (phase() === 'result' && app.outcome?.heat === app.state.heat) {
      app.outcome.winners = [...(app.state.winners || [])];
      app.outcome.winnerNames = visibleRoster()
        .filter(player => app.outcome.winners.includes(player.id))
        .map(player => player.alias);
      const resultDeadline = Date.parse(app.state.resultEndsAt || '');
      if (Number.isFinite(resultDeadline)) app.outcome.decisionAt = resultDeadline;
    }
    if (app.outcome && phase() === 'result' && app.state.heat === app.outcome.heat) scheduleResultRelease();
    else if (app.outcome && app.state.heat !== app.outcome.heat) releaseMedia(true);
    if (app.replayPending && app.player?.status === 'ready') setReplayPending(false);
    if (app.replayPending && app.player?.status === 'finished' && !hasSlot() && !app.outcome) {
      setReplayPending(false);
      app.replayExpired = true;
      app.error = '';
    }
    if (app.player?.status === 'finished' && app.player.lastExitReason === 'replay_timeout' && !app.outcome)
      app.replayExpired = true;
  }
  if (app.returningLead && !needsReturningLead()) {
    app.returningLead = false;
    app.view = app.player?.status === 'left' ? 'left' : 'live';
    app.error = '';
  }
  render();
  updateIdleCheck();
  if (app.view === 'live' && app.player?.status === 'queued' &&
      previousQueueCount != null && previousQueueCount !== app.state.queuedCount)
    void refreshQueuePosition();
}

async function refreshPublicState() {
  if (app.publicRefresh) return app.publicRefresh;
  app.publicRefresh = request('').then(response => { applyState(response); return response; })
    .finally(() => { app.publicRefresh = null; });
  return app.publicRefresh;
}

function refreshAtCountdownDeadline() {
  if (phase() !== 'countdown' || app.state?.paused || !app.state.countdownEndsAt) return;
  const deadline = Date.parse(app.state.countdownEndsAt);
  if (!Number.isFinite(deadline) || now() < deadline) return;
  const key = `${app.state.heat}:${app.state.countdownEndsAt}`;
  if (app.deadlineRefreshKey !== key) {
    app.deadlineRefreshKey = key;
    app.deadlineRefreshAttempts = 0;
    app.deadlineRefreshNextAt = 0;
  }
  if (app.publicRefresh || app.deadlineRefreshAttempts >= 6 || Date.now() < app.deadlineRefreshNextAt) return;
  app.deadlineRefreshAttempts += 1;
  app.deadlineRefreshNextAt = Date.now() + Math.min(900, 180 + app.deadlineRefreshAttempts * 140);
  void refreshPublicState().catch(() => { app.connection = 'reconnecting'; });
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
    timing: raw.timing === 'join' ? 'join' : 'after-play',
    guideEnabled: raw.guideEnabled !== false,
    expertEnabled: raw.expertEnabled !== false,
    fields,
  };
}

function needsReturningLead() {
  const settings = leadSettings();
  return Boolean(app.player?.needsJoinLead && settings.enabled && settings.timing === 'join');
}

function openReturningLeadForm(message = '', preserveDraft = false) {
  if (!needsReturningLead()) return false;
  app.returningLead = true;
  app.leadPage = 0;
  if (!preserveDraft) {
    app.consent = false;
    app.leadDraft = { fieldValues: {} };
  }
  app.view = 'consent';
  app.error = message;
  activity('lead_form_opened');
  render(true);
  return true;
}

function primaryCta(lead = leadSettings()) {
  const selected = app.event?.cta?.primary;
  if (selected === 'guide' && lead.enabled && lead.guideEnabled) return 'guide';
  if (selected === 'expert' && lead.enabled && lead.expertEnabled) return 'expert';
  return 'github';
}

function currentView() {
  if (app.view !== 'live') return app.view;
  if (app.outcome) {
    if (app.state?.paused && phase() === 'result' && app.state?.heat === app.outcome.heat) return 'result';
    return now() >= app.outcome.decisionAt && Date.now() >= (app.outcome.minRevealUntil || 0)
      ? 'decision' : 'result';
  }
  if (app.player?.status === 'queued') return 'queued';
  if (app.player?.status === 'finished' || (app.player?.heat && app.state?.heat > app.player.heat)) return 'decision';
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

function displayWinnerNames(winners) {
  const names = (app.outcome?.winnerNames?.length
    ? app.outcome.winnerNames
    : visibleRoster().filter(player => winners.includes(player.id)).map(player => player.alias))
    .filter(Boolean).map(escapeHtml);
  if (!names.length) return winners.length > 1 ? 'Other players' : 'Another player';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}

function resultTechCta() {
  return `<button type="button" class="result-tech-cta" data-action="build"><span class="result-tech-cta-mark" aria-hidden="true"><img src="/assets/twilio-bug-official.png" alt=""></span><span class="result-tech-cta-copy"><strong>SEE HOW IT'S BUILT</strong><small>Video · Messaging · Segment</small></span><span class="result-tech-cta-arrow" aria-hidden="true">↗</span></button>`;
}

function resultMarkup(winners, heat) {
  const won = winners.includes(app.player?.id);
  const tied = winners.length > 1;
  const noMatch = winners.length === 0;
  const variant = won ? 'win' : noMatch ? 'no-match' : 'lose';
  const revealKey = `${heat}:${[...winners].sort().join(',')}:${variant}`;
  const entering = !app.resultRevealSeen.has(revealKey);
  app.resultRevealSeen.add(revealKey);
  const label = won ? (tied ? 'TIED FOR FIRST' : 'FIRST FIND') : noMatch ? 'NO VERIFIED FIND' : tied ? 'OTHER PLAYERS TIED' : 'ANOTHER PLAYER WON';
  const heading = won ? (tied ? 'YOU TIED<br><em>FOR FIRST.</em>' : 'YOU FOUND<br><em>IT FIRST.</em>') : noMatch ? 'NO MATCH<br><em>THIS TIME.</em>' : 'NOT THIS<br><em>ROUND.</em>';
  const note = won ? (tied ? 'A close finish. You share the spotlight.' : 'The arena is celebrating your find.') : noMatch ? 'No one won this heat. Play again when you are ready.' : `${displayWinnerNames(winners)} ${tied ? 'tied for first' : 'won this heat'}. Play again for a new clue.`;
  const emblem = won
    ? `<svg viewBox="0 0 160 160" aria-hidden="true"><path d="M38 34h84v40c0 37-20 59-42 59S38 111 38 74V34Z" fill="currentColor"/><path d="M38 49H19v19c0 22 14 35 34 35M122 49h19v19c0 22-14 35-34 35" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round"/><path d="M80 132v15M55 148h50" stroke="currentColor" stroke-width="10" stroke-linecap="round"/><path d="m80 50 6 13 14 2-10 10 3 14-13-7-13 7 3-14-10-10 14-2 6-13Z" fill="#fff"/></svg>`
    : noMatch
      ? `<svg viewBox="0 0 160 160" aria-hidden="true"><path d="M51 29h58v19c0 18-13 25-29 32-16-7-29-14-29-32V29Zm0 102h58v-19c0-18-13-25-29-32-16 7-29 14-29 32v19Z" fill="none" stroke="currentColor" stroke-width="7" stroke-linejoin="round"/><path d="M63 43h34M63 117h34" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><path d="m68 53 12 10 12-10M68 107l12-10 12 10" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : `<svg viewBox="0 0 160 160" aria-hidden="true"><path d="M35 27h70l20 20v85H35V27Z" fill="none" stroke="currentColor" stroke-width="7" stroke-linejoin="round"/><path d="M105 27v22h20M53 53h33M53 68h19" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><circle cx="76" cy="94" r="17" fill="none" stroke="currentColor" stroke-width="7"/><path d="m89 108 17 18" stroke="currentColor" stroke-width="8" stroke-linecap="round"/></svg>`;
  return `<div class="result-scene result-${variant} ${entering ? 'result-entering' : ''}">${won ? resultConfetti() : ''}<div class="result-halo" aria-hidden="true"></div><p class="result-kicker">HEAT ${pad(heat)} <span aria-hidden="true">/</span> ${label}</p><div class="result-emblem">${emblem}</div><h1 class="result-title">${heading}</h1><p class="result-note">${note}</p><div class="result-actions">${app.error ? `<p class="result-error" role="alert">${escapeHtml(app.error)}</p>` : ''}${resultTechCta()}</div>${isResultDemo ? '<button type="button" class="result-demo-replay" data-action="replay-demo">↻ Replay reveal</button>' : ''}</div>`;
}

function decisionMarkup() {
  const heat = app.outcome?.heat || app.player?.heat || app.state?.heat || 1;
  const winners = app.outcome?.winners;
  const won = winners?.includes(app.player?.id);
  const variant = app.replayExpired ? 'neutral' : won ? 'win' : winners?.length ? 'lose' : 'neutral';
  const result = app.replayExpired ? 'NEXT HEAT SPOT EXPIRED' : !winners ? 'HEAT COMPLETE' : won
    ? winners.length > 1 ? 'YOU TIED FOR FIRST' : 'YOU FOUND IT FIRST'
    : winners.length ? 'ANOTHER PLAYER WON' : 'NO VERIFIED FIND';
  const note = app.replayExpired
    ? 'Your camera was not ready in time. Play again to rejoin without scanning.'
    : 'Same player. Same phone. No new scan.';
  const againAction = isResultDemo ? 'demo-next' : 'replay';
  const leaveAction = isResultDemo ? 'demo-leave' : 'leave-now';
  return `<div class="decision-scene decision-${variant}"><div class="decision-orbit" aria-hidden="true"><span>↻</span></div><p class="decision-kicker">HEAT ${pad(heat)} <span aria-hidden="true">/</span> YOUR CHOICE</p><p class="decision-result">${result}</p><h1 class="decision-title">ANOTHER<br><em>ROUND?</em></h1><p class="decision-note">${note}</p><div class="decision-actions">${app.error ? `<p class="decision-error" role="alert">${escapeHtml(app.error)}</p>` : ''}<button type="button" class="decision-again" data-action="${againAction}" ${app.replayBusy ? 'disabled' : ''}><span>${app.replayBusy ? 'JOINING NEXT HEAT…' : 'PLAY AGAIN'}</span><span aria-hidden="true">↻</span></button><button type="button" class="decision-leave" data-action="${leaveAction}"><span>LEAVE GAME</span><span aria-hidden="true">↗</span></button><p class="decision-hint">Your camera is off until you choose to play again.</p><button type="button" class="decision-tech" data-action="build">See how Twilio built this <span aria-hidden="true">↗</span></button></div></div>`;
}

const buildProducts = {
  video: {
    name: 'Twilio Video',
    url: 'https://www.twilio.com/en-us/video',
    status: 'Built in · setup needed',
    detail: 'In live mode, phones publish to a Video Room and the arena subscribes. A separate judge checks finds. Events need credentials and HTTPS.',
    from: 'Your camera',
    to: 'Arena wall',
    source: '<div class="build-phone"><div class="build-phone-camera"></div><div class="build-phone-person"><i></i><b></b></div><span>YOU</span></div>',
    destination: '<div class="build-arena-mini"><i></i><i></i><i></i><i></i><span>LIVE</span></div>',
  },
  messaging: {
    name: 'Twilio Messaging',
    url: 'https://www.twilio.com/en-us/messaging/apis/programmable-messaging-api',
    status: 'Optional integration',
    detail: 'Spectators can vote by SMS or WhatsApp. Incoming replies reach the game as ballots through a webhook.',
    from: 'Crowd reply',
    to: 'Live ballot',
    source: '<div class="build-message-mini"><span>VOTE</span><strong>RED</strong><i></i></div>',
    destination: '<div class="build-ballot-mini"><span>RED</span><strong>57%</strong><i></i><b></b></div>',
  },
  segment: {
    name: 'Twilio Segment',
    url: 'https://www.twilio.com/en-us/segment',
    status: 'Optional integration',
    detail: 'Play and interaction events can flow to Segment. The game’s own event report works without it.',
    from: 'Game signals',
    to: 'Engagement data',
    source: '<div class="build-events-mini"><span>JOIN</span><span>PLAY</span><span>VOTE</span></div>',
    destination: '<div class="build-chart-mini"><i></i><i></i><i></i><i></i><span>INSIGHTS</span></div>',
  },
};

function buildMarkup(lead) {
  const product = { ...(buildProducts[app.buildProduct] || buildProducts.video) };
  if (app.buildProduct === 'video' && app.event?.mediaMode === 'twilio') {
    product.status = 'Live at this event';
    product.detail = 'Your phone publishes to a Twilio Video Room and the arena subscribes. A separate judge checks finds, and staff can override.';
  }
  const tabs = Object.entries(buildProducts).map(([key, item]) => `<button type="button" class="build-tab ${key === app.buildProduct ? 'is-active' : ''}" data-action="build-product" data-product="${key}" aria-pressed="${key === app.buildProduct}"><strong>${key === 'video' ? 'Video' : key === 'messaging' ? 'Messaging' : 'Segment'}</strong><small>${key === 'video' ? 'Game core' : 'Optional'}</small></button>`).join('');
  const flow = `<div class="build-flow build-flow-${app.buildProduct}" aria-hidden="true"><figure class="build-flow-end build-flow-source">${product.source}<figcaption>${product.from}</figcaption></figure><div class="build-flow-link"><span class="build-flow-line"></span><span class="build-flow-twilio"><img src="/assets/twilio-bug-official.png" alt=""></span><span class="build-flow-line"></span></div><figure class="build-flow-end build-flow-destination">${product.destination}<figcaption>${product.to}</figcaption></figure></div>`;
  const busy = app.followupBusy ? 'disabled' : '';
  const primary = primaryCta(lead);
  const actions = {
    github: isPrimary => `<a class="build-github ${isPrimary ? 'is-primary' : ''}" data-github-source="phone" href="${githubUrl}" target="_blank" rel="noopener noreferrer" aria-label="Star Live Scavenger Hunt on GitHub (opens in a new tab)"><span class="build-github-star" aria-hidden="true">★</span><span>${isPrimary ? 'Star this game on GitHub' : 'Star on GitHub'}</span><span aria-hidden="true">↗</span></a>`,
    guide: isPrimary => lead.enabled && lead.guideEnabled ? `<button type="button" class="build-guide ${isPrimary ? 'is-primary' : ''}" data-action="guide" ${busy}>Request the build guide <span aria-hidden="true">↗</span></button>` : '',
    expert: isPrimary => lead.enabled && lead.expertEnabled ? `<button type="button" class="build-expert ${isPrimary ? 'is-primary' : ''}" data-action="expert" ${busy}>Request a Twilio expert <span aria-hidden="true">↗</span></button>` : '',
  };
  const primaryAction = actions[primary](true);
  const secondaryActions = ['github', 'guide', 'expert'].filter(action => action !== primary)
    .map(action => actions[action](false)).filter(Boolean).join('');
  const replay = isResultDemo ? '<button type="button" class="build-replay" data-action="demo-result">← Back to the result</button>' : '<button type="button" class="build-replay" data-action="replay">Play another heat</button>';
  const learnMore = `<a class="build-product-link" data-twilio-product="${app.buildProduct}" href="${product.url}" target="_blank" rel="noopener noreferrer" aria-label="Explore ${product.name} on Twilio (opens in a new tab)">Explore ${product.name} <span aria-hidden="true">↗</span></a>`;
  return `<div class="build-story"><div class="build-intro"><p class="build-kicker">Behind your heat</p><h1>From your phone<br>to the whole room.</h1></div><div class="build-tabs" role="group" aria-label="Explore Twilio products">${tabs}</div><section class="build-panel" data-product="${app.buildProduct}" aria-label="${product.name} explanation">${flow}<div class="build-panel-copy"><div class="build-panel-heading"><h2>${product.name}</h2><span>${product.status}</span></div><p>${product.detail}</p>${learnMore}</div></section><div class="build-next"><p>Make your own live moment. Talk to us at the booth.</p>${primaryAction}<div class="build-next-links">${secondaryActions}${replay}</div>${app.error ? `<p class="build-error" role="alert">${escapeHtml(app.error)}</p>` : ''}</div></div>`;
}

function preview() {
  const slot = rosterPlayer()?.slot ?? app.player?.slot;
  const nextFacing = app.cameraFacing === 'user' ? 'rear' : 'front';
  return `<div class="preview ${app.camera ? 'has-camera' : ''} ${app.cameraFacing === 'environment' ? 'is-rear' : ''}"><div class="preview-placeholder" ${app.camera ? 'hidden' : ''}>${portraitArt()}<span class="camera-waiting">${cameraIcon()}<span>Camera off</span></span></div><video id="camera" autoplay muted playsinline ${app.camera ? '' : 'hidden'}></video><div class="frame" aria-hidden="true"><i></i><i></i><i></i><i></i></div><span class="preview-topline"><b></b>${app.camera ? 'CAMERA ON' : 'CAMERA CHECK'}</span>${app.camera ? `<button type="button" class="camera-flip" data-action="flip-camera" aria-label="Switch to ${nextFacing} camera" title="Switch to ${nextFacing} camera" ${app.cameraBusy || app.mediaBusy ? 'disabled' : ''}><span aria-hidden="true">↻</span></button>` : ''}<span class="slot">${slot ? `SLOT ${pad(slot)}` : 'YOUR CAMERA'}</span></div>`;
}

function cameraHelpMarkup() {
  if (!app.cameraHelp) return '';
  if (app.cameraHelp === 'another-tab') return '<p class="camera-recovery" role="status"><strong>Camera is in another tab</strong><span>Continue in that tab, or tap Use camera here to move it to this screen.</span></p>';
  if (app.cameraHelp !== 'permission') return `<p class="camera-recovery" role="status">${app.cameraHelp === 'secure' ? 'Open this game over HTTPS to use your camera.' : 'Check that your camera is connected and no other app is using it, then retry.'}</p>`;
  const userAgent = navigator.userAgent || '';
  const instructions = /iPhone|iPad|iPod/i.test(userAgent)
    ? /CriOS/i.test(userAgent)
      ? 'On iPhone, open Settings → Chrome → Camera and allow access. Return here and retry.'
      : 'Safari: tap the address-bar page menu → Settings for This Website → Camera → Allow. Return and retry.'
    : /Android/i.test(userAgent)
      ? 'In Chrome, tap the site controls beside the address bar → Permissions → Camera → Allow. Return here and retry.'
      : 'Open this site’s controls beside the address bar → Camera → Allow. Return here and retry.';
  return `<div class="camera-recovery" role="status"><strong>Camera blocked?</strong><span>${instructions}</span></div>`;
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

function queueMarkup() {
  const rank = Number(app.player?.queuePosition);
  const position = Number.isInteger(rank) && rank > 0 ? rank : null;
  const waiting = Number(app.state?.queuedCount || 0);
  const capacity = Math.max(1, Number(app.event?.maxPlayers || 6));
  const heatsAway = position ? Math.ceil(position / capacity) : null;
  const estimate = heatsAway === 1 ? 'EXPECTED NEXT HEAT'
    : heatsAway ? 'ABOUT ' + heatsAway + ' HEATS AWAY' : 'UPDATING YOUR PLACE';
  const total = waiting + ' ' + (waiting === 1 ? 'PLAYER' : 'PLAYERS') + ' WAITING';
  const waitingCopy = app.state?.paused
    ? 'Booth paused. Keep this page open and tap Keep my spot if we check in.'
    : 'Camera off while you wait. Keep this page open; we will reconnect when your spot opens.';
  return `<p class="eyebrow">Your place in line</p><h1 class="hero">YOU'RE<br><em>ON DECK.</em></h1><div class="queue-ticket" aria-live="polite"><div class="queue-ticket-top"><span>LIVE WAITLIST</span><span class="queue-ticket-dot" aria-hidden="true"></span></div><strong class="queue-ticket-rank">${position ? '#' + pad(position) : '—'}</strong><div class="queue-ticket-bottom"><span>${estimate}</span><small>${total}</small></div></div><p class="sub queue-copy">${waitingCopy}</p><p class="error" role="alert">${escapeHtml(app.error)}</p>`;
}

// Keep pagination stable when the Android virtual keyboard changes viewport height.
const initialJoinHeight = innerHeight;
function leadPageSize() { return innerWidth <= 600 || initialJoinHeight < 680 ? 2 : 3; }
function compactFinalJoinPage() { return innerWidth <= 400 || initialJoinHeight < 700; }
function leadLayoutKey() { return `${leadPageSize()}:${compactFinalJoinPage()}`; }
let renderedLeadPageSize = leadLayoutKey();
function leadFieldPages(settings, combineShort = false) {
  if (!settings.enabled || settings.timing !== 'join') return [[]];
  // The common name/email/company form belongs beside display consent on one screen.
  // Long custom labels or a different three-field shape still use short pages.
  const canPairThree = settings.fields.length === 3 &&
    settings.fields.filter(field => field.type === 'email').length === 1 &&
    settings.fields.every(field => field.label.length <= 18);
  const canStackTwo = settings.fields.length === 2 &&
    settings.fields.every(field => field.label.length <= 18);
  if (combineShort && (settings.fields.length <= 1 || canStackTwo || canPairThree)) return [settings.fields];
  const pages = [];
  for (let start = 0; start < settings.fields.length;) {
    const remaining = settings.fields.length - start;
    // Leave room for display and image-review consent on a small phone.
    const size = compactFinalJoinPage() && remaining > 1 && remaining <= leadPageSize()
      ? remaining - 1 : Math.min(leadPageSize(), remaining);
    pages.push(settings.fields.slice(start, start + size));
    start += size;
  }
  if (!pages.length) pages.push([]);
  if (compactFinalJoinPage() && settings.fields.length === 1) pages.push([]);
  return pages;
}
function pageForLeadField(settings, index) {
  const id = settings.fields[index]?.id;
  const page = leadFieldPages(settings, true).findIndex(fields => fields.some(field => field.id === id));
  return Math.max(0, page);
}
function fieldMarkup(field, compact = false) {
  const id = `lead-${field.id}`;
  const autocomplete = ({ name: 'name', email: 'email', company: 'organization', phone: 'tel', jobTitle: 'organization-title' })[field.id] || 'off';
  return `<div class="field"><label for="${id}">${escapeHtml(field.label)}${field.required ? ' *' : compact ? ' · opt.' : ' · optional'}</label><input id="${id}" data-lead-field="${field.id}" type="${field.type}" autocomplete="${autocomplete}" maxlength="${field.type === 'email' ? 254 : field.type === 'tel' ? 40 : 160}" ${field.required ? 'required' : ''} value="${escapeHtml(app.leadDraft.fieldValues[field.id] || '')}"></div>`;
}
function joinMarkup(settings) {
  const captureAtJoin = settings.enabled && settings.timing === 'join';
  const pages = leadFieldPages(settings, true);
  app.leadPage = Math.max(0, Math.min(app.leadPage, pages.length - 1));
  const first = app.leadPage === 0;
  const final = app.leadPage === pages.length - 1;
  const fields = pages[app.leadPage];
  const combined = captureAtJoin && pages.length === 1;
  const paired = combined && fields.length === 3 && fields.filter(field => field.type !== 'email').length === 2;
  const displayedFields = paired
    ? [...fields.filter(field => field.type !== 'email'), ...fields.filter(field => field.type === 'email')]
    : fields;
  const alias = first ? `<div class="field"><label for="alias">${app.returningLead ? 'Your player name' : 'Screen name'}</label><input id="alias" name="alias" maxlength="20" minlength="2" autocomplete="nickname" placeholder="e.g. Pixel Pilot" value="${escapeHtml(app.alias)}" ${app.returningLead ? 'readonly' : ''} required></div>` : '';
  const consent = final
    ? `<label class="check"><input id="consent" name="consent" type="checkbox" required ${app.consent ? 'checked' : ''}><span>I agree to appear on the arena, including a brief result freeze. OpenAI may check camera images when enabled.</span></label>` : '';
  const heading = app.returningLead && first ? 'Welcome back.' : combined ? 'Join the hunt.' : first ? 'Join the<br> hunt.' : 'Almost<br> ready.';
  const intro = captureAtJoin
    ? combined ? 'For the booth team · no marketing signup.' : first ? 'Share your details with the booth team before the camera check.' : 'Your details will be saved for this event when you join.'
    : 'Your camera appears on the public booth display during your heat. You can choose a follow-up after playing.';
  const cameraNote = final && !combined ? '<p class="lead-note">Images judge finds only. Joining does not sign you up for marketing.</p>' : '';
  const spectate = `<a class="join-spectate" href="${voteUrl}">Watch and vote <span aria-hidden="true">↗</span></a>`;
  return `<div class="card cardpad join-card ${combined ? `is-combined ${paired ? 'is-paired' : ''}` : ''}"><div class="lead-heading"><p class="eyebrow">01 / ${captureAtJoin ? 'Your details' : 'Get ready'}</p>${combined ? spectate : pages.length > 1 ? `<span class="lead-step-count">${app.leadPage + 1} / ${pages.length}</span>` : ''}</div><h1 class="section-title">${heading}</h1><p class="join-intro">${intro}</p><form id="consentForm" novalidate><div class="lead-fields-layout">${alias}${displayedFields.map(field => fieldMarkup(field, combined)).join('')}</div>${cameraNote}${consent}<p class="error" id="consentError" role="alert">${escapeHtml(app.error)}</p>${app.leadPage ? '<button type="button" class="lead-prev" data-action="join-previous">← Previous fields</button>' : ''}<div class="actions">${button(final ? 'CHECK CAMERA' : 'CONTINUE', 'consent-next', false, false, 'submit')}</div></form>${first && !combined ? spectate : ''}</div>`;
}

function followupMarkup(settings) {
  const pages = leadFieldPages({ ...settings, timing: 'join' });
  app.followupPage = Math.max(0, Math.min(app.followupPage, pages.length - 1));
  const final = app.followupPage === pages.length - 1;
  const heading = app.leadIntent === 'expert' ? 'Talk to a<br>Twilio expert.' : 'Get the<br>build guide.';
  const intro = app.leadIntent === 'expert' ? 'Leave your details so the booth team can follow up.' : 'Tell us where to send your guide.';
  const action = final ? app.leadIntent === 'expert' ? 'REQUEST AN EXPERT' : 'SEND ME THE GUIDE' : 'CONTINUE';
  return `<div class="card cardpad followup-card"><div class="lead-heading"><p class="eyebrow">Your choice · ${app.leadIntent === 'expert' ? 'Expert' : 'Build guide'}</p>${pages.length > 1 ? `<span class="lead-step-count">${app.followupPage + 1} / ${pages.length}</span>` : ''}</div><h1 class="section-title">${heading}</h1><p class="join-intro">${intro}</p><form id="followupForm" novalidate><div class="lead-fields-layout">${pages[app.followupPage].map(fieldMarkup).join('')}</div><p class="error" id="followupError" role="alert">${escapeHtml(app.error)}</p><div class="followup-controls"><button type="button" class="lead-prev" data-action="followup-back">← ${app.followupPage ? 'Previous fields' : 'How it works'}</button></div><div class="actions">${button(app.followupBusy ? 'SAVING REQUEST…' : action, 'followup-next', false, app.followupBusy, 'submit')}</div></form><p class="lead-note">Your request is optional. It does not subscribe you to marketing.</p></div>`;
}

function joinRenderKey(settings) {
  return JSON.stringify({ page: app.leadPage, layout: leadLayoutKey(), busy: app.joinBusy, returningLead: app.returningLead, settings });
}

function render(force = false) {
  if (!app.event || !app.state) return;
  const lead = leadSettings();
  const view = currentView();
  const paused = Boolean(app.state.paused);
  if (view === 'decision' && (app.camera || app.media)) releaseMedia(true);
  // Preserve typed fields while live arena updates arrive. Rebuild only when
  // staff edit the configured form or the visitor changes form pages.
  if (view === 'consent' && screen.dataset.view === 'consent') {
    if (joinRenderKey(lead) === app.renderedLeadKey) {
      $('consentError').textContent = app.error;
      return;
    }
    syncJoinDraft();
    const allowed = new Set(lead.fields.map(field => field.id));
    for (const id of Object.keys(app.leadDraft.fieldValues)) {
      if (!allowed.has(id)) delete app.leadDraft.fieldValues[id];
    }
  }
  if (view === 'followup' && screen.dataset.view === 'followup') {
    const key = JSON.stringify({ page: app.followupPage, busy: app.followupBusy, intent: app.leadIntent, settings: lead });
    if (key === app.renderedFollowupKey) {
      $('followupError').textContent = app.error;
      return;
    }
    syncFollowupDraft();
  }
  const signature = JSON.stringify({ view, error: app.error, event: app.event, player: app.player?.id, slot: rosterPlayer()?.slot ?? app.player?.slot, status: app.player?.status, phase: phase(), paused, heat: app.state.heat, ready: app.state.readyCount, prompt: app.state.prompt, winners: app.outcome?.winners || app.state.winners, camera: !!app.camera, cameraBusy: app.cameraBusy, cameraHelp: app.cameraHelp, media: !!app.media, mediaBusy: !!app.mediaBusy, mediaLinkUp: app.mediaLinkUp, queuePosition: app.player?.queuePosition, queuedCount: app.state.queuedCount, joinBusy: app.joinBusy, replayBusy: app.replayBusy, leaveBusy: app.leaveBusy, replayExpired: app.replayExpired, returningLead: app.returningLead, leadPage: app.leadPage, leadIntent: app.leadIntent, followupPage: app.followupPage, followupBusy: app.followupBusy, buildProduct: app.buildProduct, connection: app.connection });
  if (!force && signature === app.lastRender) { updateClock(); return; }
  app.lastRender = signature;
  screen.dataset.view = view;
  const customEventName = String(app.event.name || '').trim();
  eventName.textContent = customEventName.toUpperCase() === 'LIVE SCAVENGER HUNT' ? '' : customEventName;
  eventName.hidden = !eventName.textContent;
  const fullModeLabel = isResultDemo ? 'Visual preview · no live camera' : app.event.mediaMode === 'twilio' ? 'Powered by Twilio Video' : app.event.mediaMode === 'rehearsal' ? 'Local rehearsal · camera snapshots' : 'Waiting for booth setup';
  const shortModeLabel = isResultDemo ? 'Visual preview' : app.event.mediaMode === 'twilio' ? 'Twilio Video' : app.event.mediaMode === 'rehearsal' ? 'Local rehearsal' : 'Booth setup';
  modeLabel.textContent = shortModeLabel;
  modeLabel.setAttribute('aria-label', fullModeLabel);
  $('leaveButton').hidden = isResultDemo || !app.token || app.returningLead || ['intro', 'consent', 'decision', 'left', 'removed'].includes(view);

  if (view === 'resuming') {
    screen.innerHTML = `<div class="card cardpad"><p class="eyebrow">Welcome back</p><h1 class="section-title">Finding your player.</h1><p class="body">${app.error ? escapeHtml(app.error) : 'Checking your spot at this event…'}</p>${app.error ? button('TRY AGAIN', 'reload') : ''}</div>`;
  } else if (view === 'intro') {
    screen.innerHTML = `<p class="eyebrow">A live camera game</p><h1 class="hero intro-title" aria-label="Live Scavenger Hunt">LIVE<br>SCAVENGER<br><em>HUNT.</em></h1><p class="sub">Find it. Show it. Beat the clock.</p>${playerVisual()}<div class="actions">${button('JOIN THE GAME', 'intro-next')}<p class="caption">${app.event.minPlayers || 2}–${app.event.maxPlayers || 6} players per heat · ${app.event.roundSeconds || 45}s standard round; some clues vary</p></div>`;
  } else if (view === 'consent') {
    screen.innerHTML = joinMarkup(lead);
    app.renderedLeadKey = joinRenderKey(lead);
  } else if (view === 'preview') {
    screen.innerHTML = `<p class="eyebrow">02 / Camera check</p><h1 class="section-title">Take your place.</h1>${preview()}<p class="caption">${app.returningLead ? 'Your player is saved. Check your camera, then rejoin the next heat.' : paused ? 'Booth paused. You can join now and wait for staff to resume.' : app.token ? 'Your spot is set. Go live when ready.' : app.camera ? 'Camera ready. Your spot is reserved when you go live.' : 'Allow camera access before reserving your spot.'}</p>${cameraHelpMarkup()}<p class="error" role="alert">${escapeHtml(app.error)}</p><div class="actions">${app.camera ? button(app.returningLead && app.replayBusy ? 'REJOINING…' : app.joinBusy ? 'RESERVING SPOT…' : app.event.mediaMode === 'unconfigured' ? 'WAITING FOR BOOTH SETUP' : paused ? 'JOIN GAME' : 'GO LIVE', 'join', false, app.joinBusy || app.replayBusy || app.event.mediaMode === 'unconfigured') : button(app.cameraBusy ? 'OPENING CAMERA…' : app.cameraHelp === 'another-tab' ? 'USE CAMERA HERE' : app.cameraHelp ? 'TRY CAMERA AGAIN' : 'ENABLE CAMERA', 'camera', false, app.cameraBusy)}${button(app.token && !app.returningLead ? 'LEAVE SPOT & VOTE' : 'WATCH & VOTE', 'spectate', true)}</div>${app.token && !app.returningLead ? '' : '<button type="button" class="preview-edit" data-action="edit-details">Edit your details</button>'}`;
  } else if (view === 'queued') {
    screen.innerHTML = queueMarkup();
  } else if (view === 'waiting') {
    const slot = rosterPlayer()?.slot ?? app.player?.slot;
    const needsReady = app.player?.status === 'joined';
    screen.innerHTML = `<p class="eyebrow">03 / Your spot is set</p><h1 class="hero">${paused ? 'BOOTH<br><em>PAUSED.</em>' : 'READY<br><em>TO GO.</em>'}</h1>${preview()}<div class="status">SLOT ${pad(slot)} · ${app.state.readyCount || 0} READY</div><p class="caption" data-join-status>${joinStatusText()}</p><p class="caption">${cameraOnline() ? paused ? 'Your camera is connected. Keep this page open until staff resume.' : needsReady ? 'Your camera is connected. Waiting for booth confirmation…' : 'You are live on the arena wall. The clue appears at GO.' : app.camera ? 'Connecting your camera to the arena…' : 'Your spot is open. Turn your camera back on to play.'}</p>${cameraHelpMarkup()}<p class="error" role="alert">${escapeHtml(app.error)}</p>${cameraOnline() && !needsReady ? '' : `<div class="actions">${button(app.camera ? 'RETRY CONNECTION' : app.cameraHelp === 'another-tab' ? 'USE CAMERA HERE' : 'RECONNECT CAMERA', 'retry-media', true, !!app.mediaBusy)}</div>`}`;
  } else if (view === 'countdown') {
    screen.innerHTML = paused
      ? `<p class="eyebrow">Heat ${pad(app.state.heat)} · Booth paused</p><div class="result-mark countdown-figure" aria-hidden="true">Ⅱ</div><h1 class="hero sealed-title">HEAT<br><em>PAUSED.</em></h1><p class="sub">The sealed countdown resumes when staff are ready. Tap Keep my spot if we check in.</p>${cameraOnline() ? '' : `<button type="button" class="hunt-reconnect" data-action="retry-media">Reconnect camera ↗</button>${cameraHelpMarkup()}`}`
      : `<p class="eyebrow">Heat ${pad(app.state.heat)} · Stand by</p><div class="result-mark countdown-figure" data-clock>3</div><h1 class="hero sealed-title">CLUE<br><em>SEALED.</em></h1><p class="sub">Everyone sees the challenge at GO. Hold your camera steady.</p>${cameraOnline() ? '' : `<button type="button" class="hunt-reconnect" data-action="retry-media">Reconnect camera ↗</button>${cameraHelpMarkup()}`}`;
  } else if (view === 'hunt') {
    // The server omits prompt before GO. Never infer it from an event deck or a URL.
    const clue = app.state.prompt?.text || 'LOOK AT THE ARENA';
    const clueSize = clue.length > 80 ? 'is-extra-long' : clue.length > 50 ? 'is-long' : '';
    const reconnect = !cameraOnline();
    screen.innerHTML = `<p class="eyebrow">Heat ${pad(app.state.heat)} · ${paused ? 'Booth paused' : 'Find it first'}</p><h1 class="section-title hunt-prompt ${clueSize}">${escapeHtml(clue)}</h1><div class="status">${paused ? 'HEAT PAUSED' : '<span data-clock>00</span> SEC LEFT'}</div><div class="hunt-preview">${preview()}</div>${reconnect ? '<button type="button" class="hunt-reconnect" data-action="retry-media">Reconnect camera ↗</button>' : `<p class="caption">${paused ? 'Timer paused. Tap Keep my spot if we check in.' : 'Bring your find into the camera guide and hold it steady.'}</p>`}${cameraHelpMarkup()}<p class="error" role="alert">${escapeHtml(app.error)}</p>`;
  } else if (view === 'review') {
    screen.innerHTML = `<p class="eyebrow">Heat ${pad(app.state.heat)} · ${paused ? 'Booth paused' : 'Checking'}</p><h1 class="hero">${paused ? 'REVIEW<br><em>PAUSED.</em>' : 'DID YOU<br><em>FIND IT?</em>'}</h1>${playerVisual('REVIEWING FINDS')}<p class="sub">${paused ? 'Judging resumes when staff are ready. Tap Keep my spot if we check in.' : 'The judge is checking each find. Close calls can be ties.'}</p>${cameraOnline() ? '' : '<button type="button" class="hunt-reconnect" data-action="retry-media">Reconnect camera ↗</button>'}`;
  } else if (view === 'result') {
    const winners = app.outcome?.winners || app.state.winners || [];
    screen.innerHTML = resultMarkup(winners, app.outcome?.heat || app.state.heat);
  } else if (view === 'decision') {
    screen.innerHTML = decisionMarkup();
  } else if (view === 'demo-queued') {
    screen.innerHTML = `<p class="eyebrow">Visual preview · Next heat</p><h1 class="hero">NEXT<br><em>UP.</em></h1>${playerVisual('WAITING FOR A SPOT')}<p class="sub">Same phone, same player. Your camera reconnects when a spot opens.</p><div class="actions">${button('BACK TO RESULT', 'demo-result', true)}</div>`;
  } else if (view === 'build') {
    screen.innerHTML = buildMarkup(lead);
  } else if (view === 'followup') {
    screen.innerHTML = followupMarkup(lead);
    app.renderedFollowupKey = JSON.stringify({ page: app.followupPage, busy: app.followupBusy, intent: app.leadIntent, settings: lead });
  } else if (view === 'thanks') {
    const guideStatus = app.leadResult?.deliveryStatus;
    const followupDetail = app.leadIntent === 'expert'
      ? 'Your expert conversation request is saved. Visit the Twilio booth to keep talking.'
      : guideStatus === 'recent-request'
        ? 'A guide was requested for this address recently. Check your inbox or ask the Twilio team at the booth.'
        : guideStatus === 'pending-configuration'
          ? 'Your guide request is saved. Email delivery is being configured; ask the Twilio team at the booth.'
          : ['failed', 'needs-review', 'bounced', 'dropped'].includes(guideStatus)
            ? 'Your guide request is saved, but email delivery needs staff attention. Ask the Twilio team at the booth.'
            : 'Your build guide request is saved for this event. Visit the Twilio booth to keep the conversation going.';
    screen.innerHTML = `<p class="eyebrow">Request received</p><div class="result-mark">✓</div><h1 class="hero">YOU'RE<br><em>ALL SET.</em></h1><p class="sub">${followupDetail}</p><div class="actions"><a class="build-github is-primary" data-github-source="phone" href="${githubUrl}" target="_blank" rel="noopener noreferrer" aria-label="Star Live Scavenger Hunt on GitHub (opens in a new tab)"><span class="build-github-star" aria-hidden="true">★</span><span>Star this game on GitHub</span><span aria-hidden="true">↗</span></a><div class="build-next-links thanks-next-links"><button type="button" class="build-replay" data-action="build">More ways to connect</button><button type="button" class="build-replay" data-action="replay">Play next heat</button><button type="button" class="build-replay" data-action="leave">Leave game</button></div>${app.error ? `<p class="error" role="alert">${escapeHtml(app.error)}</p>` : ''}</div>`;
  } else if (view === 'left') {
    screen.innerHTML = `<p class="eyebrow">You left the game</p><div class="result-mark">↗</div><h1 class="hero">CAMERA<br><em>OFF.</em></h1><p class="sub">Your spot is open for someone else. Play again on this phone whenever you are ready.</p><div class="actions">${button(app.leaveBusy ? 'LEAVING…' : app.replayBusy ? 'REJOINING…' : 'PLAY AGAIN', app.token ? 'replay' : 'rejoin', false, app.leaveBusy || app.replayBusy)}</div>`;
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
function joinStatusText() {
  const ready = Number(app.state?.readyCount || 0);
  const minimum = Number(app.event?.minPlayers || 2);
  const maximum = Number(app.event?.maxPlayers || 6);
  if (app.state?.paused) return 'Your spot is held. Tap Keep my spot if we check in during the pause.';
  if (app.state?.readyDeadline && ['flexible', 'deadline'].includes(app.event?.startMode))
    return `${timeLeft(app.state.readyDeadline)}s left for more players to join.`;
  if (ready < minimum) return `Waiting for ${minimum - ready} more player${minimum - ready === 1 ? '' : 's'} · up to ${maximum} can join.`;
  if (app.event?.startMode === 'capacity') return `Waiting for ${maximum - ready} more player${maximum - ready === 1 ? '' : 's'} to fill the heat.`;
  if (app.event?.startMode === 'manual') return 'The booth team starts the heat when ready.';
  return `Room open for up to ${maximum} players.`;
}

function updateClock() {
  if (!app.state) return;
  refreshAtCountdownDeadline();
  const view = currentView();
  if (view === 'decision' && screen.dataset.view === 'result') { render(true); return; }
  const joinStatus = screen.querySelector('[data-join-status]');
  if (view === 'waiting' && joinStatus) joinStatus.textContent = joinStatusText();
  if (app.state.paused) return;
  const clock = screen.querySelector('[data-clock]');
  if (!clock) return;
  if (view === 'countdown') clock.textContent = timeLeft(app.state.countdownEndsAt) || 'GO';
  if (view === 'hunt') clock.textContent = pad(timeLeft(app.state.roundEndsAt));
}

async function cameraDimensions(video) {
  if (video.videoWidth && video.videoHeight) return true;
  await Promise.race([
    new Promise(resolve => video.addEventListener('loadedmetadata', resolve, { once: true })),
    new Promise(resolve => setTimeout(resolve, 5000)),
  ]);
  return Boolean(video.videoWidth && video.videoHeight);
}

function portraitStream(raw, video) {
  if (video.videoWidth <= video.videoHeight) return { stream: raw, canvas: null, timer: null };
  if (!HTMLCanvasElement.prototype.captureStream)
    return { stream: raw, canvas: null, timer: null };
  const canvas = document.createElement('canvas');
  canvas.width = 540;
  canvas.height = 960;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return { stream: raw, canvas: null, timer: null };
  context.fillStyle = '#06132c';
  const draw = () => {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (!sourceWidth || !sourceHeight) return;
    const scale = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
    const width = sourceWidth * scale;
    const height = sourceHeight * scale;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(video, 0, 0, sourceWidth, sourceHeight,
      (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  };
  draw();
  const timer = setInterval(draw, 1000 / 24);
  try {
    return { stream: canvas.captureStream(24), canvas, timer };
  } catch {
    clearInterval(timer);
    return { stream: raw, canvas: null, timer: null };
  }
}

async function enableCamera({ takeOver = false } = {}) {
  if (app.cameraBusy || app.camera) return;
  app.cameraBusy = true;
  app.error = '';
  try {
    if (!claimCameraLease(takeOver)) {
      app.cameraHelp = 'another-tab';
      throw new Error('Your camera is open in another tab. Continue there, or tap Use camera here.');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      app.cameraHelp = 'secure';
      activity('camera_failed');
      throw new Error('Camera access needs HTTPS or a supported browser. You can still watch and vote.');
    }
    app.cameraHelp = '';
    render(true);
    let raw;
    try {
      const videoConstraints = {
        facingMode: { ideal: app.cameraFacing },
        width: { ideal: 540 },
        height: { ideal: 960 },
      };
      if (navigator.mediaDevices.getSupportedConstraints?.().resizeMode)
        videoConstraints.resizeMode = { ideal: 'none' };
      raw = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false,
      });
      if (!ownsCameraLease() || !claimCameraLease()) {
        raw.getTracks().forEach(track => track.stop());
        app.cameraHelp = 'another-tab';
        throw new Error('Your camera moved to another tab. Tap Use camera here to move it back.');
      }
    } catch (error) {
      if (app.cameraHelp === 'another-tab') throw error;
      app.cameraHelp = ['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error?.name)
        ? 'permission' : 'hardware';
      activity('camera_failed');
      throw new Error(app.cameraHelp === 'permission'
        ? 'Camera access is blocked. Change this site’s camera permission, then tap Try camera again.'
        : 'The camera could not start. Check your device and try again.');
    }
    const source = document.createElement('video');
    source.muted = true;
    source.autoplay = true;
    source.playsInline = true;
    source.srcObject = raw;
    source.className = 'capture-source';
    document.body.append(source);
    source.play().catch(() => {});
    let portrait;
    try {
      if (!await cameraDimensions(source)) throw new Error('Camera preview did not start. Try enabling it again.');
      const actualFacing = raw.getVideoTracks()[0]?.getSettings?.()?.facingMode;
      if (['user', 'environment'].includes(actualFacing) && actualFacing !== app.cameraFacing)
        throw new Error(`${app.cameraFacing === 'environment' ? 'Rear' : 'Front'} camera is unavailable on this device.`);
      portrait = portraitStream(raw, source);
    } catch (error) {
      raw.getTracks().forEach(track => track.stop());
      source.remove();
      app.cameraHelp = 'hardware';
      activity('camera_failed');
      throw error;
    }
    app.cameraInput = raw;
    app.camera = portrait.stream;
    app.cameraVideo = source;
    app.cameraCanvas = portrait.canvas;
    app.cameraDrawTimer = portrait.timer;
    app.cameraHelp = '';
    raw.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (app.cameraInput !== raw) return;
      app.error = 'Your camera stopped. Reconnect it to keep playing.';
      releaseMedia(true);
      render(true);
    }, { once: true });
  } finally {
    app.cameraBusy = false;
    if (!app.camera) releaseCameraLease();
    render(true);
  }
}

async function switchCamera() {
  if (!app.camera || app.cameraBusy || app.mediaBusy) return;
  const previousFacing = app.cameraFacing;
  const live = Boolean(app.token && app.view === 'live' && hasSlot());
  releaseMedia(true);
  app.cameraFacing = previousFacing === 'user' ? 'environment' : 'user';
  try {
    await enableCamera();
  } catch (error) {
    app.cameraFacing = previousFacing;
    try {
      await enableCamera();
      if (live) await ensureMediaReady();
    } catch { /* Keep the original camera error visible for recovery. */ }
    throw error;
  }
  if (live) await ensureMediaReady();
}

function frameBlob(quality = 0.52, maxWidth = 360) {
  return new Promise(resolve => {
    const source = app.cameraVideo?.videoWidth && app.cameraVideo?.videoHeight
      ? app.cameraVideo : app.cameraCanvas;
    const sourceWidth = source?.videoWidth || source?.width;
    const sourceHeight = source?.videoHeight || source?.height;
    if (!sourceWidth || !sourceHeight) return resolve(null);
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(maxWidth, sourceWidth);
    canvas.height = Math.round(canvas.width * sourceHeight / sourceWidth);
    canvas.getContext('2d', { alpha: false }).drawImage(source, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(resolve, 'image/jpeg', quality);
  });
}

async function uploadFrame() {
  if (app.frameBusy || !app.token || !app.camera || !hasSlot() ||
    (app.mediaMode === 'twilio' && !app.mediaLinkUp)) return;
  if (!['lobby', 'countdown', 'locked', 'hunt', 'active', 'review', 'judging'].includes(phase())) return;
  app.frameBusy = true;
  try {
    let blob = await frameBlob();
    if (blob?.size > 150_000) blob = await frameBlob(0.36, 260);
    if (blob?.size && blob.size <= 150_000 && app.camera &&
      (app.mediaMode !== 'twilio' || app.mediaLinkUp))
      await request('/frame', { method: 'POST', body: blob, auth: true });
  } catch (error) {
    if (error.status === 401) await reconcileAfterUnauthorized();
  } finally { app.frameBusy = false; }
}

async function ensureMediaReady() {
  if (app.mediaBusy && app.mediaBusyGeneration === app.mediaGeneration) return app.mediaBusy;
  if (!app.camera || !app.token || !hasSlot()) return;
  if (!ownsCameraLease()) {
    cameraMovedToAnotherTab();
    return;
  }
  if (app.media && (app.player?.status !== 'joined' || phase() !== 'lobby')) return;
  const generation = app.mediaGeneration;
  app.mediaBusy = (async () => {
    if (!app.media) {
      const data = await request('/media-token', { auth: true });
      if (generation !== app.mediaGeneration) return;
      app.mediaMode = data.mode;
      if (data.mode === 'twilio') {
        if (!data.token || !data.roomName) throw new Error('Twilio Video is not ready for this heat. Ask the booth team for help.');
        const sdk = await import('/vendor/video-client.js');
        if (generation !== app.mediaGeneration) return;
        let linkUp = true;
        let disconnected = false;
        const connection = await sdk.connectPlayer({
          token: data.token,
          roomName: data.roomName,
          stream: app.camera,
          onDisconnected: () => {
            if (generation !== app.mediaGeneration) return;
            disconnected = true;
            linkUp = false;
            app.media = null;
            app.mediaLinkUp = false;
            stopFrameTimer();
            if (!app.outcome && hasSlot()) { app.error = 'Video disconnected. Tap retry to reconnect.'; render(true); }
          },
          onReconnecting: () => {
            if (generation !== app.mediaGeneration) return;
            linkUp = false;
            app.mediaLinkUp = false;
            stopFrameTimer();
            app.error = 'Video reconnecting…';
            render(true);
          },
          onReconnected: () => {
            if (generation !== app.mediaGeneration) return;
            linkUp = true;
            app.mediaLinkUp = true;
            startFrameTimer(1600);
            app.error = '';
            render(true);
          },
        });
        if (generation !== app.mediaGeneration || disconnected) {
          connection.disconnect?.();
          return;
        }
        app.media = connection;
        app.mediaLinkUp = linkUp;
        // Low-rate transient snapshots keep vision judging available if the wall
        // browser reconnects or has not been authenticated yet.
        if (linkUp) {
          await uploadFrame();
          if (generation === app.mediaGeneration && app.media && app.mediaLinkUp) startFrameTimer(1600);
        }
      } else if (data.mode === 'rehearsal') {
        app.media = { disconnect() {} };
        app.mediaLinkUp = true;
        await uploadFrame();
        startFrameTimer(800);
      } else {
        throw new Error('The booth has not configured a video mode yet.');
      }
    }
    app.error = app.mediaLinkUp ? '' : 'Video reconnecting…';
    render(true);
    if (generation !== app.mediaGeneration || app.player?.status !== 'joined' || phase() !== 'lobby') return;
    // The signed Video callback may arrive after the SDK connects. Give it
    // time without tearing down an otherwise healthy room connection.
    const readyDeadline = Date.now() + (app.mediaMode === 'twilio' ? 15_000 : 0);
    while (true) {
      try {
        const response = await request('/ready', { method: 'POST', auth: true });
        if (response.player) applyPrivatePlayer(response.player);
        if (response.state) applyState({ state: response.state });
        render(true);
        return;
      } catch (error) {
        if (error.status === 401) { await reconcileAfterUnauthorized(); return; }
        if (error.code !== 'media_required') throw error;
        if (Date.now() >= readyDeadline) {
          const delayed = new Error('Your video is connected, but the booth has not confirmed it yet. Tap Retry connection.');
          delayed.keepMedia = true;
          throw delayed;
        }
        await new Promise(resolve => setTimeout(resolve, 650));
      }
    }
  })().catch(error => {
    if (!error.keepMedia && generation === app.mediaGeneration) releaseMedia(false);
    throw error;
  }).finally(() => {
    if (app.mediaBusyGeneration !== generation) return;
    app.mediaBusy = null;
    app.mediaBusyGeneration = null;
    render(true);
  });
  app.mediaBusyGeneration = generation;
  return app.mediaBusy;
}

function stopFrameTimer() {
  if (app.frameTimer) clearInterval(app.frameTimer);
  app.frameTimer = null;
}

function startFrameTimer(intervalMs) {
  stopFrameTimer();
  app.frameTimer = setInterval(uploadFrame, intervalMs);
}

function releaseMedia(stopCamera) {
  if (app.resultReleaseTimer) clearTimeout(app.resultReleaseTimer);
  app.resultReleaseTimer = null;
  stopFrameTimer();
  app.mediaGeneration += 1;
  app.mediaLinkUp = false;
  app.media?.disconnect?.();
  app.media = null;
  if (stopCamera) {
    app.resultCameraStopAt = null;
    if (app.cameraDrawTimer) clearInterval(app.cameraDrawTimer);
    app.cameraDrawTimer = null;
    app.camera?.getTracks().forEach(track => track.stop());
    app.cameraInput?.getTracks().forEach(track => track.stop());
    app.camera = null;
    app.cameraInput = null;
    app.cameraCanvas = null;
    app.cameraVideo?.remove();
    app.cameraVideo = null;
    releaseCameraLease();
  }
}

async function reconnectCamera({ takeOver = false } = {}) {
  if (!app.camera) await enableCamera({ takeOver });
  await ensureMediaReady();
}

async function replayGame({ withLead = false } = {}) {
  if (app.replayBusy) return;
  if (!app.token) { app.view = 'intro'; render(true); return; }
  if (!withLead && openReturningLeadForm()) return;
  app.replayBusy = true;
  render(true);
  try {
    const settings = leadSettings();
    const lead = withLead && needsReturningLead() ? {
      fieldValues: Object.fromEntries(settings.fields.map(field => [field.id, app.leadDraft.fieldValues[field.id] || ''])),
    } : null;
    const response = await request('/replay', {
      method: 'POST', auth: true, ...(lead ? { body: { lead } } : {}),
    });
    setReplayPending(true);
    app.replayExpired = false;
    if (!withLead || !response.player?.slot) releaseMedia(true);
    applyPrivatePlayer(response.player);
    app.returningLead = false;
    app.outcome = null;
    app.view = 'live';
    app.error = '';
    applyState({ state: response.state });
    if (hasSlot()) await reconnectCamera();
    render(true);
  } catch (error) {
    if (error.status === 401) { sessionExpired(); return; }
    if (['join_lead_required', 'invalid_lead', 'lead_form_changed'].includes(error.code)) {
      try { await refreshPublicState(); } catch { /* Keep the saved form for retry. */ }
      try { applyPrivatePlayer((await request('/me', { auth: true })).player); }
      catch (refreshError) {
        if (refreshError.status === 401) { sessionExpired(); return; }
        if (refreshError.code === 'player_kicked') { sessionRemoved(); return; }
      }
      releaseMedia(true);
      if (openReturningLeadForm(error.message, withLead)) return;
    }
    throw error;
  } finally { app.replayBusy = false; render(true); }
}

function scheduleResultRelease() {
  if (app.resultReleaseTimer) clearTimeout(app.resultReleaseTimer);
  app.resultReleaseTimer = null;
  if (!app.camera) return;
  app.resultCameraStopAt ??= Date.now() + Math.min(35_000, (app.event?.resultSeconds || 15) * 1_000 + 2_000);
  const deadline = app.state.resultEndsAt ? new Date(app.state.resultEndsAt).getTime() : NaN;
  const serverDelay = Number.isFinite(deadline) ? deadline - now() + 400 : Infinity;
  const delay = Math.max(0, Math.min(serverDelay, app.resultCameraStopAt - Date.now()));
  app.resultReleaseTimer = setTimeout(() => releaseMedia(true), delay);
}

function sessionExpired() {
  if (!app.token) return;
  releaseMedia(true);
  setReplayPending(false);
  app.replayExpired = false;
  clearPlayerToken();
  app.token = null;
  app.player = null;
  app.leadResult = null;
  app.view = 'intro';
  app.error = 'Your session ended. Join a new heat to play again.';
  render(true);
}

function sessionRemoved() {
  if (!app.token || app.view === 'removed') return;
  closeSessionDialog();
  setReplayPending(false);
  app.replayExpired = false;
  app.view = 'removed';
  app.token = null;
  app.player = null;
  app.outcome = null;
  app.error = '';
  clearPlayerToken();
  releaseMedia(true);
  render(true);
}

function enterLeftSession(response) {
  releaseMedia(true);
  setReplayPending(false);
  app.replayExpired = false;
  applyPrivatePlayer(response.player);
  app.outcome = null;
  app.view = 'left';
  app.error = '';
  if (response.state) applyState({ state: response.state });
  if (!openReturningLeadForm()) render(true);
}

async function reconcileAfterUnauthorized() {
  if (!app.token) return;
  try {
    const response = await request('/me', { auth: true });
    if (response.player?.status === 'left') { enterLeftSession(response); return; }
    applyPrivatePlayer(response.player);
    if (response.state) applyState({ state: response.state });
    if (openReturningLeadForm()) return;
    render(true);
  } catch (error) {
    if (error.code === 'player_kicked') sessionRemoved();
    else if (error.status === 401 || error.status === 404) sessionExpired();
    else showError(error);
  }
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
    : app.camera ? 'Your camera will turn off and your spot will open for another player.'
      : 'Your spot will open for another player. You can rejoin later on this phone.';
  $('sessionStayButton').textContent = mode === 'idle' ? 'Keep my spot' : 'Keep playing';
  $('sessionLeaveButton').textContent = 'Leave game';
  $('sessionDialogCountdown').hidden = false;
  app.idlePromptAt = Date.now();
  if (!sessionDialog.open) sessionDialog.showModal();
}

async function leaveGame(destination = 'left') {
  closeSessionDialog();
  const token = app.token;
  app.leaveBusy = Boolean(token);
  if (destination === 'intro') app.token = null;
  setReplayPending(false);
  app.replayExpired = false;
  app.view = destination;
  app.player = token ? { ...app.player, status: 'left', slot: null, queuePosition: null } : null;
  app.outcome = null;
  app.error = '';
  app.consent = false;
  app.idleKey = null;
  app.idleSince = null;
  releaseMedia(true);
  if (destination === 'intro') {
    app.alias = '';
    app.consent = false;
    app.leadPage = 0;
    app.leadDraft = { fieldValues: {} };
  }
  render(true);
  if (!token) return;
  try {
    const response = await fetch(`${apiBase}/leave`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'same-origin',
      keepalive: true,
    });
    if (response.status === 401) {
      clearPlayerToken();
      if (destination === 'left') sessionExpired();
    }
    if (response.status === 403) {
      if (destination === 'left') sessionRemoved();
      else clearPlayerToken();
    }
  } catch { /* The server will also expire an abandoned player session. */ }
  finally { app.leaveBusy = false; render(true); }
}

function updateIdleCheck() {
  if (isResultDemo) return;
  const view = currentView();
  const idleView = ['preview', 'queued', 'waiting', 'review'].includes(view) ||
    (app.state?.paused && ['countdown', 'hunt'].includes(view));
  const eligible = !!app.token && idleView && ['preview', 'live'].includes(app.view) &&
    (view !== 'preview' || hasSlot());
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
    if (!app.sessionDialogMode && Date.now() - app.idleSince >= (view === 'preview' ? 60_000 : 180_000)) openSessionDialog('idle');
  }
  if (app.sessionDialogMode && app.idlePromptAt) {
    const remaining = Math.max(0, 30 - Math.floor((Date.now() - app.idlePromptAt) / 1_000));
    $('sessionDialogCountdown').textContent = `Spot releases in ${remaining}s`;
    if (!remaining) void leaveGame();
  }
}

async function joinAfterCamera() {
  if (app.joinBusy) return;
  if (!app.camera) throw new Error('Enable your camera before reserving a player spot.');
  app.joinBusy = true;
  app.error = '';
  render(true);
  try {
    const settings = leadSettings();
    const body = { alias: app.alias, displayConsent: app.consent };
    if (settings.enabled && settings.timing === 'join') {
      body.lead = {
        fieldValues: Object.fromEntries(settings.fields.map(field => [field.id, app.leadDraft.fieldValues[field.id] || ''])),
      };
    }
    const response = await request('/join', { method: 'POST', body });
    app.token = response.token;
    savePlayerToken(app.token);
    app.player = response.player;
    app.view = response.player.slot ? 'preview' : 'live';
    if (response.state) applyState({ state: response.state });
    app.error = '';
    render(true);
  } catch (error) {
    if (['invalid_lead', 'lead_form_changed', 'lead_disabled'].includes(error.code)) {
      app.leadPage = 0;
      try { applyState(await request('')); } catch { /* Keep the saved draft for retry. */ }
      releaseMedia(true);
      app.view = 'consent';
    }
    throw error;
  } finally {
    app.joinBusy = false;
    render(true);
  }
}

async function goLive() {
  if (!app.camera) throw new Error('Enable your camera before going live.');
  if (app.returningLead) { await replayGame({ withLead: true }); return; }
  if (!app.token) await joinAfterCamera();
  if (!app.token || !app.player) throw new Error('Your spot expired. Join again to play.');
  if (!hasSlot()) {
    app.view = 'live';
    releaseMedia(true);
    render(true);
    return;
  }
  app.view = 'live';
  app.error = '';
  render(true);
  if (hasSlot()) await ensureMediaReady();
}

function syncJoinDraft() {
  const form = $('consentForm');
  if (!form) return;
  const alias = form.elements.namedItem('alias');
  if (alias) app.alias = alias.value;
  const consent = form.elements.namedItem('consent');
  if (consent) app.consent = consent.checked;
  for (const input of form.querySelectorAll('[data-lead-field]')) app.leadDraft.fieldValues[input.dataset.leadField] = input.value.trim();
}

function validateCurrentJoinPage() {
  const form = $('consentForm');
  if (!form) return false;
  const alias = form.elements.namedItem('alias');
  if (alias) {
    app.alias = alias.value.trim().replace(/\s+/g, ' ');
    alias.setCustomValidity(app.alias.length < 2 || app.alias.length > 20 || /[<>\x00-\x1f\x7f]/.test(app.alias)
      ? 'Use 2–20 characters without < or >.' : '');
  }
  for (const input of form.querySelectorAll('[data-lead-field]')) {
    input.setCustomValidity('');
    if (input.type === 'tel' && input.value.trim()) {
      const digits = input.value.replace(/\D/g, '');
      if (!/^[+0-9().\-\s]+$/.test(input.value) || digits.length < 7 || digits.length > 20)
        input.setCustomValidity('Enter a phone number with at least seven digits.');
    }
  }
  const consent = form.elements.namedItem('consent');
  if (consent && !consent.checked) {
    app.error = 'Check the consent box to continue.';
    $('consentError').textContent = app.error;
    consent.focus();
    return false;
  }
  if (!form.reportValidity()) {
    const invalid = form.querySelector(':invalid');
    app.error = invalid?.validationMessage || 'Complete the required fields to continue.';
    $('consentError').textContent = app.error;
    invalid?.focus();
    return false;
  }
  syncJoinDraft();
  app.error = '';
  return true;
}

async function advanceConsent() {
  if (!validateCurrentJoinPage()) return;
  const settings = leadSettings();
  const pages = leadFieldPages(settings, true);
  if (app.leadPage < pages.length - 1) {
    app.leadPage += 1;
    render(true);
    return;
  }
  if (settings.enabled && settings.timing === 'join') {
    const missing = settings.fields.findIndex(field => field.required && !app.leadDraft.fieldValues[field.id]);
    if (missing >= 0) {
      app.leadPage = pageForLeadField(settings, missing);
      app.error = 'Complete the required field to continue.';
      render(true);
      return;
    }
    const contactIndex = settings.fields.findIndex(field => ['email', 'tel'].includes(field.type) && app.leadDraft.fieldValues[field.id]);
    if (contactIndex < 0) {
      app.leadPage = pageForLeadField(settings, settings.fields.findIndex(field => ['email', 'tel'].includes(field.type)));
      app.error = 'Add an email or phone number for booth follow-up.';
      render(true);
      return;
    }
  }
  app.view = 'preview';
  app.error = '';
  render(true);
}

function syncFollowupDraft() {
  const form = $('followupForm');
  if (!form) return;
  for (const input of form.querySelectorAll('[data-lead-field]')) app.leadDraft.fieldValues[input.dataset.leadField] = input.value.trim();
}

function validateCurrentFollowupPage() {
  const form = $('followupForm');
  if (!form) return false;
  for (const input of form.querySelectorAll('[data-lead-field]')) {
    input.setCustomValidity('');
    if (input.type === 'tel' && input.value.trim()) {
      const digits = input.value.replace(/\D/g, '');
      if (!/^[+0-9().\-\s]+$/.test(input.value) || digits.length < 7 || digits.length > 20)
        input.setCustomValidity('Enter a phone number with at least seven digits.');
    }
  }
  if (!form.reportValidity()) {
    const invalid = form.querySelector(':invalid');
    app.error = invalid?.validationMessage || 'Complete the required fields to continue.';
    $('followupError').textContent = app.error;
    invalid?.focus();
    return false;
  }
  syncFollowupDraft();
  app.error = '';
  return true;
}

async function advanceFollowup() {
  if (!validateCurrentFollowupPage()) return;
  const settings = leadSettings();
  const pages = leadFieldPages({ ...settings, timing: 'join' });
  if (app.followupPage < pages.length - 1) {
    app.followupPage += 1;
    render(true);
    return;
  }
  const missing = settings.fields.findIndex(field => field.required && !app.leadDraft.fieldValues[field.id]);
  if (missing >= 0) {
    app.followupPage = pages.findIndex(fields => fields.some(field => field.id === settings.fields[missing].id));
    app.error = 'Complete the required field to continue.';
    render(true);
    return;
  }
  const email = settings.fields.findIndex(field => field.type === 'email' && app.leadDraft.fieldValues[field.id]);
  const contact = settings.fields.findIndex(field => ['email', 'tel'].includes(field.type) && app.leadDraft.fieldValues[field.id]);
  if (contact < 0 || (app.leadIntent === 'guide' && email < 0)) {
    const index = app.leadIntent === 'guide'
      ? settings.fields.findIndex(field => field.type === 'email')
      : settings.fields.findIndex(field => ['email', 'tel'].includes(field.type));
    app.followupPage = Math.max(0, pages.findIndex(fields => fields.some(field => field.id === settings.fields[index]?.id)));
    app.error = app.leadIntent === 'guide' ? 'Enter an email address for the guide.' : 'Enter an email or phone number for follow-up.';
    render(true);
    return;
  }
  await requestFollowup(app.leadIntent, true);
}

async function requestFollowup(intent, includeFields = false) {
  if (app.followupBusy) return;
  app.followupBusy = true;
  app.error = '';
  render(true);
  try {
    const body = { intent };
    if (includeFields) {
      const settings = leadSettings();
      body.fieldValues = Object.fromEntries(settings.fields.map(field => [field.id, app.leadDraft.fieldValues[field.id] || '']));
    }
    app.leadResult = await request('/leads', { method: 'POST', auth: true, body });
    app.leadIntent = intent;
    app.view = 'thanks';
    app.error = '';
  } finally {
    app.followupBusy = false;
    render(true);
  }
}

function openFollowupForm(intent, { preserveDraft = false, message = '' } = {}) {
  const settings = leadSettings();
  app.leadIntent = intent;
  app.followupPage = 0;
  if (!preserveDraft) app.leadDraft = { fieldValues: {} };
  else {
    const allowed = new Set(settings.fields.map(field => field.id));
    app.leadDraft.fieldValues = Object.fromEntries(
      Object.entries(app.leadDraft.fieldValues).filter(([id]) => allowed.has(id)));
    if (intent === 'guide' && !settings.fields.some(field =>
      field.type === 'email' && app.leadDraft.fieldValues[field.id])) {
      const emailField = settings.fields.find(field => field.type === 'email');
      if (emailField) {
        const pages = leadFieldPages({ ...settings, timing: 'join' });
        app.followupPage = Math.max(0, pages.findIndex(fields =>
          fields.some(field => field.id === emailField.id)));
      }
    }
  }
  app.error = message;
  app.view = 'followup';
  activity('lead_form_opened');
  render(true);
}

screen.addEventListener('input', event => {
  if (event.target.id === 'alias') app.alias = event.target.value;
  if (event.target.id === 'alias' && app.view === 'consent' && app.error) {
    app.error = '';
    $('consentError').textContent = '';
  }
  if (event.target.dataset.leadField) {
    app.leadDraft.fieldValues[event.target.dataset.leadField] = event.target.value;
    if (app.view === 'followup' && app.error) {
      app.error = '';
      $('followupError').textContent = '';
    }
  }
});
screen.addEventListener('change', event => {
  if (event.target.id === 'consent') {
    app.consent = event.target.checked;
    if (app.view === 'consent' && app.error) {
      app.error = '';
      $('consentError').textContent = '';
    }
  }
});
screen.addEventListener('submit', async event => {
  if (event.target.id === 'consentForm') {
    event.preventDefault();
    try { await advanceConsent(); } catch (error) { showError(error); }
  }
  if (event.target.id === 'followupForm') {
    event.preventDefault();
    try { await advanceFollowup(); } catch (error) { showError(error); }
  }
});
screen.addEventListener('click', async event => {
  if (event.target.closest('[data-github-source]')) {
    activity('github_cta_opened', { source: 'phone' });
    return;
  }
  const productLink = event.target.closest('[data-twilio-product]');
  if (productLink) {
    activity('twilio_product_link_opened', { product: productLink.dataset.twilioProduct });
    return;
  }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  try {
    if (action === 'intro-next') { app.view = 'consent'; app.leadPage = 0; app.error = ''; if (leadSettings().enabled && leadSettings().timing === 'join') activity('lead_form_opened'); render(true); }
    if (action === 'camera') await enableCamera({ takeOver: app.cameraHelp === 'another-tab' });
    if (action === 'flip-camera') await switchCamera();
    if (action === 'join') await goLive();
    if (action === 'retry-media') {
      if (app.media && !app.mediaLinkUp) releaseMedia(false);
      if (!app.camera) await enableCamera({ takeOver: !ownsCameraLease() || app.cameraHelp === 'another-tab' });
      await ensureMediaReady();
    }
    if (action === 'edit-details') { releaseMedia(true); app.view = 'consent'; app.error = ''; render(true); }
    if (action === 'build') { const fromResult = ['result', 'decision'].includes(currentView()); releaseMedia(true); app.view = 'build'; app.error = ''; if (fromResult) { app.buildProduct = 'video'; activity('cta_opened'); } render(true); }
    if (action === 'spectate') {
      if (app.token && (hasSlot() || app.player?.status === 'queued')) await leaveGame('intro');
      else releaseMedia(true);
      location.assign(voteUrl);
      return;
    }
    if (action === 'join-previous') { syncJoinDraft(); app.leadPage = Math.max(0, app.leadPage - 1); app.error = ''; render(true); }
    if (action === 'build-product') {
      const product = event.target.closest('[data-product]')?.dataset.product;
      if (buildProducts[product]) { app.buildProduct = product; render(true); screen.querySelector(`[data-action="build-product"][data-product="${product}"]`)?.focus(); }
    }
    if (action === 'guide' || action === 'expert') {
      if (isResultDemo) return;
      activity(`${action}_cta_opened`);
      if (leadSettings().timing === 'after-play' && !app.leadResult?.leadId) openFollowupForm(action);
      else {
        try { await requestFollowup(action); }
        catch (error) {
          if (!['invalid_lead', 'lead_form_changed'].includes(error.code)) throw error;
          // An admin may switch to at-join capture while this visitor is already playing.
          openFollowupForm(action, { preserveDraft: true, message: error.message });
        }
      }
    }
    if (action === 'followup-back') {
      syncFollowupDraft();
      if (app.followupPage) app.followupPage -= 1;
      else app.view = 'build';
      app.error = '';
      render(true);
    }
    if (action === 'replay-demo' && isResultDemo) { app.outcome.decisionAt = now() + (app.event?.resultSeconds || 15) * 1_000; app.resultRevealSeen.clear(); render(true); }
    if (action === 'demo-result' && isResultDemo) { app.view = 'live'; app.outcome.decisionAt = now() + (app.event?.resultSeconds || 15) * 1_000; app.resultRevealSeen.clear(); render(true); }
    if (action === 'replay') await replayGame();
    if (action === 'leave') openSessionDialog('manual');
    if (action === 'leave-now') await leaveGame();
    if (action === 'demo-next' && isResultDemo) { app.view = 'demo-queued'; render(true); }
    if (action === 'demo-leave' && isResultDemo) { app.view = 'left'; render(true); }
    if (action === 'rejoin') { if (isResultDemo) initializeDemo(); else { app.view = 'intro'; app.error = ''; render(true); } }
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
  app.event = { name: 'Live Scavenger Hunt', mediaMode: 'rehearsal', resultSeconds: 15, leadCapture: { enabled: false } };
  app.token = null;
  app.state = { phase: 'result', heat: 4, winners, roster };
  app.player = { ...roster[0], heat: 4 };
  app.outcome = { heat: 4, winners, winnerNames: roster.filter(player => winners.includes(player.id)).map(player => player.alias),
    decisionAt: demoMode === 'decision' ? now() - 1 : now() + app.event.resultSeconds * 1_000 };
  app.view = demoMode === 'build' ? 'build' : 'live';
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
        applyPrivatePlayer(me.player);
        app.alias = me.player?.alias || '';
        if (me.player?.status === 'left') enterLeftSession(me);
        else {
          app.restoring = true;
          app.view = 'live';
          if (me.state) applyState({ state: me.state });
          app.restoring = false;
          if (!openReturningLeadForm() && hasSlot() && phase() !== 'result')
            app.error = 'Your camera is off in this tab. Tap Reconnect camera to keep playing.';
        }
      } catch (error) {
        app.restoring = false;
        if (error.code === 'player_kicked') sessionRemoved();
        else if (error.status === 401 || error.status === 404) sessionExpired();
        else { app.view = 'resuming'; showError(error); }
      }
    }
    render(true);
    const stream = new EventSource(`${apiBase}/stream`);
    stream.addEventListener('state', event => { try { applyState(JSON.parse(event.data)); } catch {} });
    stream.onerror = () => { app.connection = 'reconnecting'; };
    stream.onopen = () => { app.connection = 'live'; };
    setInterval(async () => {
      updateClock();
      if (app.token && app.player?.status !== 'left' && !['left', 'resuming', 'removed'].includes(app.view)) {
        try {
          const response = await request('/heartbeat', { method: 'POST', auth: true });
          if (response.player) applyPrivatePlayer(response.player);
          if (response.state) applyState({ state: response.state });
        } catch (error) { if (error.status === 401) await reconcileAfterUnauthorized(); }
      }
      if (Date.now() - app.lastPayloadAt > 12_000) {
        try { await refreshPublicState(); } catch { app.connection = 'reconnecting'; }
      }
    }, 5_000);
  } catch (error) {
    screen.innerHTML = `<div class="card cardpad"><p class="eyebrow">Connection interrupted</p><h1 class="section-title">The arena is offline.</h1><p class="body">${escapeHtml(error.message)}</p>${button('RETRY', 'reload')}</div>`;
  }
}
screen.addEventListener('click', event => { if (event.target.closest('[data-action="reload"]')) location.reload(); });
window.addEventListener('resize', () => {
  const nextPageSize = leadLayoutKey();
  if (app.view === 'consent' && nextPageSize !== renderedLeadPageSize) {
    syncJoinDraft();
    renderedLeadPageSize = nextPageSize;
    render(true);
  }
});
window.addEventListener('pagehide', () => releaseMedia(true));
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
window.addEventListener('storage', event => {
  if (event.key === cameraLeaseKey && !ownsCameraLease()) cameraMovedToAnotherTab();
});
setInterval(() => {
  if (!app.camera && !app.cameraBusy) return;
  if (!ownsCameraLease() || !claimCameraLease()) cameraMovedToAnotherTab();
}, 2_000);
setInterval(updateClock, 200);
setInterval(updateIdleCheck, 1_000);
initialize();
