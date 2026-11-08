import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';

const { checkIdToken, seal, unseal, authorizationUrl, pkceChallenge, hasPassword, GoogleAuthError } = await import('../src/lib/google.ts');
const { createApp } = await import('../src/app.ts');

/** unsigniertes ID-Token (die Signatur prüfen wir bewusst nicht, siehe lib/google.ts) */
const token = (claims: Record<string, unknown>) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
const valid = {
  iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID, sub: '1234567890',
  email: 'Tina@Example.com', email_verified: true, name: 'Tina Test', nonce: 'n-1',
  exp: Math.floor(Date.now() / 1000) + 600,
};

test('ID-Token: gültige Angaben werden übernommen', () => {
  const p = checkIdToken(token(valid), 'n-1');
  assert.deepEqual(p, { sub: '1234567890', email: 'tina@example.com', emailVerified: true, name: 'Tina Test' });
});

test('ID-Token: falscher Aussteller, Empfänger, Nonce oder abgelaufen wird abgelehnt', () => {
  for (const bad of [
    { ...valid, iss: 'https://evil.example' },
    { ...valid, aud: 'andere-app' },
    { ...valid, nonce: 'n-2' },
    { ...valid, exp: Math.floor(Date.now() / 1000) - 3600 },
    { ...valid, sub: '' },
  ]) assert.throws(() => checkIdToken(token(bad), 'n-1'), GoogleAuthError);
  assert.throws(() => checkIdToken('kaputt', 'n-1'), GoogleAuthError);
});

test('Signierte Cookies: unverändert lesbar, Manipulation und Ablauf erkannt', () => {
  const v = seal({ a: 1 }, 60_000);
  assert.equal(unseal<{ a: number }>(v)?.a, 1);
  const [body, mac] = v.split('.');
  const forged = Buffer.from(JSON.stringify({ a: 2, exp: Date.now() + 60_000 })).toString('base64url');
  assert.equal(unseal(`${forged}.${mac}`), null);
  assert.equal(unseal(`${body}.x${mac.slice(1)}`), null);
  assert.equal(unseal(seal({ a: 1 }, -1)), null);
});

test('Autorisierungs-URL enthält PKCE, State und Nonce', () => {
  const url = new URL(authorizationUrl({ state: 's', nonce: 'n', verifier: 'v', redirectUri: 'https://x.de/auth/google/callback' }));
  assert.equal(url.host, 'accounts.google.com');
  assert.equal(url.searchParams.get('code_challenge'), pkceChallenge('v'));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 's');
  assert.equal(url.searchParams.get('nonce'), 'n');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
});

test('Konten ohne Passwort werden erkannt', () => {
  assert.equal(hasPassword(''), false);
  assert.equal(hasPassword('scrypt$1$2$3$a$b'), true);
});

test('Routen: Weiterleitung zu Google, ungültiger State wird abgewiesen', async () => {
  const app = createApp();
  const res = await app.request('https://schottr.example.de/auth/google');
  assert.equal(res.status, 302);
  const target = new URL(res.headers.get('location')!);
  assert.equal(target.host, 'accounts.google.com');
  assert.equal(target.searchParams.get('redirect_uri'), 'https://schottr.example.de/auth/google/callback');
  const flowCookie = res.headers.getSetCookie().find((c) => c.startsWith('schottr_oidc='))!;
  assert.match(flowCookie, /HttpOnly/i);
  assert.match(flowCookie, /Path=\/auth\/google/);

  const cb = await app.request('https://schottr.example.de/auth/google/callback?code=abc&state=falsch', {
    headers: { cookie: flowCookie.split(';')[0] },
  });
  assert.equal(cb.status, 303);
  assert.equal(cb.headers.get('location'), '/login');
});
