import { createHmac, createPrivateKey, createPublicKey, createHash, randomBytes, verify, type JsonWebKey } from 'node:crypto';

/**
 * Player identity.
 *
 * Google: the browser gets an ID token from Google Identity Services; the server checks
 * its RS256 signature against Google's published keys, the audience (our client id), the
 * issuer and the expiry. Nothing else about the user is trusted from the client.
 *
 * NEAR account: every player gets an ed25519 key derived from a server secret and their
 * stable id (the Google `sub`). Its public key *is* a NEAR implicit account id (64 hex
 * characters). The player never sees a wallet; the operator relays their trades, and the
 * gold and badges sit under that account on chain. Because the key is derived, the same
 * Google account always maps to the same NEAR account, and a later "claim your account"
 * step can hand the key to the player.
 */

export interface GoogleIdentity {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
}

const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

const b64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export class GoogleVerifier {
  private keys = new Map<string, JsonWebKey>();
  private fetchedAt = 0;

  constructor(
    readonly clientId: string,
    private fetchImpl: typeof fetch = fetch,
    private now: () => number = Date.now,
    private ttlMs = 3600_000,
  ) {}

  private async key(kid: string): Promise<JsonWebKey> {
    if (!this.keys.has(kid) || this.now() - this.fetchedAt > this.ttlMs) {
      const res = await this.fetchImpl(GOOGLE_CERTS);
      if (!res.ok) throw new Error(`google certs ${res.status}`);
      const { keys } = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
      this.keys = new Map(keys.map((k) => [k.kid, k]));
      this.fetchedAt = this.now();
    }
    const k = this.keys.get(kid);
    if (!k) throw new Error('unknown signing key');
    return k;
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('malformed token');
    const [h, p, sig] = parts;
    let header: { alg?: string; kid?: string };
    try {
      header = JSON.parse(b64url(h).toString('utf8'));
    } catch {
      throw new Error('malformed token');
    }
    if (header.alg !== 'RS256' || !header.kid) throw new Error('unexpected token algorithm');
    const jwk = await this.key(header.kid);
    const ok = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' }), b64url(sig));
    if (!ok) throw new Error('bad signature');
    const c = JSON.parse(b64url(p).toString('utf8')) as Record<string, unknown>;
    const nowS = Math.floor(this.now() / 1000);
    if (!ISSUERS.has(String(c.iss))) throw new Error('wrong issuer');
    if (c.aud !== this.clientId) throw new Error('token is for another app');
    if (typeof c.exp !== 'number' || c.exp < nowS - 60) throw new Error('token expired');
    if (typeof c.iat === 'number' && c.iat > nowS + 300) throw new Error('token from the future');
    if (typeof c.sub !== 'string' || !c.sub) throw new Error('no subject');
    if (c.email !== undefined && c.email_verified === false) throw new Error('email not verified');
    return {
      sub: c.sub,
      email: typeof c.email === 'string' ? c.email : undefined,
      name: typeof c.name === 'string' ? c.name : typeof c.given_name === 'string' ? c.given_name : undefined,
      picture: typeof c.picture === 'string' ? c.picture : undefined,
    };
  }
}

// ---------------------------------------------------------------- derived NEAR accounts

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(buf: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(buf).toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export interface PlayerAccount {
  /** NEAR implicit account id: hex of the ed25519 public key */
  accountId: string;
  publicKey: string;
}

/** ed25519 public key (32 bytes) for a 32-byte seed. */
export function ed25519PublicFromSeed(seed: Buffer): Buffer {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
}

/** Deterministic ed25519 key for a player; the private part never leaves this function. */
export function derivePlayerAccount(secret: string, subject: string): PlayerAccount {
  const seed = createHmac('sha256', secret).update(`hearthmarket-player:${subject}`).digest();
  const pub = ed25519PublicFromSeed(seed);
  return { accountId: pub.toString('hex'), publicKey: `ed25519:${base58(pub)}` };
}

/** Engine player id for an identity: short, stable, not the raw email. */
export function playerIdFor(kind: 'google' | 'dev', subject: string): string {
  const h = createHash('sha256').update(`${kind}:${subject}`).digest('hex').slice(0, 12);
  return `${kind === 'google' ? 'g' : 'd'}-${h}`;
}

export function randomSecret() {
  return randomBytes(32).toString('hex');
}

export type HelloAuth = { kind: 'google'; idToken: string } | { kind: 'dev'; email?: string; name?: string };

export interface Session {
  playerId: string;
  name: string;
  account: string;
  auth: 'google' | 'dev';
}

export interface AuthConfig {
  googleClientId: string;
  /** allow the typed-email login (development) */
  devLogin: boolean;
  /** secret for derived player keys */
  playerKeySecret: string;
}

/** Turns a hello message into a session, or throws with a reason the client can show. */
export async function authenticate(auth: HelloAuth | undefined, legacy: { playerId?: string; name?: string }, cfg: AuthConfig, google?: GoogleVerifier): Promise<Session> {
  if (auth?.kind === 'google') {
    if (!google) throw new Error('Google sign-in is not configured on this server');
    const id = await google.verify(auth.idToken);
    const acct = derivePlayerAccount(cfg.playerKeySecret, `google:${id.sub}`);
    const name = (id.name ?? id.email?.split('@')[0] ?? 'player').slice(0, 32);
    return { playerId: playerIdFor('google', id.sub), name, account: acct.accountId, auth: 'google' };
  }
  if (!cfg.devLogin) throw new Error('Sign in with Google to play online');
  const raw = (auth?.kind === 'dev' ? auth.email ?? auth.name : legacy.playerId ?? legacy.name) ?? '';
  const subject = String(raw).trim().toLowerCase().slice(0, 128);
  if (!subject) throw new Error('enter an email');
  const name = String((auth?.kind === 'dev' ? auth.name : legacy.name) ?? subject.split('@')[0]).slice(0, 32);
  const acct = derivePlayerAccount(cfg.playerKeySecret, `dev:${subject}`);
  return { playerId: playerIdFor('dev', subject), name, account: acct.accountId, auth: 'dev' };
}
