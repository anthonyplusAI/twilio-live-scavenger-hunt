import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'signal_stadium_session';
const SESSION_SECONDS = 12 * 60 * 60;
const SCRYPT_OPTIONS = { N: 1 << 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SCRYPT_BYTES = 64;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_BLOCK_MS = 10 * 60 * 1000;
const MAX_FAILURES = 8;
const MAX_RATE_KEYS = 5000;

const tokenHash = token => createHash('sha256').update(token).digest('hex');
const issueToken = bytes => randomBytes(bytes).toString('base64url');
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
};
const publicUser = row => ({ id: row.id, username: row.username, role: row.role });

export class AuthError extends Error {
  constructor(message, status = 401, code = 'unauthorized', retryAfterSeconds = null) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.statusCode = status;
    this.code = code;
    if (retryAfterSeconds != null) this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class AuthService {
  constructor({ store, publicBaseUrl = '', bootstrapPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD } = {}) {
    if (!store?.sql) throw new Error('AuthService needs a Store with an initialized SQL database.');
    this.store = store;
    this.bootstrapPassword = bootstrapPassword;
    this.secureCookies = /^https:/i.test(String(publicBaseUrl));
    this.failures = new Map();
    this.dummySalt = randomBytes(16).toString('hex');
    this.dummyHash = randomBytes(SCRYPT_BYTES);
  }

  _normalizedUsername(username) {
    return String(username ?? '').trim().toLowerCase();
  }

  _hashPassword(password, salt) {
    return scryptSync(String(password), Buffer.from(salt, 'hex'), SCRYPT_BYTES, SCRYPT_OPTIONS);
  }

  _insertUser(username, password, role) {
    const normalized = this._normalizedUsername(username);
    if (!/^[a-z][a-z0-9._-]{2,79}$/.test(normalized)) {
      throw new AuthError('Use a username of 3–80 letters, numbers, dots, dashes, or underscores.', 400, 'invalid_username');
    }
    if (!['admin', 'operator'].includes(role)) {
      throw new AuthError('Choose an admin or operator role.', 400, 'invalid_role');
    }
    if (typeof password !== 'string' || password.length < 12 || password.length > 1024) {
      throw new AuthError('Password must be 12–1024 characters.', 400, 'invalid_password');
    }
    const salt = randomBytes(16).toString('hex');
    const passwordHash = this._hashPassword(password, salt).toString('hex');
    const user = { id: randomUUID(), username: normalized, role, createdAt: new Date().toISOString() };
    try {
      this.store.sql.prepare('INSERT INTO users(id,username,role,password_hash,salt,created_at) VALUES(?,?,?,?,?,?)')
        .run(user.id, user.username, user.role, passwordHash, salt, user.createdAt);
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed')) {
        throw new AuthError('Username already exists.', 409, 'username_exists');
      }
      throw error;
    }
    return user;
  }

  createUser(username, password, role = 'operator') {
    return this.store.transaction(() => this._insertUser(username, password, role));
  }

  bootstrap() {
    const configuredPassword = this.bootstrapPassword;
    if (configuredPassword !== undefined &&
      (typeof configuredPassword !== 'string' || configuredPassword.length < 24 || configuredPassword.length > 1024 ||
        configuredPassword.trim() !== configuredPassword || new Set(configuredPassword).size < 8)) {
      throw new AuthError('BOOTSTRAP_ADMIN_PASSWORD must be 24–1024 characters with at least 8 distinct characters and no surrounding whitespace.', 400, 'invalid_password');
    }
    let generated = null;
    const result = this.store.transaction(() => {
      this.store.sql.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
      const count = this.store.sql.prepare('SELECT COUNT(*) AS count FROM users').get().count;
      if (count) return { created: false };
      const username = 'admin';
      const password = configuredPassword === undefined ? issueToken(24) : configuredPassword;
      const user = this._insertUser(username, password, 'admin');
      if (configuredPassword === undefined) generated = { username, password };
      return { created: true, user: publicUser(user) };
    });
    if (generated) {
      console.log('\nLIVE SCAVENGER HUNT INITIAL ADMIN');
      console.log('Username: ' + generated.username);
      console.log('One-time password: ' + generated.password);
      console.log('Save this password now. It will not be printed again.\n');
    }
    return result;
  }

  _rateKey(requestIp) {
    return String(requestIp || 'unknown').trim().slice(0, 100) || 'unknown';
  }

  _rateRecord(key, now) {
    const record = this.failures.get(key);
    if (!record) return null;
    if (record.blockedUntil > now) return record;
    if (record.firstAt + RATE_WINDOW_MS <= now) {
      this.failures.delete(key);
      return null;
    }
    return record;
  }

