import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { ValidationError } from './config.mjs';
import { buildReport, exportCsv } from './report.mjs';
import { submitLead } from './leads.mjs';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const HTML_ROUTES = { arena: 'arena.html', play: 'player.html', vote: 'vote.html', operator: 'operator.html', metrics: 'metrics.html' };
const ASSET_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
const VOTER_COOKIE = 'signal_stadium_voter';
const BODY_LIMIT = 240_000;
const statusFor = error => error.status || ({
  not_found: 404, unauthorized: 401, forbidden: 403, revision_conflict: 409,
  player_kicked: 403,
  duplicate_vote: 409, vote_closed: 409, media_required: 409, player_queued: 409,
  invalid_state: 409, rate_limited: 429, media_unavailable: 503,
}[error.code] || 400);

function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
function text(res, status, value, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(value);
}
function errorResponse(res, error) {
  if (res.headersSent) { res.end(); return; }
  const known = error instanceof ValidationError || error?.name === 'AuthError' || error?.name === 'MediaError';
  if (!known) console.error(error);
  const status = known ? statusFor(error) : 500;
  const body = { error: known ? error.message : 'An unexpected server error occurred.', code: known ? error.code : 'server_error' };
  if (error.currentRevision) body.currentRevision = error.currentRevision;
  if (error.retryAfterSeconds) res.setHeader('Retry-After', error.retryAfterSeconds);
  json(res, status, body);
}
function bearer(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+([A-Za-z0-9_-]{20,200})$/);
  if (!match) throw new ValidationError('Player session required.', 'unauthorized');
  return match[1];
}
async function readBuffer(req, maxBytes = BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new ValidationError('Request is too large.', 'body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
async function readJson(req, maxBytes = BODY_LIMIT) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json'))
    throw new ValidationError('Send JSON for this request.', 'invalid_content_type');
  try {
    const value = JSON.parse((await readBuffer(req, maxBytes)).toString('utf8'));
    if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new Error('object expected');
    return value;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError('The JSON request could not be read.', 'invalid_json');
  }
}
async function readForm(req) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!type.startsWith('application/x-www-form-urlencoded')) throw new ValidationError('Expected a Twilio form webhook.', 'invalid_content_type');
  const form = new URLSearchParams((await readBuffer(req, 32_000)).toString('utf8'));
  const params = {};
  for (const [key, value] of form) params[key] = value;
  return params;
}
function sameOrigin(req, publicBaseUrl) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const expected = publicBaseUrl ? new URL(publicBaseUrl).origin : `http://${req.headers.host}`;
    return new URL(origin).origin === expected;
  } catch { return false; }
}
function safePath(pathname) {
  const relative = pathname.replace(/^\/+/, '');
  if (!/^(?:[a-z0-9-]+\.(?:html|js|css)|assets\/[a-z0-9._-]+|vendor\/[a-z0-9._-]+)$/i.test(relative)) return null;
  const target = resolve(PUBLIC_DIR, relative);
  return target.startsWith(PUBLIC_DIR + sep) ? target : null;
}
async function serveFile(res, pathname) {
  const path = safePath(pathname);
  if (!path) return false;
  let contents;
  try { contents = await readFile(path); } catch { return false; }
  const extension = path.slice(path.lastIndexOf('.'));
  text(res, 200, contents, ASSET_TYPES[extension] || 'application/octet-stream');
  return true;
}
function voterCookie(req, res, secure) {
  const current = String(req.headers.cookie || '').match(/(?:^|;\s*)signal_stadium_voter=([A-Za-z0-9_-]{20,100})(?:;|$)/)?.[1];
  if (current) return current;
  const value = randomBytes(32).toString('base64url');
  res.setHeader('Set-Cookie', `${VOTER_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? '; Secure' : ''}`);
  return value;
}

