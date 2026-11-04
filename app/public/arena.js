const slug = decodeURIComponent(location.pathname.split('/')[2] || 'demo');
const apiBase = `/api/e/${encodeURIComponent(slug)}`;
const adminBase = `/api/admin/e/${encodeURIComponent(slug)}`;
const routeBase = `/e/${encodeURIComponent(slug)}`;
const githubRepoUrl = 'https://github.com/anthonyplusAI/twilio-live-scavenger-hunt';
const requestedDemo = new URLSearchParams(location.search).get('demo');
const previewMode = ['hunt', 'vote', 'win', 'lose', 'tie', 'no-match'].includes(requestedDemo) ? requestedDemo : null;
const screen = document.getElementById('screen');
const players = document.getElementById('players');
const field = document.getElementById('field');
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const pad = value => String(value || 0).padStart(2, '0');
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const countdownRetryDelays = [350, 700, 1_400, 2_800, 2_800];

const app = {
  event: null,
  state: null,
  serverOffset: 0,
  lastServerTime: 0,
  lastPayloadAt: 0,
  lastSnapshotAttemptAt: 0,
  snapshotRequest: null,
  countdownBoundaryKey: null,
  countdownBoundaryWake: null,
  countdownRefreshAttempts: 0,
  countdownNextAttemptAt: 0,
  resultFrameHeat: null,
  resultFrames: new Map(),
  resultFrameTried: new Set(),
  lastGoodFrames: new Map(),
  connected: false,
  mediaMode: null,
  mediaStatus: 'Connecting',
  mediaSession: null,
  mediaBusy: null,
  videoTracks: new Map(),
  frameBusy: new Set(),
  frameRetryAt: new Map(),
  evidenceSent: new Map(),
  evidenceBusy: new Set(),
  csrfToken: null,
  wallAuthorized: false,
  lastAuthCheckAt: 0,
  authBusy: null,
  tileSignature: '',
  renderSignature: '',
  previousPhase: null,
  previousCountdown: null,
  connectedHeat: null,
  resultEffectKey: null,
};

$('operatorLink').href = `${routeBase}/operator`;
$('joinLink').href = `${routeBase}/play`;
$('joinQr').src = `${apiBase}/qr.svg?target=play`;
$('voteLink').href = `${routeBase}/vote`;
$('voteQr').src = `${apiBase}/qr.svg?target=vote`;
$('githubStarLink').href = previewMode ? githubRepoUrl : `${routeBase}/github?source=arena_link`;
$('githubQr').src = `${apiBase}/qr.svg?target=github${previewMode ? '&preview=1' : ''}`;

