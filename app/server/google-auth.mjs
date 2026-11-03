import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { AuthError } from './auth.mjs';

const FLOW_COOKIE = 'live_scavenger_google_flow';
const FLOW_SECONDS = 10 * 60;
const digest = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const equal = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
};

export function safeOperatorNext(value, defaultSlug = 'live-scavenger-hunt') {
  const fallback = `/e/${encodeURIComponent(defaultSlug)}/operator`;
  if (typeof value !== 'string' || value.length > 1024 || !value.startsWith('/') ||
      value.startsWith('//') || value.includes('\\')) return fallback;
  try {
    const url = new URL(value, 'https://booth.invalid');
    if (url.origin !== 'https://booth.invalid' ||
        !/^\/e\/[a-z0-9-]{1,80}\/(?:operator|metrics)\/?$/.test(url.pathname)) return fallback;
    return url.pathname + url.search + url.hash;
  } catch { return fallback; }
}

export class GoogleAuthService {
  constructor({ store, auth, publicBaseUrl = '', clientId = process.env.GOOGLE_CLIENT_ID,
    clientSecret = process.env.GOOGLE_CLIENT_SECRET, client = null } = {}) {
    if (!store?.sql || !auth) throw new Error('GoogleAuthService needs a Store and AuthService.');
    this.store = store;
    this.auth = auth;
    this.clientId = String(clientId || '').trim();
    this.clientSecret = String(clientSecret || '');
    this.publicBaseUrl = String(publicBaseUrl || '').replace(/\/+$/, '');
    this.secureCookies = this.publicBaseUrl.startsWith('https://');
    this.redirectUri = this.publicBaseUrl
      ? new URL('/api/auth/google/callback', this.publicBaseUrl).toString() : '';
    const url = this.publicBaseUrl ? new URL(this.publicBaseUrl) : null;
    const local = url && ['localhost', '127.0.0.1'].includes(url.hostname);
    this.configured = Boolean(this.clientId && this.clientSecret && url &&
      (url.protocol === 'https:' || (local && url.protocol === 'http:')));
    this.client = this.configured
      ? client || new OAuth2Client(this.clientId, this.clientSecret, this.redirectUri) : null;
  }

  enabled() { return this.configured; }

  flowCookie(value) {
    return `${FLOW_COOKIE}=${value}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=${FLOW_SECONDS}` +
      (this.secureCookies ? '; Secure' : '');
  }

  clearFlowCookie() {
    return `${FLOW_COOKIE}=; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT` +
      (this.secureCookies ? '; Secure' : '');
  }

  _requireEnabled() {
    if (!this.enabled()) throw new AuthError('Google sign-in is not configured.', 503, 'google_unavailable');
  }

  async start(next, defaultSlug) {
    this._requireEnabled();
    const state = token();
    const browser = token();
    const nonce = token();
    const { codeVerifier, codeChallenge } = await this.client.generateCodeVerifierAsync();
    if (!codeVerifier || !codeChallenge) throw new AuthError('Google sign-in could not start.', 503, 'google_unavailable');
    const now = new Date();
    const expiry = new Date(now.getTime() + FLOW_SECONDS * 1000);
    const nextPath = safeOperatorNext(next, defaultSlug);
    const authorizationUrl = this.client.generateAuthUrl({
      access_type: 'online', scope: ['openid', 'email', 'profile'], prompt: 'select_account',
      hd: 'twilio.com', state, nonce, code_challenge: codeChallenge, code_challenge_method: 'S256',
    });
    this.store.transaction(() => {
      this.store.sql.prepare('DELETE FROM google_oauth_flows WHERE expires_at <= ?').run(now.toISOString());
      this.store.sql.prepare('INSERT INTO google_oauth_flows(state_hash,browser_hash,nonce,code_verifier,next_path,expires_at,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(digest(state), digest(browser), nonce, codeVerifier, nextPath, expiry.toISOString(), now.toISOString());
    });
    return { authorizationUrl, cookie: this.flowCookie(browser) };
  }

  consumeFlow(state, cookieHeader) {
    this._requireEnabled();
    const browser = String(cookieHeader || '').slice(0, 8192)
      .match(/(?:^|;\s*)live_scavenger_google_flow=([^;]*)/)?.[1] || '';
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(String(state || '')) ||
        !/^[A-Za-z0-9_-]{40,100}$/.test(browser)) {
      throw new AuthError('Google sign-in expired. Try again.', 401, 'google_state');
    }
    const now = new Date().toISOString();
    return this.store.transaction(() => {
      const stateHash = digest(state);
      const flow = this.store.sql.prepare('SELECT * FROM google_oauth_flows WHERE state_hash=?').get(stateHash);
      this.store.sql.prepare('DELETE FROM google_oauth_flows WHERE state_hash=?').run(stateHash);
      this.store.sql.prepare('DELETE FROM google_oauth_flows WHERE expires_at <= ?').run(now);
      if (!flow || flow.expires_at <= now || !equal(flow.browser_hash, digest(browser))) {
        throw new AuthError('Google sign-in expired. Try again.', 401, 'google_state');
      }
      return flow;
    });
  }

  async complete(flow, code) {
    this._requireEnabled();
    if (typeof code !== 'string' || code.length < 1 || code.length > 4096)
      throw new AuthError('Google sign-in was cancelled or expired.', 401, 'google_failed');
    const { tokens } = await this.client.getToken({
      code, codeVerifier: flow.code_verifier, redirect_uri: this.redirectUri,
    });
    if (typeof tokens?.id_token !== 'string')
      throw new AuthError('Google did not return an identity token.', 401, 'google_failed');
    const ticket = await this.client.verifyIdToken({ idToken: tokens.id_token, audience: this.clientId });
    const payload = ticket.getPayload();
    if (!payload || !['https://accounts.google.com', 'accounts.google.com'].includes(payload.iss) ||
        !equal(payload.nonce, flow.nonce)) {
      throw new AuthError('Google sign-in could not be verified.', 401, 'google_failed');
    }
    if (![true, 'true'].includes(payload.email_verified) || String(payload.hd || '').toLowerCase() !== 'twilio.com' ||
        typeof payload.email !== 'string' || !/^[^@\s]+@twilio\.com$/i.test(payload.email)) {
      throw new AuthError('Use a verified @twilio.com Google Workspace account.', 403, 'google_domain');
    }
    return { session: this.auth.loginGoogleIdentity({ sub: payload.sub, email: payload.email,
      emailVerified: payload.email_verified, hostedDomain: payload.hd }),
      nextPath: flow.next_path };
  }
}
