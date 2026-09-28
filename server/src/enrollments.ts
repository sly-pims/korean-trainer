import type { DatabaseSync } from 'node:sqlite';
import type { Enrollment } from './ctx.js';

/** One row of the enrollment query: the enrollment plus its owner's names. */
interface EnrollmentRow {
  id: number;
  user_id: number;
  target_lang: string;
  native_lang: string;
  ui_lang: string;
  display_name: string;
  username: string;
}

/**
 * The columns every enrollment read needs. Kept separate from the WHERE clause
 * on purpose: appending a second predicate to a query whose first parameter is
 * already bound to `e.id` is how `enrollmentsForUser` once passed a user id
 * where an enrollment id was expected and silently returned an empty list.
 */
const ENROLLMENT_COLUMNS = `
  SELECT e.id, e.user_id, e.target_lang, e.native_lang, e.ui_lang,
         u.display_name, u.username
  FROM enrollments e JOIN users u ON u.id = e.user_id`;

/** The enrollment with this id, or null. Does not check who owns it. */
export function enrollmentById(db: DatabaseSync, id: number): Enrollment | null {
  const r = db.prepare(`${ENROLLMENT_COLUMNS} WHERE e.id = ?`).get(id) as EnrollmentRow | undefined;
  return r ? toEnrollment(r) : null;
}

/**
 * The enrollment named by a session, but only if that user owns it.
 *
 * The cookie is signed, so its `eid` cannot be forged — but an enrollment can
 * also be *deleted* or a token can outlive the account it names, and a row that
 * is merely *not* ours must never be used. Both checks, in one place, so no
 * caller has to remember the second one.
 */
export function enrollmentForUser(db: DatabaseSync, userId: number, enrollmentId: number): Enrollment | null {
  const r = db
    .prepare(`${ENROLLMENT_COLUMNS} WHERE e.id = ? AND e.user_id = ?`)
    .get(enrollmentId, userId) as EnrollmentRow | undefined;
  return r ? toEnrollment(r) : null;
}

export function enrollmentsForUser(db: DatabaseSync, userId: number): Enrollment[] {
  const rows = db
    .prepare(`${ENROLLMENT_COLUMNS} WHERE e.user_id = ? ORDER BY e.id`)
    .all(userId) as unknown as EnrollmentRow[];
  return rows.map(toEnrollment);
}

/** The account a session token names, or null. */
export function userById(db: DatabaseSync, id: number): { id: number; username: string; displayName: string } | null {
  const r = db.prepare('SELECT id, username, display_name FROM users WHERE id=?').get(id) as
    | { id: number; username: string; display_name: string }
    | undefined;
  return r ? { id: r.id, username: r.username, displayName: r.display_name } : null;
}

export interface NewEnrollment {
  targetLang: string;
  nativeLang: string;
  uiLang: string;
}

/**
 * Adds a language to somebody's account.
 *
 * `UNIQUE (user_id, target_lang, native_lang)` means asking for a pair that
 * already exists is a no-op returning the existing row rather than an error:
 * double-tapping "add French" should not look like a failure.
 */
export function createEnrollment(
  db: DatabaseSync,
  userId: number,
  input: NewEnrollment,
): { enrollment: Enrollment; created: boolean } {
  const existing = db
    .prepare('SELECT id FROM enrollments WHERE user_id=? AND target_lang=? AND native_lang=?')
    .get(userId, input.targetLang, input.nativeLang) as { id: number } | undefined;
  if (existing) {
    return { enrollment: enrollmentForUser(db, userId, existing.id)!, created: false };
  }
  const res = db
    .prepare('INSERT INTO enrollments (user_id, target_lang, native_lang, ui_lang, created_at) VALUES (?,?,?,?,?)')
    .run(userId, input.targetLang, input.nativeLang, input.uiLang, new Date().toISOString());
  return { enrollment: enrollmentForUser(db, userId, Number(res.lastInsertRowid))!, created: true };
}

/** Gives a brand-new enrollment a settings row, so screens never see a null. */
export function ensureSettingsRow(db: DatabaseSync, enrollmentId: number, defaultVoice: string, tz: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO settings (enrollment_id, tts_voice, timezone, created_at)
     VALUES (?,?,?,?)`,
  ).run(enrollmentId, defaultVoice, tz, new Date().toISOString());
}

/** Target languages this deployment supports that this account has not enrolled in. */
export function availableTargetLangs(db: DatabaseSync, userId: number, supported: string[]): string[] {
  const have = new Set(
    (db.prepare('SELECT target_lang FROM enrollments WHERE user_id=?').all(userId) as { target_lang: string }[]).map(
      (r) => r.target_lang,
    ),
  );
  return supported.filter((code) => !have.has(code));
}

function toEnrollment(r: EnrollmentRow): Enrollment {
  return {
    id: r.id,
    userId: r.user_id,
    targetLang: r.target_lang,
    nativeLang: r.native_lang,
    uiLang: r.ui_lang,
    displayName: r.display_name,
    username: r.username,
  };
}
