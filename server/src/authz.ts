import type { DatabaseSync } from 'node:sqlite';
import { errorBody } from './errors.js';
import type { FastifyReply } from 'fastify';

/**
 * Tables a request can name by id, and how each one answers "do you own this?".
 *
 * `column` is the enrollment foreign key. `via` is for the one table that owns
 * nothing itself: an SRS card belongs to whoever owns the word it grades.
 */
export type OwnedTable =
  | 'sessions'
  | 'writing_entries'
  | 'speaking_attempts'
  | 'dictation_entries'
  | 'words'
  | 'level_history';

const OWNERSHIP: Record<OwnedTable, { column: string; via?: { table: string; column: string; key: string } }> = {
  sessions: { column: 'enrollment_id' },
  writing_entries: { column: 'enrollment_id' },
  speaking_attempts: { column: 'enrollment_id' },
  dictation_entries: { column: 'enrollment_id' },
  words: { column: 'enrollment_id' },
  level_history: { column: 'enrollment_id' },
};

/**
 * Fetches a row only if it belongs to this enrollment.
 *
 * Absent and not-yours produce the *same* answer, deliberately. A 403 for one
 * and a 404 for the other tells an attacker which ids exist, and ids here are
 * sequential integers, so that difference is a working enumeration oracle. 404
 * for both is the boring, safe answer.
 */
export function ownedRow<T = Record<string, unknown>>(
  db: DatabaseSync,
  table: OwnedTable,
  id: number,
  enrollmentId: number,
): T | null {
  const spec = OWNERSHIP[table];
  if (!Number.isInteger(id) || id <= 0) return null;
  if (!spec.via) {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=? AND ${spec.column}=?`).get(id, enrollmentId);
    return (row as T | undefined) ?? null;
  }
  const row = db
    .prepare(
      `SELECT t.* FROM ${table} t JOIN ${spec.via.table} o ON o.${spec.via.key}=t.id
       WHERE t.id=? AND o.${spec.via.column}=?`,
    )
    .get(id, enrollmentId);
  return (row as T | undefined) ?? null;
}

/** The id in a route parameter, or a 400 if it is not a positive integer. */
export function idParam(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function notFound(reply: FastifyReply) {
  return reply.code(404).send(errorBody('not_found', 'not found'));
}

export function badId(reply: FastifyReply) {
  return reply.code(400).send(errorBody('validation_failed', 'id must be a positive integer'));
}
