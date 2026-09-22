import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'kt_session';
const SESSION_TTL_S = 30 * 24 * 60 * 60;

function digest(value: string): Buffer {
  return createHmac('sha256', value).digest();
}

/**
 * Single-user auth: a shared password (checked constant-time) with an HMAC-
 * signed cookie. §10 requires auth because the app holds an API key and is
 * exposed to the internet.
 */
export class Auth {
  readonly cookieName = COOKIE_NAME;

  constructor(
    private secret: string,
    private password: string,
    private secureCookie: boolean,
  ) {}

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  createToken(): string {
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S }),
    ).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  verifyToken(token: string | undefined): boolean {
    if (!token) return false;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return false;
    const expected = Buffer.from(this.sign(payload));
    const actual = Buffer.from(sig);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp: number };
      return typeof data.exp === 'number' && data.exp * 1000 > Date.now();
    } catch {
      return false;
    }
  }

  checkPassword(input: string): boolean {
    return timingSafeEqual(digest(input), digest(this.password));
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
}