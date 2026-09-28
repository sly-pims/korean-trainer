import { DatabaseSync } from 'node:sqlite';
import { Auth } from './auth.js';
import { Config } from './config.js';
import { CallManager } from './llm/callManager.js';
import { ContentService } from './services/content.js';
import { ReviewService } from './services/review.js';

export interface Ctx {
  db: DatabaseSync;
  cfg: Config;
  auth: Auth;
  content: ContentService;
  review: ReviewService;
  callManager: CallManager | null;
}

/**
 * One row of `enrollments`: who is learning, from what, into which language.
 *
 * Resolved per request from the signed cookie rather than from a request
 * parameter, so a handler cannot be pointed at somebody else's rows by editing
 * a number in a URL. This is the single value every scoped query filters on.
 */
export interface Enrollment {
  id: number;
  userId: number;
  targetLang: string;
  nativeLang: string;
  uiLang: string;
  displayName: string;
  username: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set by the auth preHandler. Absent on the handful of unauthenticated
     * routes, which is why handlers that need it are not registered there.
     */
    enrollment?: Enrollment;
  }
}
