import type Database from 'better-sqlite3';
import { ValidationError } from '../../core/errors.js';
import type { Db } from '../db.js';

export type Stmt = Database.Statement<unknown[], unknown>;

/**
 * Base class for repositories: holds the handle and memoizes prepared statements by SQL text so hot paths
 * (event insert, watermark set) prepare once. Repos contain NO business rules: only typed access.
 */
export abstract class Repo {
  readonly #cache = new Map<string, Stmt>();

  constructor(protected readonly db: Db) {}

  /** Prepared (and cached) statement. */
  protected stmt(sql: string): Stmt {
    let s = this.#cache.get(sql);
    if (s === undefined) {
      s = this.db.prepare(sql) as Stmt;
      this.#cache.set(sql, s);
    }
    return s;
  }
}

/** ISO-8601 UTC with milliseconds (the storage timestamp format). */
export function iso(d: Date): string {
  return d.toISOString();
}

/** An ISO-8601 instant WITH an explicit zone designator (`Z` or `+hh:mm`). */
const HAS_OFFSET = /(Z|[+-]\d\d:?\d\d)$/i;

/** True when `value` parses AND carries an explicit offset (a zoneless string is parsed in the PROCESS zone). */
export function hasExplicitOffset(value: string): boolean {
  return HAS_OFFSET.test(value.trim()) && Number.isFinite(Date.parse(value));
}

/**
 * Normalize an instant to the storage format (UTC `...Z`, milliseconds) at the repo boundary. A string WITHOUT
 * a zone offset is rejected: `Date.parse('2026-12-03T08:00:00')` uses the process time zone (the container runs
 * TZ=America/Chicago), which would silently shift `ts_epoch_ms` by hours; and mixed `-05:00`/`Z` strings
 * mis-order across DST when compared as text.
 * @throws ValidationError
 */
export function normalizeInstant(value: string, what: string): string {
  if (!hasExplicitOffset(value)) {
    throw new ValidationError(
      `${what} must be an ISO-8601 instant with an explicit offset (Z or +hh:mm), got "${value}"`,
    );
  }
  return new Date(value).toISOString();
}

export const toInt = (b: boolean): 0 | 1 => (b ? 1 : 0);
export const toBool = (n: number | null | undefined): boolean => n === 1;
export const toBoolOrNull = (n: number | null | undefined): boolean | null =>
  n === null || n === undefined ? null : n === 1;
export const boolOrNullToInt = (b: boolean | null): 0 | 1 | null => (b === null ? null : b ? 1 : 0);

/** JSON.parse that returns `fallback` for null/empty/invalid text. */
export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** `?,?,?` placeholder list. */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}
