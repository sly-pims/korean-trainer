/**
 * Stable error codes for the HTTP API.
 *
 * ## Why a code and not just a message
 *
 * Every error response used to carry only `{ error: "..." }` — an English
 * sentence written for a developer reading a log. The client then showed that
 * sentence verbatim, so a learner whose interface language was not English saw
 * English error text on a screen that was otherwise in their language, and
 * nothing in the client could be translated because there was no stable token
 * to translate *on*.
 *
 * Each response now carries a machine-readable `code` alongside the message.
 * The message stays for logs and for `curl`; the client looks the code up in
 * `web/src/copy.tsx`'s `serverError()` map and renders a translated sentence,
 * falling back to the server's message when a code is one it does not know
 * (an older server, or a code added after this bundle was built).
 *
 * ## Rules
 *
 * - A code is part of the API contract. Rename one only by adding a new code and
 *   keeping the old entry mapped, so an old client keeps working.
 * - Codes are `snake_case` and describe *what happened*, not what to do about it.
 * - Do not put user content, tokens or file paths in a code.
 */

/**
 * The closed set of codes this server can emit. `web/src/copy.test.tsx` asserts
 * that the client map and this list stay in step, so adding a code here without
 * a copy string for it fails the web suite.
 */
export const ERROR_CODES = [
  'invalid_password',
  'validation_failed',
  'unknown_voice',
  'sentence_index_required',
  'empty_recording',
  'transcription_failed',
  'llm_not_configured',
  'daily_cap_reached',
  'no_completed_session',
  'reset_confirm_required',
  'text_required',
  'text_too_long',
  'recording_too_large',
  'tts_unavailable',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

export interface ErrorBody {
  /** Stable token; see {@link ErrorCode}. */
  code: ErrorCode;
  /** Developer-facing English detail. Never show this in place of `code`. */
  error: string;
}

/**
 * Builds an error payload. Keeping this in one place is what guarantees every
 * failure route has both fields, rather than some of them remembering.
 */
export function errorBody(code: ErrorCode, error: string): ErrorBody {
  return { code, error };
}
