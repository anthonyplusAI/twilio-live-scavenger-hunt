import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../db.mjs';
import { AuthService } from '../auth.mjs';
import { GoogleAuthService, safeOperatorNext } from '../google-auth.mjs';

function providerFixture() {
  const provider = { authorization: null, tokenRequest: null, verification: null, claims: {} };
  provider.client = {
    async generateCodeVerifierAsync() { return { codeVerifier: 'private-verifier', codeChallenge: 'public-challenge' }; },
    generateAuthUrl(options) {
      provider.authorization = options;
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      for (const [key, value] of Object.entries(options)) url.searchParams.set(key, Array.isArray(value) ? value.join(' ') : value);
      return url.toString();
    },
    async getToken(options) {
      provider.tokenRequest = options;
      return { tokens: { id_token: 'signed-id-token' } };
    },
    async verifyIdToken(options) {
      provider.verification = options;
      return { getPayload: () => ({
        iss: 'https://accounts.google.com', sub: 'google-subject-1', nonce: provider.authorization.nonce,
        email: 'person@twilio.com', email_verified: true, hd: 'twilio.com', ...provider.claims,
      }) };
    },
  };
  const store = new Store(':memory:');
  const auth = new AuthService({ store, publicBaseUrl: 'https://game.example.com' });
  const google = new GoogleAuthService({ store, auth, publicBaseUrl: 'https://game.example.com',
    clientId: 'test-client-id', clientSecret: 'test-client-secret', client: provider.client });
  return { store, auth, google, provider };
}

test('Google OAuth binds state to the browser, uses PKCE, and signs in a verified Twilio operator once', async () => {
  const { store, auth, google, provider } = providerFixture();
  try {
    assert.equal(google.enabled(), true);
    const start = await google.start('/e/live-scavenger-hunt/operator#team', 'live-scavenger-hunt');
    const url = new URL(start.authorizationUrl);
    assert.equal(url.hostname, 'accounts.google.com');
    assert.equal(url.searchParams.get('hd'), 'twilio.com');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('code_challenge'), 'public-challenge');
    assert.match(start.cookie, /HttpOnly; SameSite=Lax/);
    assert.match(start.cookie, /Secure/);
    const state = url.searchParams.get('state');
    assert.throws(() => google.consumeFlow(state, 'other=value'), { code: 'google_state' });
    const flow = google.consumeFlow(state, start.cookie.split(';')[0]);
    assert.equal(flow.next_path, '/e/live-scavenger-hunt/operator#team');
    assert.throws(() => google.consumeFlow(state, start.cookie.split(';')[0]), { code: 'google_state' });
    const result = await google.complete(flow, 'authorization-code');
    assert.equal(result.session.user.role, 'operator');
    assert.equal(result.session.user.username, 'person@twilio.com');
    assert.equal(result.session.user.authProvider, 'google');
    assert.equal(result.nextPath, flow.next_path);
    assert.equal(provider.tokenRequest.codeVerifier, 'private-verifier');
    assert.equal(provider.tokenRequest.redirect_uri, 'https://game.example.com/api/auth/google/callback');
    assert.equal(provider.verification.audience, 'test-client-id');
    assert.equal(auth.session(auth.cookie(result.session.token).split(';')[0]).user.role, 'operator');
  } finally { store.close(); }
});

test('Google OAuth refuses unverified, outside-domain, missing Workspace, and invalid-nonce claims', async () => {
  const { store, google, provider } = providerFixture();
  try {
    const invalid = [
      { email_verified: false },
      { email: 'person@example.com' },
      { hd: undefined },
      { hd: 'other.com' },
      { nonce: 'different-nonce' },
      { iss: 'https://issuer.example.com' },
    ];
    for (const claims of invalid) {
      provider.claims = claims;
      const start = await google.start('/e/live-scavenger-hunt/operator', 'live-scavenger-hunt');
      const state = new URL(start.authorizationUrl).searchParams.get('state');
      const flow = google.consumeFlow(state, start.cookie.split(';')[0]);
      await assert.rejects(() => google.complete(flow, 'authorization-code'));
      assert.equal(store.sql.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
    }
  } finally { store.close(); }
});

test('Google sign-in is disabled without a complete configuration and return paths stay local', async () => {
  const store = new Store(':memory:');
  try {
    const auth = new AuthService({ store });
    const google = new GoogleAuthService({ store, auth, publicBaseUrl: 'https://game.example.com',
      clientId: 'test-client-id', clientSecret: '' });
    assert.equal(google.enabled(), false);
    await assert.rejects(() => google.start('/e/live-scavenger-hunt/operator', 'live-scavenger-hunt'),
      { code: 'google_unavailable' });
    assert.equal(safeOperatorNext('//evil.example.com', 'live-scavenger-hunt'), '/e/live-scavenger-hunt/operator');
    assert.equal(safeOperatorNext('https://evil.example.com', 'live-scavenger-hunt'), '/e/live-scavenger-hunt/operator');
    assert.equal(safeOperatorNext('/api/admin/report', 'live-scavenger-hunt'), '/e/live-scavenger-hunt/operator');
  } finally { store.close(); }
});