  _checkRate(key, now) {
    const record = this._rateRecord(key, now);
    if (record?.blockedUntil > now) {
      throw new AuthError('Too many sign-in attempts. Try again shortly.', 429, 'rate_limited', Math.ceil((record.blockedUntil - now) / 1000));
    }
  }

  _recordFailure(key, now) {
    let record = this._rateRecord(key, now);
    if (!record) record = { firstAt: now, count: 0, blockedUntil: 0 };
    record.count++;
    if (record.count >= MAX_FAILURES) record.blockedUntil = now + RATE_BLOCK_MS;
    this.failures.delete(key);
    this.failures.set(key, record);
    while (this.failures.size > MAX_RATE_KEYS) this.failures.delete(this.failures.keys().next().value);
  }

  login(username, password, requestIp = 'unknown') {
    const now = Date.now();
    const key = this._rateKey(requestIp);
    this._checkRate(key, now);
    if (typeof password !== 'string' || password.length > 1024) {
      this._recordFailure(key, now);
      throw new AuthError('Invalid username or password.', 401, 'invalid_credentials');
    }
    const normalized = this._normalizedUsername(username);
    const row = normalized.length <= 80
      ? this.store.sql.prepare('SELECT * FROM users WHERE username=?').get(normalized)
      : null;
    const salt = row?.salt || this.dummySalt;
    let derived;
    try { derived = this._hashPassword(String(password ?? ''), salt); }
    catch { derived = this._hashPassword(String(password ?? ''), this.dummySalt); }
    const stored = row?.password_hash ? Buffer.from(row.password_hash, 'hex') : this.dummyHash;
    const valid = stored.length === SCRYPT_BYTES && timingSafeEqual(derived, stored);
    if (!row || !valid || typeof password !== 'string') {
      this._recordFailure(key, now);
      throw new AuthError('Invalid username or password.', 401, 'invalid_credentials');
    }
    this.failures.delete(key);
    this.store.sql.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date(now).toISOString());
    const token = issueToken(32);
    const csrfToken = issueToken(32);
    this.store.sql.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)')
      .run(tokenHash(token), row.id, csrfToken, new Date(now + SESSION_SECONDS * 1000).toISOString(), new Date(now).toISOString());
    return { user: publicUser(row), token, csrfToken };
  }

  _tokenFromCookie(cookieHeader) {
    const header = String(cookieHeader ?? '').slice(0, 8192);
    const match = header.match(/(?:^|;\s*)signal_stadium_session=([^;]*)/);
    const token = match?.[1] || '';
    return /^[A-Za-z0-9_-]{30,100}$/.test(token) ? token : null;
  }

  session(cookieHeader) {
    const token = this._tokenFromCookie(cookieHeader);
    if (!token) return null;
    const row = this.store.sql.prepare('SELECT users.id,users.username,users.role,sessions.csrf_token,sessions.expires_at ' +
      'FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=?').get(tokenHash(token));
    if (!row) return null;
    const expiresAt = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      this.store.sql.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
      return null;
    }
    return { user: publicUser(row), csrfToken: row.csrf_token };
  }

  require(cookieHeader, role = 'operator', csrfToken) {
    const current = this.session(cookieHeader);
    if (!current) throw new AuthError('Sign in to continue.', 401, 'unauthorized');
    if (!['operator', 'admin'].includes(role)) throw new AuthError('Unknown access role.', 500, 'invalid_role');
    if (role === 'admin' && current.user.role !== 'admin') {
      throw new AuthError('Admin access is required.', 403, 'forbidden');
    }
    if (!['admin', 'operator'].includes(current.user.role)) {
      throw new AuthError('This user cannot access booth operations.', 403, 'forbidden');
    }
    if (csrfToken !== undefined && (typeof csrfToken !== 'string' || !safeEqual(csrfToken, current.csrfToken))) {
      throw new AuthError('Security token expired. Reload and try again.', 403, 'csrf_invalid');
    }
    return current;
  }

  logout(cookieHeader) {
    const token = this._tokenFromCookie(cookieHeader);
    if (!token) return false;
    return this.store.sql.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token)).changes > 0;
  }

  cookie(token, { secure } = {}) {
    if (!/^[A-Za-z0-9_-]{30,100}$/.test(String(token))) throw new AuthError('Invalid session token.', 500, 'invalid_token');
    return COOKIE_NAME + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_SECONDS +
      ((secure ?? this.secureCookies) ? '; Secure' : '');
  }

  clearCookie({ secure } = {}) {
    return COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT' +
      ((secure ?? this.secureCookies) ? '; Secure' : '');
  }
}

export const sessionCookieName = COOKIE_NAME;
