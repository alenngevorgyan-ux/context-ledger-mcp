/**
 * Schema versioning via SQLite `user_version`.
 *
 * Rule: migrations are append-only and forward-only. A released migration is
 * never edited — schema drift between an old ledger file and new code is a
 * documented failure mode (docs/failure-model.md), and the only defence is a
 * migration path that is actually exercised by tests.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE tasks (
          id          TEXT PRIMARY KEY,
          objective   TEXT NOT NULL,
          repo        TEXT,
          status      TEXT NOT NULL DEFAULT 'open',
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );

        CREATE TABLE records (
          id          TEXT PRIMARY KEY,
          task_id     TEXT NOT NULL REFERENCES tasks(id),
          type        TEXT NOT NULL,
          content     TEXT NOT NULL,
          status      TEXT NOT NULL,
          rationale   TEXT,
          severity    TEXT,
          confidence  REAL,
          supersedes  TEXT REFERENCES records(id),
          source      TEXT NOT NULL,
          session_id  TEXT NOT NULL,
          evidence    TEXT,
          metadata    TEXT NOT NULL DEFAULT '{}',
          redactions  INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );

        -- A record may be superseded at most once. Without this, supersession
        -- chains fork and "the current decision" stops being well defined.
        CREATE UNIQUE INDEX idx_records_supersedes_unique
          ON records(supersedes) WHERE supersedes IS NOT NULL;

        CREATE INDEX idx_records_task_type ON records(task_id, type, status);
        CREATE INDEX idx_records_task_created ON records(task_id, created_at);

        CREATE TABLE events (
          id          TEXT PRIMARY KEY,
          ts          TEXT NOT NULL,
          task_id     TEXT,
          session_id  TEXT,
          type        TEXT NOT NULL,
          payload     TEXT NOT NULL DEFAULT '{}'
        );

        CREATE INDEX idx_events_task_ts ON events(task_id, ts);
        CREATE INDEX idx_events_type ON events(type);
      `);
    },
  },
  {
    version: 2,
    name: 'record_ordinal_for_total_ordering',
    up: (db) => {
      // created_at is an ISO string at millisecond resolution; two records
      // written in the same millisecond would otherwise have no defined order,
      // which would make recovery output non-deterministic. `ordinal` is a
      // monotonic per-database sequence used as the final tiebreaker.
      db.exec(`ALTER TABLE records ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0;`);
      db.exec(`
        UPDATE records SET ordinal = (
          SELECT COUNT(*) FROM records r2
          WHERE r2.created_at < records.created_at
             OR (r2.created_at = records.created_at AND r2.id <= records.id)
        );
      `);
      db.exec(`CREATE INDEX idx_records_ordinal ON records(task_id, ordinal);`);
    },
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export function currentVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

export function migrate(db: DatabaseSync): { from: number; to: number; applied: string[] } {
  const from = currentVersion(db);
  if (from > LATEST_VERSION) {
    throw new Error(
      `Ledger file is at schema version ${from}, but this build only understands ${LATEST_VERSION}. ` +
        `Refusing to open: a newer Context Ledger wrote this file. Upgrade the package.`,
    );
  }
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    db.exec('BEGIN');
    try {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
      applied.push(`${m.version}:${m.name}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return { from, to: currentVersion(db), applied };
}