class Limiter {
  constructor() { this.buckets = new Map(); }
  check(key, limit, windowMs) {
    const now = Date.now();
    const previous = this.buckets.get(key);
    const current = previous && previous.until > now ? previous : { count: 0, until: now + windowMs };
    current.count++;
    this.buckets.set(key, current);
    if (this.buckets.size > 10_000) {
      for (const [name, bucket] of this.buckets) if (bucket.until <= now) this.buckets.delete(name);
      while (this.buckets.size > 10_000) this.buckets.delete(this.buckets.keys().next().value);
    }
    if (current.count > limit) {
      const error = new ValidationError('Too many requests. Try again shortly.', 'rate_limited');
      error.retryAfterSeconds = Math.ceil((current.until - now) / 1000);
      throw error;
    }
  }
}

export function createHttpServer({ store, engine, auth, media, judge, integrations,
  publicBaseUrl = '', defaultSlug = 'live-scavenger-hunt' } = {}) {
  const limiter = new Limiter();
  const secure = publicBaseUrl.startsWith('https://');
  const onPlayerRemoved = ({ event, player, status }) => {
    if (status === 'kicked') return; // The command route awaits this removal and reports its outcome.
    void media.disconnectPlayer(event, player).catch(error => {
      console.error(`Video disconnect for removed player ${player.id}: ${error.message}`);
    });
  };
  engine.on('player-removed', onPlayerRemoved);

  const stream = (req, res, slug, role = 'public') => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const authorized = () => {
      if (role !== 'operator') return true;
      try { auth.require(req.headers.cookie, 'operator'); return true; }
      catch { res.end(); return false; }
    };
    const send = () => {
      if (res.destroyed || res.writableEnded || !authorized()) return;
      const payload = engine.snapshot(slug, role);
      res.write(`id: ${payload.state.version}\nevent: state\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const onChange = eventSlug => { if (eventSlug === slug) send(); };
    engine.on('change', onChange);
    const keepalive = setInterval(() => { if (!res.destroyed && !res.writableEnded && authorized()) res.write(': heartbeat\n\n'); }, 15_000);
    keepalive.unref?.();
    res.on('close', () => { clearInterval(keepalive); engine.off('change', onChange); });
    send();
  };

  const handler = async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=()');
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const method = String(req.method || 'GET').toUpperCase();
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = url.pathname;
      const ip = req.socket.remoteAddress || 'unknown';
      const oldEventPath = pathname.match(/^\/(?:e|api\/e|api\/admin\/e)\/signal-stadium(?=\/|$)/);
      if (oldEventPath && !store.getEvent('signal-stadium') && store.getEvent('live-scavenger-hunt')) {
        res.writeHead(307, { Location: pathname.replace('/signal-stadium', '/live-scavenger-hunt') + url.search,
          'Cache-Control': 'no-store' });
        return res.end();
      }
      if (!['GET', 'HEAD'].includes(method) && !pathname.startsWith('/webhooks/') && !sameOrigin(req, publicBaseUrl))
        throw new ValidationError('Request origin does not match the booth.', 'invalid_origin');
      if (pathname === '/health' && method === 'GET') return json(res, 200, { ok: true, events: store.listEvents().length });
      if (pathname === '/' && method === 'GET') {
        res.writeHead(302, { Location: `/e/${encodeURIComponent(defaultSlug)}/arena`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (pathname === '/login' && method === 'GET') return void await serveFile(res, '/login.html');
      const page = pathname.match(/^\/e\/([^/]+)\/(arena|play|vote|operator|metrics)\/?$/);
      if (page && method === 'GET') {
        const slug = decodeURIComponent(page[1]);
        engine.event(slug);
        return void await serveFile(res, `/${HTML_ROUTES[page[2]]}`);
      }
      if (method === 'GET' && await serveFile(res, pathname)) return;

      if (pathname === '/api/auth/session' && method === 'GET') {
        const session = auth.require(req.headers.cookie);
        return json(res, 200, session);
      }
      if (pathname === '/api/auth/login' && method === 'POST') {
        limiter.check(`login:${ip}`, 30, 10 * 60_000);
        const body = await readJson(req, 8_000);
        const result = auth.login(body.username, body.password, ip);
        return json(res, 200, { user: result.user, csrfToken: result.csrfToken },
          { 'Set-Cookie': auth.cookie(result.token, { secure }) });
      }
      if (pathname === '/api/auth/logout' && method === 'POST') {
        auth.require(req.headers.cookie, 'operator', req.headers['x-csrf-token'] || '');
        auth.logout(req.headers.cookie);
        return json(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie({ secure }) });
      }

      const publicMatch = pathname.match(/^\/api\/e\/([^/]+)(?:\/(.*))?$/);
      if (publicMatch) {
        const slug = decodeURIComponent(publicMatch[1]), tail = publicMatch[2] || '';
        const event = engine.event(slug);
        if (method === 'GET' && !tail) return json(res, 200, engine.snapshot(slug));
        if (method === 'GET' && tail === 'stream') return stream(req, res, slug);
        if (method === 'GET' && tail === 'qr.svg') {
          const target = url.searchParams.get('target');
          if (!['play', 'vote'].includes(target)) throw new ValidationError('Choose a QR target.');
          const origin = publicBaseUrl || `http://${req.headers.host}`;
          const absolute = new URL(`/e/${encodeURIComponent(slug)}/${target}`, origin).toString();
          const svg = await QRCode.toString(absolute, { type: 'svg', margin: 1, width: 320,
            color: { dark: '#161E46', light: '#FFFFFFFF' } });
          return text(res, 200, svg, 'image/svg+xml', { 'Cache-Control': 'public, max-age=60' });
        }
        const frameMatch = tail.match(/^frame\/([^/]+)$/);
        if (method === 'GET' && frameMatch) {
          auth.require(req.headers.cookie, 'operator');
          const playerId = decodeURIComponent(frameMatch[1]);
          const visible = engine.snapshot(slug).state.roster.some(player => player.id === playerId);
          const buffer = visible ? media.getFrame(event.id, playerId) : null;
          if (!buffer) throw new ValidationError('Frame not available.', 'not_found');
          return text(res, 200, buffer, 'image/jpeg');
        }
        return await publicAction({ req, res, method, slug, tail, event, ip });
      }
      return await privateAction({ req, res, method, pathname, url, ip });
    } catch (error) { errorResponse(res, error); }
  };

  const publicAction = async ({ req, res, method, slug, tail, event, ip }) => {
    if (tail === 'join' && method === 'POST') {
      limiter.check(`join-booth:${slug}:${ip}`, 1800, 60_000);
      limiter.check(`join-browser:${slug}:${voterCookie(req, res, secure)}`, 8, 60_000);
      const body = await readJson(req, 4_000);
      return json(res, 201, engine.join(slug, body));
    }
    if (tail === 'me' && method === 'GET') return json(res, 200, engine.me(slug, bearer(req)));
    if (tail === 'ready' && method === 'POST') return json(res, 200, engine.ready(slug, bearer(req)));
    if (tail === 'heartbeat' && method === 'POST') return json(res, 200, engine.heartbeat(slug, bearer(req)));
    if (tail === 'leave' && method === 'POST') return json(res, 200, engine.leave(slug, bearer(req)));
    if (tail === 'media-token' && method === 'GET') {
      const token = bearer(req);
      const player = engine.player(slug, token);
      const result = await media.playerToken(event, player);
      if (result.mode !== 'unconfigured') engine.setTransport(slug, token, result.mode);
      return json(res, 200, result);
    }
    if (tail === 'frame' && method === 'POST') {
      const token = bearer(req);
      const player = engine.player(slug, token);
      limiter.check(`frame:${player.id}`, 5, 2000);
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('image/jpeg'))
        throw new ValidationError('Send one JPEG camera frame.', 'invalid_content_type');
      const buffer = await readBuffer(req, 150_000);
      const receipt = media.storeFrame(event.id, player.id, buffer);
      void judge.submit({ slug, playerId: player.id, buffer, receiptAt: Date.parse(receipt.receivedAt) })
        .catch(error => console.error(`Evidence review: ${error.message}`));
      return json(res, 200, { ok: true });
    }
    if (tail === 'votes' && method === 'POST') {
      limiter.check(`vote-booth:${slug}:${ip}`, 6000, 60_000);
      const voter = voterCookie(req, res, secure);
      limiter.check(`vote-browser:${slug}:${voter}`, 12, 60_000);
      const body = await readJson(req, 4_000);
      return json(res, 200, engine.castVote(slug, {
        windowId: String(body.windowId || ''), choice: String(body.choice || ''),
        voterHash: integrations.hashVoter('web', voter), channel: 'web',
      }));
    }
    if (tail === 'leads' && method === 'POST') {
      const token = bearer(req);
      const player = engine.player(slug, token);
      limiter.check(`lead:${player.id}`, 6, 60_000);
      const body = await readJson(req, 16_000);
      return json(res, 201, await submitLead({ store, engine, integrations, slug, token, input: body }));
    }
    if (tail === 'activity' && method === 'POST') {
      limiter.check(`activity-booth:${slug}:${ip}`, 12_000, 60_000);
      const visitor = voterCookie(req, res, secure);
      limiter.check(`activity-browser:${slug}:${visitor}`, 120, 60_000);
      const body = await readJson(req, 1_000);
      if (Object.keys(body).some(key => key !== 'type') || typeof body.type !== 'string')
        throw new ValidationError('Send only an allowed activity type.', 'invalid_activity');
      return json(res, 200, engine.activity(slug, body.type, {
        sessionId: integrations.hashVoter('session', visitor).slice(0, 20),
      }));
    }
    throw new ValidationError('Route not found.', 'not_found');
  };

  const privateAction = async ({ req, res, method, pathname, url, ip }) => {
    if (pathname === '/webhooks/twilio/messaging' && method === 'POST') {
      limiter.check(`message-webhook:${ip}`, 1000, 60_000);
      const result = integrations.messagingWebhook({ path: req.url, signature: req.headers['x-twilio-signature'], params: await readForm(req) });
      return text(res, result.status, result.body, result.contentType);
    }
    if (pathname === '/webhooks/twilio/video' && method === 'POST') {
      limiter.check(`video-webhook:${ip}`, 2000, 60_000);
      const result = integrations.videoWebhook({ path: req.url, signature: req.headers['x-twilio-signature'], params: await readForm(req) });
      return text(res, result.status, result.body, result.contentType);
    }
    if (pathname === '/api/admin/events') {
      if (method === 'GET') {
        auth.require(req.headers.cookie);
        return json(res, 200, { events: store.listEvents().map(event => ({
          id: event.id, slug: event.slug, name: event.name, revision: event.revision,
        })) });
      }
      if (method === 'POST') {
        const session = auth.require(req.headers.cookie, 'admin', req.headers['x-csrf-token'] || '');
        const body = await readJson(req, 4_000);
        const event = store.createEvent(body.name, body.slug);
        store.audit(event.id, session.user.id, 'event:created', { slug: event.slug });
        engine.emit('change', event.slug);
        return json(res, 201, { event });
      }
    }
    if (pathname === '/api/admin/report' && method === 'GET') {
      auth.require(req.headers.cookie, 'admin');
      const filters = Object.fromEntries(url.searchParams);
      return json(res, 200, buildReport(store, filters));
    }
    if (pathname === '/api/admin/export' && method === 'GET') {
      auth.require(req.headers.cookie, 'admin');
      const filters = Object.fromEntries(url.searchParams);
      const contents = exportCsv(store, filters);
      const kind = filters.kind === 'events' ? 'events' : 'leads';
      return text(res, 200, contents, 'text/csv; charset=utf-8', {
        'Content-Disposition': `attachment; filename="live-scavenger-hunt-${kind}.csv"`,
      });
    }
    const deleteLeadMatch = pathname.match(/^\/api\/admin\/leads\/([^/]+)$/);
    if (deleteLeadMatch && method === 'DELETE') {
      const session = auth.require(req.headers.cookie, 'admin', req.headers['x-csrf-token'] || '');
      const id = decodeURIComponent(deleteLeadMatch[1]);
      const lead = store.getLead(id);
      if (!lead) throw new ValidationError('Lead not found.', 'not_found');
      store.deleteLead(id);
      store.audit(lead.eventId, session.user.id, 'lead:deleted', { leadId: id });
      return json(res, 200, { ok: true });
    }
    const adminMatch = pathname.match(/^\/api\/admin\/e\/([^/]+)(?:\/(.*))?$/);
    if (adminMatch) {
      const slug = decodeURIComponent(adminMatch[1]), tail = adminMatch[2] || '';
      const event = engine.event(slug);
      if (method === 'GET' && !tail) {
        auth.require(req.headers.cookie);
        return json(res, 200, engine.snapshot(slug, 'operator'));
      }
      if (method === 'GET' && tail === 'stream') {
        auth.require(req.headers.cookie);
        return stream(req, res, slug, 'operator');
      }
      if (method === 'PUT' && !tail) {
        const session = auth.require(req.headers.cookie, 'admin', req.headers['x-csrf-token'] || '');
        const body = await readJson(req, 80_000);
        const updated = store.saveEvent(slug, body.event, body.expectedRevision);
        engine.configChanged(slug, event, updated);
        store.audit(updated.id, session.user.id, 'event:saved', { revision: updated.revision });
        engine.emit('change', slug);
        return json(res, 200, { event: updated });
      }
      if (method === 'POST' && tail === 'command') {
        const session = auth.require(req.headers.cookie, 'operator', req.headers['x-csrf-token'] || '');
        const body = await readJson(req, 8_000);
        const removed = body.type === 'kickPlayer' ? store.getPlayer(body.payload?.playerId) : null;
        const result = engine.command(slug, body.type, body.payload || {}, session.user);
        if (body.type === 'kickPlayer') {
          try {
            const disconnected = await media.disconnectPlayer(event, removed);
            return json(res, 200, { ...result, mediaDisconnect: { status: 'ok', ...disconnected } });
          } catch (error) {
            console.error(`Video disconnect for removed player ${removed?.id}: ${error.message}`);
            return json(res, 200, { ...result, mediaDisconnect: { status: 'failed' } });
          }
        }
        return json(res, 200, result);
      }
      if (method === 'GET' && tail === 'media-token') {
        auth.require(req.headers.cookie);
        if (url.searchParams.get('role') !== 'wall') throw new ValidationError('Choose the wall subscriber role.');
        return json(res, 200, await media.wallToken(event, engine.snapshot(slug).state.heat));
      }
      if (method === 'POST' && tail === 'evidence') {
        auth.require(req.headers.cookie, 'operator', req.headers['x-csrf-token'] || '');
        limiter.check(`evidence:${slug}:${ip}`, 100, 60_000);
        const body = await readJson(req, BODY_LIMIT);
        if (typeof body.playerId !== 'string' || typeof body.imageBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.imageBase64))
          throw new ValidationError('Send a player and JPEG evidence.', 'invalid_evidence');
        const buffer = Buffer.from(body.imageBase64, 'base64');
        const receipt = media.storeFrame(event.id, body.playerId, buffer);
        const receiptAt = Date.parse(receipt.receivedAt);
        const result = await judge.submit({ slug, playerId: body.playerId, buffer, receiptAt });
        return json(res, 200, { candidate: result.candidate, status: result.status });
      }
      if (method === 'GET' && tail === 'preflight') {
        auth.require(req.headers.cookie);
        const video = media.preflight();
        if (media.mode() === 'twilio' && !process.env.TWILIO_AUTH_TOKEN) {
          video.status = 'warning';
          video.detail = 'Set TWILIO_AUTH_TOKEN to validate Video status callbacks.';
        }
        return json(res, 200, { checks: [video, judge.preflight(), ...integrations.preflight(event)] });
      }
    }
    throw new ValidationError('Route not found.', 'not_found');
  };

  const server = createServer(handler);
  server.once('close', () => engine.off('player-removed', onPlayerRemoved));
  return server;
}