const now = () => Date.now() + app.serverOffset;
const timeLeft = deadline => deadline ? Math.max(0, Math.ceil((new Date(deadline).getTime() - now()) / 1000)) : 0;
const roster = () => Array.isArray(app.state?.roster) ? app.state.roster : [];
const phase = () => app.state?.phase || 'lobby';
const winnerIds = () => Array.isArray(app.state?.winners) ? app.state.winners : [];

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  let value;
  try { value = await response.json(); } catch { value = {}; }
  if (!response.ok) {
    const error = new Error(value.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return value;
}

function countdownDeadline() {
  if (previewMode || app.state?.paused || !['countdown', 'locked'].includes(phase())) return null;
  const deadline = Date.parse(app.state?.countdownEndsAt || '');
  return Number.isFinite(deadline) ? deadline : null;
}

function resetCountdownBoundary() {
  clearTimeout(app.countdownBoundaryWake);
  app.countdownBoundaryWake = null;
  app.countdownBoundaryKey = null;
  app.countdownRefreshAttempts = 0;
  app.countdownNextAttemptAt = 0;
}

function trackCountdownBoundary() {
  const deadline = countdownDeadline();
  if (deadline === null) { resetCountdownBoundary(); return; }
  const key = `${app.state.heat}:${deadline}`;
  if (key !== app.countdownBoundaryKey) {
    resetCountdownBoundary();
    app.countdownBoundaryKey = key;
  }
  if (deadline > now() && !app.countdownBoundaryWake) {
    app.countdownBoundaryWake = setTimeout(() => {
      app.countdownBoundaryWake = null;
      maybeRefreshCountdown();
    }, Math.max(0, deadline - now() + 25));
  }
}

function maybeRefreshCountdown() {
  const deadline = countdownDeadline();
  if (deadline === null) { resetCountdownBoundary(); return; }
  trackCountdownBoundary();
  if (now() < deadline) return;
  clearTimeout(app.countdownBoundaryWake);
  app.countdownBoundaryWake = null;
  if (app.snapshotRequest || app.countdownRefreshAttempts >= countdownRetryDelays.length ||
      Date.now() < app.countdownNextAttemptAt) return;
  const attempt = app.countdownRefreshAttempts++;
  app.countdownNextAttemptAt = Date.now() + countdownRetryDelays[attempt];
  void refreshSnapshot();
}

function refreshSnapshot() {
  if (app.snapshotRequest) return app.snapshotRequest;
  app.lastSnapshotAttemptAt = Date.now();
  app.snapshotRequest = fetchJson(apiBase)
    .then(payload => { applyState(payload); return true; })
    .catch(() => { app.connected = false; return false; })
    .finally(() => { app.snapshotRequest = null; });
  return app.snapshotRequest;
}

function clearResultFrames() {
  for (const source of app.resultFrames.values()) {
    if (source.startsWith('blob:')) URL.revokeObjectURL(source);
  }
  app.resultFrames.clear();
  app.resultFrameTried.clear();
  app.resultFrameHeat = null;
}

function captureStill(element, { maxWidth = 480, maxHeight = 854, quality = .78 } = {}) {
  if (!element) return null;
  const video = element.tagName === 'VIDEO';
  const width = video ? element.videoWidth : element.naturalWidth;
  const height = video ? element.videoHeight : element.naturalHeight;
  if (!width || !height || (video && element.readyState < 2)) return null;
  try {
    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d', { alpha: false }).drawImage(element, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } catch { return null; }
}

function rememberPlayerFrame(playerId, element, force = false) {
  if (previewMode || !app.state || phase() === 'result' ||
      (!force && !roster().some(player => player.id === playerId && player.mediaConnected))) return;
  const previous = app.lastGoodFrames.get(playerId);
  if (!force && previous?.heat === app.state.heat && Date.now() - previous.at < 1_600) return;
  const source = captureStill(element, { maxWidth: 320, maxHeight: 568, quality: .62 });
  if (source) app.lastGoodFrames.set(playerId, { heat: app.state.heat, at: Date.now(), source });
}

function rememberLiveFrames() {
  if (app.event?.mediaMode !== 'twilio' || !app.wallAuthorized || phase() === 'result') return;
  for (const [playerId, { element }] of app.videoTracks) rememberPlayerFrame(playerId, element);
}

function captureResultFrames(nextState) {
  if (previewMode || nextState.phase !== 'result' || app.resultFrameHeat === nextState.heat) return;
  clearResultFrames();
  app.resultFrameHeat = nextState.heat;
  for (const player of nextState.roster || []) {
    const tile = [...players.children].find(child => child.dataset.playerId === player.id);
    const source = tile?.querySelector('video.feed-video, img.rehearsal-frame');
    const frame = captureStill(source) ||
      (app.lastGoodFrames.get(player.id)?.heat === nextState.heat ? app.lastGoodFrames.get(player.id).source : null);
    if (frame) app.resultFrames.set(player.id, frame);
  }
  app.lastGoodFrames.clear();
}

function showResultFrame(playerId, source) {
  if (phase() !== 'result') return;
  const tile = [...players.children].find(child => child.dataset.playerId === playerId);
  const art = tile?.querySelector('.feed-art');
  if (!art) return;
  let image = art.querySelector('.frozen-frame');
  if (!image) {
    image = document.createElement('img');
    image.className = 'feed-video frozen-frame';
    image.alt = '';
    art.append(image);
  }
  image.src = source;
  if (!art.querySelector('.freeze-tag')) {
    const tag = document.createElement('span');
    tag.className = 'freeze-tag';
    tag.textContent = 'FINAL FRAME';
    art.append(tag);
  }
  tile.classList.add('is-frozen');
}

async function fetchMissingResultFrame(playerId, heat) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (app.resultFrameHeat !== heat || phase() !== 'result') return;
    try {
      const response = await fetch(`${apiBase}/frame/${encodeURIComponent(playerId)}?t=${Date.now()}`,
        { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 404) return;
      if (response.ok) {
        if (!response.headers.get('Content-Type')?.startsWith('image/jpeg')) return;
        const blob = await response.blob();
        if (!blob.size) return;
        const source = URL.createObjectURL(blob);
        if (app.resultFrameHeat !== heat || phase() !== 'result' || !roster().some(player => player.id === playerId)) {
          URL.revokeObjectURL(source);
          return;
        }
        app.resultFrames.set(playerId, source);
        showResultFrame(playerId, source);
        return;
      }
      if (![401, 403, 429, 500, 502, 503, 504].includes(response.status)) return;
    } catch { /* A short network interruption can recover during the result hold. */ }
    if (attempt < 3) {
      await new Promise(resolve => setTimeout(resolve, [750, 1_500, 3_000][attempt]));
    }
  }
}

function requestMissingResultFrames() {
  if (previewMode || phase() !== 'result') return;
  const heat = app.state.heat;
  for (const player of roster()) {
    if (!player.slot || app.resultFrames.has(player.id) || app.resultFrameTried.has(player.id)) continue;
    app.resultFrameTried.add(player.id);
    void fetchMissingResultFrame(player.id, heat);
  }
}

function applyState(payload) {
  if (!payload?.state) return;
  const incomingVersion = Number(payload.state.version);
  const currentVersion = Number(app.state?.version);
  const incomingServerTime = payload.serverTime == null ? NaN : new Date(payload.serverTime).getTime();
  if (app.state && Number.isFinite(incomingVersion) && Number.isFinite(currentVersion) &&
      (incomingVersion < currentVersion ||
        (incomingVersion === currentVersion && Number.isFinite(incomingServerTime) &&
          incomingServerTime < app.lastServerTime))) return;
  const nextHeat = payload.state.heat;
  captureResultFrames(payload.state);
  if (payload.state.phase !== 'result' && app.resultFrameHeat !== null) clearResultFrames();
  if (payload.state.phase === 'lobby') {
    const currentIds = new Set((payload.state.roster || []).map(player => player.id));
    for (const id of app.lastGoodFrames.keys()) if (!currentIds.has(id)) app.lastGoodFrames.delete(id);
  }
  const previousMedia = new Map(roster().map(player => [player.id, player.mediaConnected]));
  if (app.connectedHeat != null && nextHeat !== app.connectedHeat) {
    const previousSession = app.mediaSession;
    app.mediaSession = null;
    clearTracks();
    app.lastGoodFrames.clear();
    previousSession?.disconnect();
    app.mediaStatus = 'Video reconnecting';
  }
  app.connectedHeat = nextHeat;
  if (payload.serverTime) app.serverOffset = new Date(payload.serverTime).getTime() - Date.now();
  if (Number.isFinite(incomingServerTime)) app.lastServerTime = incomingServerTime;
  if (payload.event) app.event = payload.event;
  app.state = payload.state;
  trackCountdownBoundary();
  const active = new Map(roster().map(player => [player.id, player]));
  for (const [id, { element }] of app.videoTracks) {
    if (!active.has(id)) {
      removeTrack(id, element);
      app.videoTracks.delete(id);
      app.evidenceSent.delete(id);
    } else if (previousMedia.get(id) && !active.get(id).mediaConnected) removeTrack(id, element);
    else if (!previousMedia.get(id) && active.get(id).mediaConnected) attachTrack(id, element);
  }
  app.lastPayloadAt = Date.now();
  app.connected = true;
  render();
  requestMissingResultFrames();
  ensureMedia().catch(() => {});
}

function activeVote() {
  const vote = app.state?.vote;
  return vote && ['open', 'active'].includes(vote.status) ? vote : null;
}

function setHeadline(text) {
  const node = $('headline');
  if (node.textContent !== text) {
    node.textContent = text;
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
  }
  node.classList.toggle('is-long', text.length > 29 && text.length <= 46);
  node.classList.toggle('is-extra-long', text.length > 46);
}

function render() {
  if (!app.event || !app.state) return;
  const currentPhase = phase();
  const vote = activeVote();
  const signature = JSON.stringify({
    event: app.event,
    mediaStatus: app.mediaStatus,
    phase: currentPhase,
    paused: app.state.paused,
    heat: app.state.heat,
    ready: app.state.readyCount,
    locked: app.state.lockedCount,
    prompt: app.state.prompt,
    winners: winnerIds(),
    roster: roster(),
    vote: vote && { id: vote.id, type: vote.type, status: vote.status },
  });
  if (signature === app.renderSignature) { updateClock(); return; }
  app.renderSignature = signature;
  screen.dataset.phase = currentPhase;
  screen.classList.toggle('is-no-match', currentPhase === 'result' && winnerIds().length === 0);
  $('eventName').textContent = app.event.name || 'Live Scavenger Hunt';
  document.title = `${app.event.name || 'Live Scavenger Hunt'} · Live arena`;
  $('heatNumber').textContent = previewMode ? 'PREVIEW' : `HEAT ${pad(app.state.heat || 1)}`;
  $('liveMark').textContent = app.mediaStatus;
  renderTiles();
  syncResultEffects();
  const voteOpen = Boolean(vote && !app.state.paused);
  screen.classList.toggle('has-active-vote', voteOpen);
  $('voteLink').hidden = !voteOpen;
  $('footerStatus').hidden = !!vote || !!app.state.paused || currentPhase !== 'result';

  if (app.state.paused) {
    $('eyebrow').textContent = 'Booth paused';
    setHeadline(currentPhase === 'lobby' ? 'BOOTH PAUSED.' : 'HEAT PAUSED.');
    $('subline').textContent = currentPhase === 'lobby'
      ? 'Scan to join now. Staff will resume the booth when ready.'
      : 'Scan to join the next heat. Play resumes after staff return.';
  } else if (vote) {
    $('eyebrow').textContent = 'Audience vote';
    setHeadline(vote.type === 'creative' ? 'CROWD, MAKE THE CALL.' : 'PICK A CATEGORY.');
    $('subline').textContent = vote.type === 'creative'
      ? 'Scan to choose a player. New players can still join.'
      : 'Scan to choose the next clue type. Waiting players keep their spots.';
  } else if (currentPhase === 'countdown' || currentPhase === 'locked') {
    $('eyebrow').textContent = 'The challenge is sealed';
    setHeadline('GET READY.');
    $('subline').textContent = 'Everyone sees the prompt at GO.';
  } else if (currentPhase === 'hunt' || currentPhase === 'active') {
    $('eyebrow').textContent = 'Find it first';
    // The public API omits this field until GO. Do not infer it from any deck.
    setHeadline(String(app.state.prompt?.text || 'GO!').toUpperCase());
    $('subline').textContent = 'Show it clearly to your camera.';
  } else if (currentPhase === 'review' || currentPhase === 'judging') {
    $('eyebrow').textContent = 'The find is in';
    setHeadline('CHECKING THE FIND.');
    $('subline').textContent = 'The referee is reviewing the evidence.';
  } else if (currentPhase === 'result') {
    const winners = winnerIds();
    const names = winners.map(id => roster().find(player => player.id === id)?.alias || 'Player');
    $('eyebrow').textContent = !winners.length ? 'The clock wins this one' : winners.length > 1 ? 'Two players found it' : 'First find confirmed';
    setHeadline(!winners.length ? 'NO MATCH.' : winners.length > 1 ? 'IT’S A TIE!' : `${names[0]} WINS!`);
    $('subline').textContent = !winners.length ? 'No verified find. Fresh clue coming up.' : winners.length > 1 ? `${names.join(' + ')} share the spotlight. Great hunt, everyone!` : 'What a find! Big cheers for everyone who played.';
    $('footerLine').textContent = 'Want to build this?';
    $('footerDetail').textContent = 'Ask us at the Twilio booth';
  } else {
    $('eyebrow').textContent = 'Find it first';
    setHeadline(roster().length ? 'CLAIM YOUR SPOT.' : 'LIVE SCAVENGER HUNT.');
    $('subline').textContent = lobbyMessage();
  }
  if (app.previousPhase === 'countdown' && currentPhase === 'hunt') {
    screen.classList.remove('show-go');
    void screen.offsetWidth;
    screen.classList.add('show-go');
    setTimeout(() => screen.classList.remove('show-go'), 900);
  }
  app.previousPhase = currentPhase;
  updateClock();
}

const cameraPortrait = '<svg class="camera-portrait" viewBox="0 0 160 200" aria-hidden="true" focusable="false"><path class="viewfinder" d="M18 46V29c0-7 4-11 11-11h17M114 18h17c7 0 11 4 11 11v17M18 154v17c0 7 4 11 11 11h17M114 182h17c7 0 11-4 11-11v-17"/><circle class="person-head" cx="80" cy="78" r="28"/><path class="person-shoulders" d="M29 170v-10c0-26 22-47 49-47h4c27 0 49 21 49 47v10H29Z"/><rect class="camera-badge" x="109" y="126" width="41" height="33" rx="8"/><path class="camera-glyph" d="M118 135h17v15h-17zM135 139l8-4v15l-8-4"/></svg>';

function tileMarkup(player, slot, winner, index) {
  const open = !player;
  const label = open ? 'Open spot' : player.alias || `Player ${pad(slot)}`;
  const finished = phase() === 'result' && !open;
  const status = winner ? winnerIds().length > 1 ? 'Co-winner' : 'Winner' : open ? 'Scan to play' : finished ? winnerIds().length ? 'Nice try' : 'Played' : player.mediaConnected ? 'Live' : player.status === 'ready' ? 'Ready' : 'Connecting';
  const accessibleLabel = open ? `Open camera spot ${pad(slot)}. Scan to play.` : `${label}${winner ? ', winner' : finished ? ', played this heat' : ', player'}`;
  const art = previewMode && !open ? `<img class="portrait-svg demo-portrait" src="/assets/arena-preview-player-${index + 1}.svg" alt="">` : `<div class="camera-placeholder">${cameraPortrait}</div>`;
  const stamp = winner ? `<div class="winner-stamp" aria-hidden="true"><span>✦</span><strong>${winnerIds().length > 1 ? 'Shared win' : 'First find'}</strong></div>` : '';
  return `<article class="player-tile ${open ? 'is-open' : 'is-ready'} ${winner ? 'is-winner' : finished && winnerIds().length ? 'is-played' : ''}" data-player-id="${open ? '' : escapeHtml(player.id)}" style="--tile-delay:${index * 55}ms" aria-label="${escapeHtml(accessibleLabel)}"><div class="feed-art">${art}</div>${stamp}<div class="tile-top"><span class="tile-number">${pad(slot)}</span><span class="tile-signal" aria-hidden="true"><i></i><i></i><i></i></span></div><div class="tile-bottom"><span class="tile-name">${escapeHtml(label)}</span><span class="tile-state">${status}</span></div></article>`;
}

function syncResultEffects() {
  const resultKey = phase() === 'result' ? `${app.state.heat}:${[...winnerIds()].sort().join(',')}` : null;
  if (resultKey === app.resultEffectKey) return;
  app.resultEffectKey = resultKey;
  const confetti = $('resultConfetti');
  confetti.replaceChildren();
  screen.classList.remove('show-result', 'has-winner', 'is-tie');
  if (resultKey === null) return;
  screen.classList.toggle('has-winner', winnerIds().length > 0);
  screen.classList.toggle('is-tie', winnerIds().length > 1);
  if (winnerIds().length) {
    const fragments = document.createDocumentFragment();
    for (let index = 0; index < 42; index += 1) {
      const piece = document.createElement('i');
      piece.style.setProperty('--x', `${(index * 37 + 11) % 100}%`);
      piece.style.setProperty('--delay', `${(index * 97) % 1020}ms`);
      piece.style.setProperty('--duration', `${2600 + (index * 71) % 1300}ms`);
      piece.style.setProperty('--drift', `${(index * 61) % 270 - 135}px`);
      piece.style.setProperty('--turn', `${index % 2 ? -720 : 720}deg`);
      fragments.append(piece);
    }
    confetti.append(fragments);
  }
  void screen.offsetWidth;
  screen.classList.add('show-result');
}

function renderTiles() {
  const active = roster().filter(player => player.slot).sort((a, b) => a.slot - b.slot);
  const max = clamp(app.event.maxPlayers || 6, 2, 6);
  const min = clamp(app.event.minPlayers || 2, 2, max);
  const inLobby = phase() === 'lobby';
  const count = inLobby ? clamp(Math.max(min, active.length + 1), 2, max) : clamp(Math.max(2, active.length), 2, max);
  const slots = Array.from({ length: count }, (_, index) => active.find(player => player.slot === index + 1) || null);
  // If a reconnect produced sparse slot numbers, keep everyone visible.
  for (const player of active) if (!slots.includes(player)) {
    const empty = slots.indexOf(null);
    if (empty >= 0) slots[empty] = player;
  }
  const signature = JSON.stringify({ slots: slots.map(player => player && [player.id, player.alias, player.status, player.mediaConnected, player.slot]), winners: winnerIds(), phase: phase() });
  if (signature === app.tileSignature) { layoutTiles(); return; }
  app.tileSignature = signature;
  players.dataset.slots = String(count);
  players.innerHTML = slots.map((player, index) => tileMarkup(player, player?.slot || index + 1, !!player && winnerIds().includes(player.id), index)).join('');
  if (phase() === 'result') {
    for (const [id, source] of app.resultFrames) showResultFrame(id, source);
  } else {
    for (const [id, track] of app.videoTracks) {
      if (roster().some(player => player.id === id && player.mediaConnected)) attachTrack(id, track.element);
    }
  }
  layoutTiles();
}

function layoutTiles() {
  const count = players.children.length;
  if (!count) return;
  const style = getComputedStyle(field);
  const width = field.clientWidth;
  const height = field.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  if (width <= 0 || height <= 0) return;
  const gap = clamp(Math.round(Math.min(width, height) * .021), 5, 18);
  let best = null;
  for (let rows = 1; rows <= Math.min(count, 3); rows += 1) {
    const columns = Math.ceil(count / rows);
    const tileWidth = Math.floor(Math.min((width - 3 - gap * (columns - 1)) / columns, ((height - 3 - gap * (rows - 1)) / rows) * 9 / 16));
    if (tileWidth < 1) continue;
    const tileHeight = tileWidth * 16 / 9;
    const score = tileWidth * tileHeight;
    if (!best || score > best.score) best = { rows, columns, tileWidth, tileHeight, score };
  }
  if (!best) return;
  players.style.setProperty('--tile-w', `${best.tileWidth}px`);
  players.style.setProperty('--tile-h', `${best.tileHeight}px`);
  players.style.setProperty('--tile-gap', `${gap}px`);
  players.style.width = `${best.columns * best.tileWidth + (best.columns - 1) * gap + 1}px`;
  players.dataset.layout = best.rows === 1 ? 'line' : 'stagger';
}

function lobbyMessage() {
  const ready = Number(app.state?.readyCount || 0);
  const minimum = Number(app.event?.minPlayers || 2);
  const maximum = Number(app.event?.maxPlayers || 6);
  if (app.state?.readyDeadline && ['flexible', 'deadline'].includes(app.event?.startMode))
    return `More players can join for ${timeLeft(app.state.readyDeadline)}s.`;
  if (ready < minimum)
    return `Need ${minimum - ready} more to start · Up to ${maximum} can play.`;
  if (app.event?.startMode === 'capacity') return `Waiting for ${maximum - ready} more to fill the heat.`;
  if (app.event?.startMode === 'manual') return 'The booth team starts when ready.';
  return `Up to ${maximum} can play this heat.`;
}

function updateClock() {
  if (!app.state || !app.event) return;
  const vote = activeVote();
  const currentPhase = phase();
  let value = '', label = '', progress = 0;
  if (app.state.paused) {
    value = 'II'; label = 'Paused'; progress = 50;
  } else if (vote) {
    const seconds = timeLeft(vote.closesAt);
    value = String(seconds); label = 'Vote';
    const duration = vote.type === 'creative' ? app.event.vote?.creativeWindowSeconds : app.event.vote?.windowSeconds;
    progress = clamp(seconds / Math.max(1, duration || 30) * 100, 0, 100);
  } else if (currentPhase === 'lobby') {
    value = String(app.state.readyCount || 0); label = 'Ready';
    $('subline').textContent = lobbyMessage();
    progress = clamp((app.state.readyCount || 0) / (app.event.minPlayers || 2) * 100, 0, 100);
  } else if (currentPhase === 'countdown' || currentPhase === 'locked') {
    const seconds = timeLeft(app.state.countdownEndsAt);
    value = seconds ? String(seconds) : '…'; label = seconds ? 'To go' : 'Starting'; progress = 100;
  } else if (currentPhase === 'hunt' || currentPhase === 'active') {
    const seconds = timeLeft(app.state.roundEndsAt);
    value = String(seconds); label = 'Seconds';
    progress = clamp(seconds / Math.max(1, app.state.prompt?.seconds || app.event.roundSeconds || 45) * 100, 0, 100);
  } else if (currentPhase === 'review' || currentPhase === 'judging') {
    value = '···'; label = 'Checking'; progress = 42;
  } else {
    value = winnerIds().length === 0 ? 'NO' : winnerIds().length > 1 ? 'TIE' : '1ST';
    label = winnerIds().length === 0 ? 'Match' : 'Result'; progress = 100;
  }
  $('clockValue').textContent = value;
  $('clockLabel').textContent = label;
  $('clock').style.setProperty('--clock-progress', `${progress}%`);
  if ((currentPhase === 'countdown' || currentPhase === 'locked') && value !== app.previousCountdown) {
    app.previousCountdown = value;
    const node = $('countdownNumber');
    node.textContent = value;
    node.classList.remove('bump');
    void node.offsetWidth;
    node.classList.add('bump');
  }
}

function playerIdFromIdentity(identity) {
  const exact = roster().find(player => player.id === identity);
  if (exact) return exact.id;
  return String(identity || '').split(':').at(-1);
}
function attachTrack(id, element) {
  if (phase() === 'result') return;
  const tile = [...players.children].find(child => child.dataset.playerId === id);
  if (!tile) return;
  const art = tile.querySelector('.feed-art');
  element.classList.add('feed-video');
  if (element.parentElement !== art) art.append(element);
  tile.classList.add('is-live');
  if (phase() !== 'result') tile.querySelector('.tile-state').textContent = 'Live';
}
function removeTrack(id, element) {
  rememberPlayerFrame(id, element, true);
  const tile = [...players.children].find(child => child.dataset.playerId === id);
  if (element.parentElement) element.remove();
  if (!tile) return;
  tile.classList.remove('is-live');
  if (phase() !== 'result') tile.querySelector('.tile-state').textContent = 'Connecting';
}
function clearTracks() {
  for (const [id, { element }] of app.videoTracks) removeTrack(id, element);
  app.videoTracks.clear();
  app.evidenceSent.clear();
}

async function wallSession() {
  if (app.authBusy) return app.authBusy;
  if (Date.now() - app.lastAuthCheckAt < 5000) return app.wallAuthorized;
  app.authBusy = (async () => {
    try {
      const session = await fetchJson('/api/auth/session');
      app.csrfToken = session.csrfToken;
      app.wallAuthorized = true;
      app.lastAuthCheckAt = Date.now();
      return true;
    } catch (error) {
      app.wallAuthorized = false;
      app.csrfToken = null;
      app.lastAuthCheckAt = Date.now();
      const connection = app.mediaSession;
      app.mediaSession = null;
      connection?.disconnect?.();
      clearTracks();
      app.lastGoodFrames.clear();
      for (const frame of players.querySelectorAll('.rehearsal-frame')) frame.remove();
      for (const tile of players.children) {
        tile.classList.remove('is-live');
        if (tile.dataset.playerId && phase() !== 'result') tile.querySelector('.tile-state').textContent = 'Connecting';
      }
      app.mediaStatus = error.status === 401 || error.status === 403 ? 'Sign in for video' : 'Video reconnecting';
      render();
      return false;
    }
  })().finally(() => { app.authBusy = null; });
  return app.authBusy;
}

async function ensureMedia() {
  if (!app.event || !app.state) return;
  if (!await wallSession()) return;
  if (app.event.mediaMode === 'rehearsal') {
    app.mediaMode = 'rehearsal';
    app.mediaStatus = 'Local rehearsal';
    render();
    return;
  }
  if (app.event.mediaMode !== 'twilio') {
    app.mediaMode = 'unconfigured';
    app.mediaStatus = 'Video setup needed';
    render();
    return;
  }
  if (app.mediaSession || app.mediaBusy) return app.mediaBusy;
  app.mediaBusy = (async () => {
    const requestedHeat = app.state.heat;
    const data = await fetchJson(`${adminBase}/media-token?role=wall`);
    if (data.mode !== 'twilio' || !data.token || !data.roomName) throw new Error('The wall video room is not ready.');
    const sdk = await import('/vendor/video-client.js');
    let connection;
    connection = await sdk.connectWall({
      token: data.token,
      roomName: data.roomName,
      onTrack: ({ identity, element, track }) => {
        const id = playerIdFromIdentity(identity);
        const previous = app.videoTracks.get(id);
        if (previous && previous.element !== element) removeTrack(id, previous.element);
        app.videoTracks.set(id, { element, track });
        if (roster().some(player => player.id === id && player.mediaConnected)) attachTrack(id, element);
      },
      onTrackRemoved: ({ identity, element }) => {
        const id = playerIdFromIdentity(identity);
        if (app.videoTracks.get(id)?.element === element) app.videoTracks.delete(id);
        removeTrack(id, element);
      },
      onDisconnected: () => {
        if (app.mediaSession !== connection) return;
        app.mediaSession = null;
        clearTracks();
        app.mediaStatus = 'Video reconnecting';
        render();
      },
    });
    if (app.state.heat !== requestedHeat) {
      connection.disconnect();
      return;
    }
    if (!app.wallAuthorized) {
      connection.disconnect();
      return;
    }
    app.mediaSession = connection;
    app.mediaMode = 'twilio';
    app.mediaStatus = 'Twilio Video live';
    render();
  })().catch(error => {
    app.mediaStatus = error.status === 401 || error.status === 403 ? 'Sign in for video' : 'Video reconnecting';
    render();
    throw error;
  }).finally(() => { app.mediaBusy = null; });
  return app.mediaBusy;
}

function refreshRehearsalFrames() {
  if (app.event?.mediaMode !== 'rehearsal' || !app.state || !app.wallAuthorized || phase() === 'result') return;
  for (const player of roster()) {
    if (!player.slot || !player.mediaConnected || app.frameBusy.has(player.id) || Date.now() < (app.frameRetryAt.get(player.id) || 0)) continue;
    const tile = [...players.children].find(child => child.dataset.playerId === player.id);
    if (!tile) continue;
    app.frameBusy.add(player.id);
    const image = new Image();
    image.onload = () => {
      if (phase() === 'result') { app.frameBusy.delete(player.id); return; }
      rememberPlayerFrame(player.id, image);
      const currentTile = [...players.children].find(child => child.dataset.playerId === player.id);
      if (currentTile) {
        let shown = currentTile.querySelector('.rehearsal-frame');
        if (!shown) {
          shown = document.createElement('img');
          shown.className = 'feed-video rehearsal-frame';
          shown.alt = '';
          currentTile.querySelector('.feed-art').append(shown);
        }
        shown.src = image.src;
        currentTile.classList.add('is-live');
        if (phase() !== 'result') currentTile.querySelector('.tile-state').textContent = 'Live';
      }
      app.frameRetryAt.delete(player.id);
      app.frameBusy.delete(player.id);
    };
    image.onerror = () => { app.frameRetryAt.set(player.id, Date.now() + 4_000); app.frameBusy.delete(player.id); };
    image.src = `${apiBase}/frame/${encodeURIComponent(player.id)}?t=${Date.now()}`;
  }
}

async function sendEvidence(playerId, video) {
  if (app.evidenceBusy.has(playerId) || !video?.videoWidth || !video?.videoHeight || video.readyState < 2) return;
  app.evidenceBusy.add(playerId);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(320, video.videoWidth);
    canvas.height = Math.round(canvas.width * video.videoHeight / video.videoWidth);
    canvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageBase64 = canvas.toDataURL('image/jpeg', 0.45).split(',')[1];
    await fetchJson(`${adminBase}/evidence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': app.csrfToken },
      body: JSON.stringify({ playerId, imageBase64 }),
    });
  } catch (error) {
    if (error.status === 401 || error.status === 403) app.csrfToken = null;
  } finally { app.evidenceBusy.delete(playerId); }
}
function sampleEvidence() {
  if (app.event?.mediaMode !== 'twilio' || !app.wallAuthorized || !app.csrfToken || phase() !== 'hunt' || app.state?.paused) return;
  if (!['rule', 'ai-assisted'].includes(app.state.prompt?.judgeMode)) return;
  // Keep aggregate wall evidence below the server's 100/minute event limit,
  // including six-player heats and admin-configured long rounds.
  const interval = Math.max(app.state.prompt.judgeMode === 'ai-assisted' ? 2800 : 1400, roster().length * 750);
  for (const [playerId, { element }] of app.videoTracks) {
    if (!roster().some(player => player.id === playerId && player.mediaConnected)) continue;
    if (Date.now() - (app.evidenceSent.get(playerId) || 0) < interval) continue;
    app.evidenceSent.set(playerId, Date.now());
    sendEvidence(playerId, element);
  }
}

async function initialize() {
  if (previewMode) {
    const requestedCountValue = new URLSearchParams(location.search).get('players');
    const requestedCount = requestedCountValue === null ? NaN : Number(requestedCountValue);
    const previewCount = Number.isInteger(requestedCount) ? clamp(requestedCount, 2, 6) : 4;
    const votePreview = previewMode === 'vote';
    const demoRoster = ['Maya', 'Jordan', 'Dev', 'Kai', 'Ari', 'Sam'].slice(0, previewCount).map((alias, index) => ({
      id: `preview-${alias.toLowerCase()}`, alias, slot: index + 1,
      status: votePreview ? 'ready' : 'finished', mediaConnected: true,
    }));
    const demoWinners = {
      win: [demoRoster[0].id], lose: [demoRoster[1].id],
      tie: [demoRoster[0].id, demoRoster[Math.min(2, previewCount - 1)].id], 'no-match': [],
    };
    app.event = { name: 'Live Scavenger Hunt', minPlayers: 2, maxPlayers: previewCount, roundSeconds: 45,
      vote: { windowSeconds: 30 }, mediaMode: 'rehearsal' };
    app.state = { phase: votePreview ? 'lobby' : previewMode === 'hunt' ? 'hunt' : 'result',
      heat: 1, readyCount: previewCount, lockedCount: votePreview ? 0 : previewCount,
      roster: demoRoster, winners: demoWinners[previewMode] || [],
      vote: votePreview ? { id: 'preview-category-vote', type: 'category', status: 'open',
        closesAt: new Date(Date.now() + 30_000).toISOString() } : null, paused: false,
      prompt: previewMode === 'hunt' ? { text: 'SHOW SOMETHING RED.', seconds: 20 } : null,
      roundEndsAt: previewMode === 'hunt' ? new Date(Date.now() + 14_000).toISOString() : null };
    app.mediaStatus = 'Visual preview';
    screen.classList.add('is-preview');
    $('previewReplay').hidden = previewMode === 'hunt' || votePreview;
    render();
    return;
  }
  if (!await refreshSnapshot()) {
    app.mediaStatus = 'Arena reconnecting';
    $('liveMark').textContent = app.mediaStatus;
    setHeadline('STAND BY.');
    $('subline').textContent = 'Connecting to the arena…';
  }
  const stream = new EventSource(`${apiBase}/stream`);
  stream.addEventListener('state', event => { try { applyState(JSON.parse(event.data)); } catch {} });
  stream.onopen = () => { app.connected = true; };
  stream.onerror = () => { app.connected = false; };
  setInterval(async () => {
    updateClock();
    maybeRefreshCountdown();
    refreshRehearsalFrames();
    rememberLiveFrames();
    sampleEvidence();
    if (Date.now() - app.lastPayloadAt > 12_000 &&
        Date.now() - app.lastSnapshotAttemptAt > 5_000) void refreshSnapshot();
  }, 700);
  setInterval(() => ensureMedia().catch(() => {}), 7_000);
}

if ('ResizeObserver' in window) new ResizeObserver(layoutTiles).observe(field);
else addEventListener('resize', layoutTiles);
addEventListener('pagehide', () => { app.mediaSession?.disconnect?.(); clearResultFrames(); app.lastGoodFrames.clear(); });

// Keep booth controls out of the audience-facing scene until staff interact
// with the display. A keyboard Tab reveals them before focus moves into the nav.
const displayTools = $('displayTools');
let displayToolsTimer = null;
function hideDisplayTools() {
  if (displayTools.contains(document.activeElement)) return;
  screen.classList.remove('controls-visible');
  displayTools.inert = true;
  displayTools.setAttribute('aria-hidden', 'true');
}
function scheduleDisplayToolsHide() {
  clearTimeout(displayToolsTimer);
  displayToolsTimer = setTimeout(hideDisplayTools, 5_000);
}
function showDisplayTools() {
  displayTools.inert = false;
  displayTools.setAttribute('aria-hidden', 'false');
  screen.classList.add('controls-visible');
  scheduleDisplayToolsHide();
}
addEventListener('pointermove', event => {
  if (event.pointerType !== 'touch') showDisplayTools();
}, { passive: true });
addEventListener('pointerdown', showDisplayTools, { passive: true });
addEventListener('keydown', event => {
  if (event.key === 'Escape' && screen.classList.contains('controls-visible')) {
    if (displayTools.contains(document.activeElement)) document.activeElement.blur();
    hideDisplayTools();
  } else if (event.key === 'Tab') showDisplayTools();
});
displayTools.addEventListener('focusin', showDisplayTools);
displayTools.addEventListener('focusout', scheduleDisplayToolsHide);
displayTools.addEventListener('click', event => {
  // Pointer clicks give buttons focus in some browsers. Release that focus so
  // the control strip can fade away after the next five seconds of inactivity.
  if (event.detail > 0 && displayTools.contains(document.activeElement)) document.activeElement.blur();
  scheduleDisplayToolsHide();
});
$('previewReplay').addEventListener('click', () => {
  if (!previewMode) return;
  app.resultEffectKey = null;
  app.renderSignature = '';
  render();
  const headline = $('headline');
  headline.classList.remove('flash');
  void headline.offsetWidth;
  headline.classList.add('flash');
});
initialize();
