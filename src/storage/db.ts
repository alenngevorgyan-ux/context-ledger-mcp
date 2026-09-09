import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate } from './migrations.js';

export interface OpenOptions {
  /** ':memory:' or a filesystem path. */
  path: string;
  readOnly?: boolean;
}

/**
 * Open (and migrate) a ledger database.
 *
 * WAL + a busy timeout are what make the "multiple agent processes share one
 * ledger" story real rather than aspirational; the concurrency test in
 * src/test/concurrency.test.ts opens two independent connections to the same
 * file and asserts no lost writes.
 */
export function openDatabase(opts: OpenOptions): DatabaseSync {
  if (opts.path !== ':memory:') mkdirSync(dirname(opts.path), { recursive: true });
  const db = new DatabaseSync(opts.path, { readOnly: opts.readOnly ?? false });
  if (!opts.readOnly) {
    if (opts.path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA synchronous = NORMAL');
    migrate(db);
  } else {
    db.exec('PRAGMA foreign_keys = ON');
  }
  return db;
}
