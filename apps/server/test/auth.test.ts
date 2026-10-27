import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { authenticate, base58, derivePlayerAccount, ed25519PublicFromSeed, GoogleVerifier, playerIdFor } from '../src/auth.ts';

const CLIENT = '1234-abc.apps.googleusercontent.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const NOW = 1_800_000_000_000;

function token(claims: Record<string, unknown>, key = privateKey, kid = 'k1') {
  const h = enc({ alg: 'RS256', kid, typ: 'JWT' });
  const p = enc({ iss: 'https://accounts.google.com', aud: CLIENT, sub: '10769150350006150715113082367', email: 'khang@example.com', email_verified: true, name: 'Khang', iat: NOW / 1000 - 10, exp: NOW / 1000 + 3600, ...claims });
  const sig = sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url');
  return `${h}.${p}.${sig}`;
}

let certFetches = 0;
const fakeFetch = (async () => {
  certFetches++;
  return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
}) as unknown as typeof fetch;
const verifier = () => new GoogleVerifier(CLIENT, fakeFetch, () => NOW);

describe('Google ID token verification', () => {
  it('accepts a valid token and caches Google keys', async () => {
    const v = verifier();
    certFetches = 0;
    const id = await v.verify(token({}));
    expect(id).toMatchObject({ sub: '10769150350006150715113082367', email: 'khang@example.com', name: 'Khang' });
    await v.verify(token({}));
    expect(certFetches).toBe(1);
  });
  it.each([
    ['another app', { aud: 'evil.apps.googleusercontent.com' }, 'token is for another app'],
    ['expired', { exp: NOW / 1000 - 3600 }, 'token expired'],
    ['wrong issuer', { iss: 'https://evil.example' }, 'wrong issuer'],
    ['unverified email', { email_verified: false }, 'email not verified'],
  ])('rejects %s', async (_n, claims, msg) => {
    await expect(verifier().verify(token(claims))).rejects.toThrow(msg);
  });
  it('rejects a token signed by someone else', async () => {
    await expect(verifier().verify(token({}, other.privateKey))).rejects.toThrow('bad signature');
  });
  it('rejects a token with an unknown key id or algorithm', async () => {
    await expect(verifier().verify(token({}, privateKey, 'nope'))).rejects.toThrow('unknown signing key');
    const t = token({}).split('.');
    t[0] = enc({ alg: 'none', kid: 'k1' });
    await expect(verifier().verify(t.join('.'))).rejects.toThrow('unexpected token algorithm');
  });
});

describe('player accounts', () => {
  it('derives ed25519 public keys correctly (RFC 8032 test 1)', () => {
    const seed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
    expect(ed25519PublicFromSeed(seed).toString('hex')).toBe('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    expect(base58(Uint8Array.from([0, 0, 1]))).toBe('112');
  });
  it('maps the same Google account to the same NEAR implicit account, and different ones apart', () => {
    const a = derivePlayerAccount('s3cret', 'google:1');
    expect(a.accountId).toMatch(/^[0-9a-f]{64}$/);
    expect(a.publicKey).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(derivePlayerAccount('s3cret', 'google:1')).toEqual(a);
    expect(derivePlayerAccount('s3cret', 'google:2').accountId).not.toBe(a.accountId);
    expect(derivePlayerAccount('other', 'google:1').accountId).not.toBe(a.accountId);
  });
  it('authenticates Google players and refuses typed emails when dev login is off', async () => {
    const cfg = { googleClientId: CLIENT, devLogin: false, playerKeySecret: 's' };
    const s = await authenticate({ kind: 'google', idToken: token({}) }, {}, cfg, verifier());
    expect(s).toMatchObject({ auth: 'google', name: 'Khang', playerId: playerIdFor('google', '10769150350006150715113082367') });
    expect(s.account).toBe(derivePlayerAccount('s', 'google:10769150350006150715113082367').accountId);
    await expect(authenticate({ kind: 'dev', email: 'khang@example.com' }, {}, cfg)).rejects.toThrow('Sign in with Google');
    await expect(authenticate(undefined, { playerId: 'khang' }, cfg)).rejects.toThrow('Sign in with Google');
  });
  it('keeps the typed-email login for development', async () => {
    const cfg = { googleClientId: '', devLogin: true, playerKeySecret: 's' };
    const s = await authenticate({ kind: 'dev', email: 'Khang@Example.com' }, {}, cfg);
    expect(s).toMatchObject({ auth: 'dev', name: 'khang' });
    expect(s.playerId).toBe(playerIdFor('dev', 'khang@example.com'));
    await expect(authenticate({ kind: 'google', idToken: 'x.y.z' }, {}, cfg)).rejects.toThrow('not configured');
  });
});
