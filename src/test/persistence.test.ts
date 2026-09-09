import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tempDir, deterministicService, seedTask } from './helpers.js';
import { LedgerService } from '../service.js';
import { openDatabase } from '../storage/db.js';
import { currentVersion, LATEST_VERSION, MIGRATIONS, migrate } from '../storage/migrations.js';

describe('persistence', () => {
  test('state survives process-level restart (close and reopen the file)', () => {
    const d = tempDir();
    const path = join(d.dir, 'ledger.sqlite');

    const svc1 = deterministicService(path);
    const { task } = seedTask(svc1);
    svc1.store.write({
      task_id: task.id, type: 'rejected_approach', content: 'nginx limit_req',
      rationale: 'cannot see API keys, only IPs', session_id: 'sessA',
    });
    const before = svc1.recover({ task_id: task.id, session_id: 'sessA' });
    svc1.close();

    // A genuinely new connection, as a restarted server would make.
    const svc2 = new LedgerService({ path });
    const after = svc2.recover({ task_id: task.id, session_id: 'sessB' });
    assert.equal(after.selection.fingerprint, before.selection.fingerprint);
    assert.ok(after.text.includes('nginx limit_req'));
    assert.equal(svc2.store.listRecords(task.id).length, 3);
    svc2.close();
    d.cleanup();
  });

  test('telemetry survives restart too', () => {
    const d = tempDir();
    const path = join(d.dir, 'ledger.sqlite');
    const svc1 = deterministicService(path);
    const { task } = seedTask(svc1);
    svc1.recover({ task_id: task.id, session_id: 'sessA' });
    const n = svc1.store.listEvents(task.id).length;
    svc1.close();
    const svc2 = new LedgerService({ path });
    assert.equal(svc2.store.listEvents(task.id).length, n);
    svc2.close();
    d.cleanup();
  });
});

describe('schema migration', () => {
  test('a fresh database lands on the latest version', () => {
    const d = tempDir();
    const db = openDatabase({ path: join(d.dir, 'x.sqlite') });
    assert.equal(currentVersion(db), LATEST_VERSION);
    db.close();
    d.cleanup();
  });

  test('a v1 database migrates forward with data preserved', () => {
    const d = tempDir();
    const path = join(d.dir, 'old.sqlite');

    // Build a database at v1 only, exactly as an older release would have left it.
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = ON');
    MIGRATIONS[0]!.up(raw);
    raw.exec('PRAGMA user_version = 1');
    raw
      .prepare('INSERT INTO tasks (id,objective,repo,status,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run('task_old', 'legacy objective', null, 'open', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
    for (const [i, content] of ['first', 'second'].entries()) {
      raw
        .prepare(
          `INSERT INTO records (id,task_id,type,content,status,source,session_id,metadata,redactions,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          `rec_old_${i}`, 'task_old', 'finding', content, 'active', 'agent', 'sess_old', '{}', 0,
          '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z',
        );
    }
    assert.equal(currentVersion(raw), 1);
    raw.close();

    // Now open it with current code.
    const svc = new LedgerService({ path });
    assert.equal(currentVersion(svc.db), LATEST_VERSION);
    const recs = svc.store.listRecords('task_old');
    assert.deepEqual(recs.map((r) => r.content), ['first', 'second']);
    // ordinal backfill produced a usable total order
    const rec = svc.recover({ task_id: 'task_old', session_id: 's' });
    assert.ok(rec.text.includes('legacy objective'));
    svc.close();
    d.cleanup();
  });

  test('migration is idempotent', () => {
    const d = tempDir();
    const path = join(d.dir, 'i.sqlite');
    const db = openDatabase({ path });
    const again = migrate(db);
    assert.deepEqual(again.applied, []);
    assert.equal(again.to, LATEST_VERSION);
    db.close();
    d.cleanup();
  });

  test('refuses to open a database written by a newer schema version', () => {
    const d = tempDir();
    const path = join(d.dir, 'future.sqlite');
    const db = openDatabase({ path });
    db.exec(`PRAGMA user_version = ${LATEST_VERSION + 5}`);
    db.close();
    assert.throws(() => new LedgerService({ path }), /newer Context Ledger wrote this file/);
    d.cleanup();
  });
});
