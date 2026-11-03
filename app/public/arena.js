const slug = decodeURIComponent(location.pathname.split('/')[2] || 'demo');
const apiBase = `/api/e/${encodeURIComponent(slug)}`;
const adminBase = `/api/admin/e/${encodeURIComponent(slug)}`;
const routeBase = `/e/${encodeURIComponent(slug)}`;
const requestedDemo = new URLSearchParams(location.search).get('demo');
const previewMode = ['hunt', 'win', 'lose', 'tie', 'no-match'].includes(requestedDemo) ? requestedDemo : null;
const screen = document.getElementById('screen');
const players = document.getElementById('players');
const field = document.getElementById('field');
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const pad = value => String(value || 0).padStart(2, '0');
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const app = {
  event: null,
  state: null,
  serverOffset: 0,
  lastPayloadAt: 0,
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
  previousQrTarget: null,
  connectedHeat: null,
  resultEffectKey: null,
};

$('operatorLink').href = `${routeBase}/operator`;
$('joinLink').href = `${routeBase}/play`;

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

function applyState(payload) {
  if (!payload?.state) return;
  const nextHeat = payload.state.heat;
  if (app.connectedHeat != null && nextHeat !== app.connectedHeat && app.mediaSession) {
    app.mediaSession.disconnect();
    app.mediaSession = null;
    app.videoTracks.clear();
    app.evidenceSent.clear();
    app.mediaStatus = 'Video reconnecting';
  }
  app.connectedHeat = nextHeat;
  if (payload.serverTime) app.serverOffset = new Date(payload.serverTime).getTime() - Date.now();
  if (payload.event) app.event = payload.event;
  app.state = payload.state;
  app.lastPayloadAt = Date.now();
  app.connected = true;
  render();
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

function setQrTarget(target) {
  if (target === app.previousQrTarget) return;
  app.previousQrTarget = target;
  $('joinQr').src = `${apiBase}/qr.svg?target=${target}`;
  $('joinQr').alt = target === 'vote' ? 'Scan to vote on the next challenge' : 'Scan to join Live Scavenger Hunt';
  $('joinLink').href = `${routeBase}/${target === 'vote' ? 'vote' : 'play'}`;
  $('joinLink').setAttribute('aria-label', target === 'vote' ? 'Open spectator voting' : 'Open the player page');
  $('joinTitle').textContent = target === 'vote' ? 'Scan to vote' : 'Scan to play';
  $('joinDetail').textContent = 'Point your phone camera here';
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
  setQrTarget(vote ? 'vote' : 'play');
  $('footerStatus').hidden = !!vote || !!app.state.paused || currentPhase !== 'result';

  if (vote) {
    $('eyebrow').textContent = vote.type === 'creative' ? 'Audience vote' : 'Choose the next category';
    setHeadline(vote.type === 'creative' ? 'CROWD, MAKE THE CALL.' : 'YOU PICK WHAT’S NEXT.');
    $('subline').textContent = vote.type === 'creative' ? 'Scan to choose your favorite find.' : 'The clue stays secret until GO.';
  } else if (app.state.paused) {
    $('eyebrow').textContent = 'Stand by';
    setHeadline('HEAT PAUSED.');
    $('subline').textContent = 'The booth team will resume the game shortly.';
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
    $('subline').textContent = roster().length ? 'Scan to join the next round.' : 'Find it. Show it. Beat the clock.';
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
  for (const [id, track] of app.videoTracks) attachTrack(id, track.element);
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

function updateClock() {
  if (!app.state || !app.event) return;
  const vote = activeVote();
  const currentPhase = phase();
  let value = '', label = '', progress = 0;
  if (vote) {
    const seconds = timeLeft(vote.closesAt);
    value = String(seconds); label = 'Vote';
    const duration = vote.type === 'creative' ? app.event.vote?.creativeWindowSeconds : app.event.vote?.windowSeconds;
    progress = clamp(seconds / Math.max(1, duration || 30) * 100, 0, 100);
  } else if (app.state.paused) {
    value = 'II'; label = 'Paused'; progress = 50;
  } else if (currentPhase === 'lobby') {
    value = `${app.state.readyCount || 0}/${app.event.maxPlayers || 6}`; label = 'Ready';
    progress = clamp((app.state.readyCount || 0) / (app.event.maxPlayers || 6) * 100, 0, 100);
  } else if (currentPhase === 'countdown' || currentPhase === 'locked') {
    value = String(timeLeft(app.state.countdownEndsAt) || 0); label = 'To go'; progress = 100;
  } else if (currentPhase === 'hunt' || currentPhase === 'active') {
    const seconds = timeLeft(app.state.roundEndsAt);
    value = String(seconds); label = 'Seconds';
    progress = clamp(seconds / Math.max(1, app.state.prompt?.seconds || app.event.roundSeconds || 20) * 100, 0, 100);
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
  const tile = [...players.children].find(child => child.dataset.playerId === id);
  if (!tile) return;
  const art = tile.querySelector('.feed-art');
  element.classList.add('feed-video');
  if (element.parentElement !== art) art.append(element);
  tile.classList.add('is-live');
  if (phase() !== 'result') tile.querySelector('.tile-state').textContent = 'Live';
}
function removeTrack(id, element) {
  const tile = [...players.children].find(child => child.dataset.playerId === id);
  if (!tile) return;
  if (element.parentElement) element.remove();
  tile.classList.remove('is-live');
  if (phase() !== 'result') tile.querySelector('.tile-state').textContent = 'Connecting';
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
      for (const { element } of app.videoTracks.values()) element.remove();
      app.videoTracks.clear();
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
        if (previous && previous.element !== element) previous.element.remove();
        app.videoTracks.set(id, { element, track });
        attachTrack(id, element);
      },
      onTrackRemoved: ({ identity, element }) => {
        const id = playerIdFromIdentity(identity);
        if (app.videoTracks.get(id)?.element === element) app.videoTracks.delete(id);
        removeTrack(id, element);
      },
      onDisconnected: () => {
        if (app.mediaSession !== connection) return;
        app.mediaSession = null;
        app.videoTracks.clear();
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
  if (app.event?.mediaMode !== 'rehearsal' || !app.state || !app.wallAuthorized) return;
  for (const player of roster()) {
    if (!player.slot || !player.mediaConnected || app.frameBusy.has(player.id) || Date.now() < (app.frameRetryAt.get(player.id) || 0)) continue;
    const tile = [...players.children].find(child => child.dataset.playerId === player.id);
    if (!tile) continue;
    app.frameBusy.add(player.id);
    const image = new Image();
    image.onload = () => {
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
    if (!roster().some(player => player.id === playerId)) continue;
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
    const demoRoster = ['Maya', 'Jordan', 'Dev', 'Kai', 'Ari', 'Sam'].slice(0, previewCount).map((alias, index) => ({
      id: `preview-${alias.toLowerCase()}`, alias, slot: index + 1,
      status: 'finished', mediaConnected: true,
    }));
    const demoWinners = {
      win: [demoRoster[0].id], lose: [demoRoster[1].id],
      tie: [demoRoster[0].id, demoRoster[Math.min(2, previewCount - 1)].id], 'no-match': [],
    };
    app.event = { name: 'Live Scavenger Hunt', minPlayers: 2, maxPlayers: previewCount, roundSeconds: 20, mediaMode: 'rehearsal' };
    app.state = { phase: previewMode === 'hunt' ? 'hunt' : 'result', heat: 1, readyCount: previewCount, lockedCount: previewCount,
      roster: demoRoster, winners: demoWinners[previewMode] || [], vote: null, paused: false,
      prompt: previewMode === 'hunt' ? { text: 'SHOW SOMETHING RED.', seconds: 20 } : null,
      roundEndsAt: previewMode === 'hunt' ? new Date(Date.now() + 14_000).toISOString() : null };
    app.mediaStatus = 'Visual preview';
    screen.classList.add('is-preview');
    $('previewReplay').hidden = previewMode === 'hunt';
    render();
    return;
  }
  try { applyState(await fetchJson(apiBase)); }
  catch {
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
    refreshRehearsalFrames();
    sampleEvidence();
    if (Date.now() - app.lastPayloadAt > 12_000) {
      try { applyState(await fetchJson(apiBase)); } catch { app.connected = false; }
    }
  }, 700);
  setInterval(() => ensureMedia().catch(() => {}), 7_000);
}

if ('ResizeObserver' in window) new ResizeObserver(layoutTiles).observe(field);
else addEventListener('resize', layoutTiles);
addEventListener('pagehide', () => app.mediaSession?.disconnect?.());

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
