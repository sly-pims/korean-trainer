import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const COOKIE_NAME = 'kt_session';
const SESSION_TTL_S = 30 * 24 * 60 * 60;

/**
 * scrypt parameters. Node's defaults are N=16384, r=8, p=1; they are written
 * into the hash string so a future change of these does not lock anyone out of
 * an account created under the old ones.
 */
const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const KEY_LEN = 64;

/**
 * Hashes a password for storage: `scrypt$N$r$p$salt$hash`, both parts hex.
 *
 * scrypt is in node:crypto, which keeps the app at zero native dependencies —
 * the same reason it does not use argon2 or bcrypt. A per-password random salt
 * means two people choosing the same password do not share a hash, and
 * `verifyPassword` is constant-time.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_LEN, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Checks a password against a stored hash. Never throws on a malformed hash. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'hex');
    expected = Buffer.from(parts[5]!, 'hex');
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;
  const actual = scryptSync(password, salt, expected.length, { N, r, p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Who a session belongs to, and which of their enrollments it has selected. */
export interface SessionIdentity {
  userId: number;
  enrollmentId: number;
}

export interface TokenIdentity extends SessionIdentity {
  /** Expiry, seconds since the epoch. */
  exp: number;
}

/**
 * Multi-user auth: a username plus a scrypt-hashed password, with an
 * HMAC-signed cookie carrying *both* the user and the active enrollment.
 *
 * The enrollment id is in the signed token rather than read from a request
 * parameter, so a caller cannot ask for somebody else's enrollment by editing a
 * number in a URL — the common path never trusts the client about who they are.
 * `activate()` re-signs a token with a different `eid`, which is the only way
 * the value legitimately changes.
 */
export class Auth {
  readonly cookieName = COOKIE_NAME;

  constructor(
    private secret: string,
    private secureCookie: boolean,
  ) {}

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  createToken(userId: number, enrollmentId: number, ttlS = SESSION_TTL_S): string {
    const payload = Buffer.from(
      JSON.stringify({ uid: userId, eid: enrollmentId, exp: Math.floor(Date.now() / 1000) + ttlS }),
    ).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  /** The identity in a token, or null if it is absent, forged or expired. */
  verifyToken(token: string | undefined): TokenIdentity | null {
    if (!token) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = Buffer.from(this.sign(payload));
    const actual = Buffer.from(sig);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try {
      // The wire keys are short (`uid`/`eid`); the parsed shape is validated
      // before any of it is read, so a forged-but-signed payload from a future
      // or malformed client cannot reach the caller with missing fields.
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
        uid?: unknown;
        eid?: unknown;
        exp?: unknown;
      };
      if (typeof data.uid !== 'number' || !Number.isInteger(data.uid)) return null;
      if (typeof data.eid !== 'number' || !Number.isInteger(data.eid)) return null;
      if (typeof data.exp !== 'number' || data.exp * 1000 <= Date.now()) return null;
      return { userId: data.uid, enrollmentId: data.eid, exp: data.exp };
    } catch {
      return null;
    }
  }

  /**
   * True when a username exists and the password matches its stored hash.
   *
   * An unknown username still pays for one scrypt round, so response time does
   * not reveal which usernames are real.
   */
  checkCredentials(db: DatabaseSync, username: string, password: string): boolean {
    const row = db.prepare('SELECT password_hash FROM users WHERE username=?').get(username) as
      | { password_hash: string }
      | undefined;
    if (!row) {
      hashPassword(password);
      return false;
    }
    return verifyPassword(password, row.password_hash);
  }

  cookieOptions(): Record<string, unknown> {
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.secureCookie,
      path: '/',
      maxAge: SESSION_TTL_S,
    };
  }

  clearCookieOptions(): Record<string, unknown> {
    return { httpOnly: true, sameSite: 'lax', secure: this.secureCookie, path: '/' };
  }
}
