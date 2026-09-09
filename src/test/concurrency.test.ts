import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempDir } from './helpers.js';
import { LedgerService } from '../service.js';

describe('concurrent and repeated operations', () => {
  test('two connections to the same file both see each other\'s writes', () => {
    const d = tempDir();
    const path = join(d.dir, 'shared.sqlite');
    const a = new LedgerService({ path });
    const b = new LedgerService({ path });

    const task = a.store.createTask({ objective: 'Shared task', session_id: 'A' });
    b.store.write({ task_id: task.id, type: 'finding', content: 'from B', session_id: 'B' });
    a.store.write({ task_id: task.id, type: 'finding', content: 'from A', session_id: 'A' });

    const seenByA = a.store.listRecords(task.id).map((r) => r.content);
    const seenByB = b.store.listRecords(task.id).map((r) => r.content);
    assert.deepEqual(seenByA, ['from B', 'from A']);
    assert.deepEqual(seenByB, seenByA);
    a.close();
    b.close();
    d.cleanup();
  });

  test('interleaved writers do not lose records or duplicate ordinals', () => {
    const d = tempDir();
    const path = join(d.dir, 'inter.sqlite');
    const a = new LedgerService({ path });
    const b = new LedgerService({ path });
    const task = a.store.createTask({ objective: 'Interleaved', session_id: 'A' });

    for (let i = 0; i < 40; i++) {
      const svc = i % 2 === 0 ? a : b;
      svc.store.write({
        task_id: task.id, type: 'finding', content: `record ${i}`,
        session_id: i % 2 === 0 ? 'A' : 'B',
      });
    }
    const rows = a.store.listRecords(task.id, { types: ['finding'] });
    assert.equal(rows.length, 40);
    assert.equal(new Set(rows.map((r) => r.id)).size, 40, 'duplicate ids');
    assert.deepEqual(rows.map((r) => r.content), Array.from({ length: 40 }, (_, i) => `record ${i}`),
      'ordinal ordering must match write order');
    a.close();
    b.close();
    d.cleanup();
  });

  test('a separate OS process writing the same ledger is observed after commit', () => {
    const d = tempDir();
    const path = join(d.dir, 'proc.sqlite');
    const svc = new LedgerService({ path });
    const task = svc.store.createTask({ objective: 'Cross-process', session_id: 'main' });

    const script = `
      import { LedgerService } from '${process.cwd()}/dist/service.js';
      const s = new LedgerService({ path: ${JSON.stringify(path)} });
      s.store.write({ task_id: ${JSON.stringify(task.id)}, type: 'finding',
        content: 'written by a child process', session_id: 'child' });
      s.close();
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe' });

    const contents = svc.store.listRecords(task.id).map((r) => r.content);
    assert.ok(contents.includes('written by a child process'));
    svc.close();
    d.cleanup();
  });

  test('a failed write leaves no partial state (transaction rollback)', () => {
    const d = tempDir();
    const path = join(d.dir, 'rollback.sqlite');
    const svc = new LedgerService({ path });
    const task = svc.store.createTask({ objective: 'Rollback', session_id: 's' });
    const d1 = svc.store.write({
      task_id: task.id, type: 'decision', content: 'A', rationale: 'r', session_id: 's',
    });
    svc.store.write({
      task_id: task.id, type: 'decision', content: 'B', rationale: 'r', supersedes: d1.id, session_id: 's',
    });
    const before = svc.store.listRecords(task.id).length;
    const eventsBefore = svc.store.listEvents(task.id).length;

    assert.throws(() =>
      svc.store.write({
        task_id: task.id, type: 'decision', content: 'C', rationale: 'r', supersedes: d1.id, session_id: 's',
      }));

    assert.equal(svc.store.listRecords(task.id).length, before, 'record leaked from a rolled-back write');
    assert.equal(svc.store.listEvents(task.id).length, eventsBefore, 'event leaked from a rolled-back write');
    // and the store is still usable afterwards
    svc.store.write({ task_id: task.id, type: 'finding', content: 'still works', session_id: 's' });
    svc.close();
    d.cleanup();
  });

  test('repeated identical recoveries are stable and cheap to compare', () => {
    const d = tempDir();
    const svc = new LedgerService({ path: join(d.dir, 'r.sqlite') });
    const task = svc.store.createTask({ objective: 'Stability', session_id: 's' });
    svc.store.write({ task_id: task.id, type: 'constraint', content: 'c1', severity: 'blocking', session_id: 's' });
    const fps = new Set<string>();
    for (let i = 0; i < 10; i++) {
      fps.add(svc.recover({ task_id: task.id, session_id: 's' }).selection.fingerprint);
    }
    assert.equal(fps.size, 1);
    svc.close();
    d.cleanup();
  });
});
