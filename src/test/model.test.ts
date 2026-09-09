import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deterministicService, seedTask, tempDir } from './helpers.js';
import { join } from 'node:path';
import { LedgerError } from '../domain/types.js';

describe('state model invariants', () => {
  test('rejects empty content and missing provenance', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    assert.throws(
      () => svc.store.write({ task_id: task.id, type: 'finding', content: '   ', session_id: 's' }),
      /non-empty/,
    );
    assert.throws(
      () => svc.store.write({ task_id: task.id, type: 'finding', content: 'x', session_id: '' }),
      /session_id is required/,
    );
    svc.close();
  });

  test('decision and rejected_approach require a rationale', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    assert.throws(
      () => svc.store.write({ task_id: task.id, type: 'decision', content: 'use redis', session_id: 's' }),
      /requires a rationale/,
    );
    assert.throws(
      () =>
        svc.store.write({
          task_id: task.id,
          type: 'rejected_approach',
          content: 'nginx limit_req',
          session_id: 's',
        }),
      /requires a rationale/,
    );
    svc.close();
  });

  test('confidence must be in [0,1] and severity must be known', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    assert.throws(
      () =>
        svc.store.write({ task_id: task.id, type: 'finding', content: 'x', session_id: 's', confidence: 1.5 }),
      /confidence/,
    );
    assert.throws(
      () =>
        svc.store.write({
          task_id: task.id,
          type: 'constraint',
          content: 'x',
          session_id: 's',
          severity: 'critical' as never,
        }),
      /invalid severity/,
    );
    svc.close();
  });

  test('content longer than 8000 chars is refused (ledger is state, not transcript)', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    assert.throws(
      () =>
        svc.store.write({
          task_id: task.id,
          type: 'finding',
          content: 'x'.repeat(8001),
          session_id: 's',
        }),
      /exceeds 8000/,
    );
    svc.close();
  });

  test('status must be legal for the record type', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    // a constraint cannot be 'done'
    assert.throws(
      () =>
        svc.store.write({
          task_id: task.id,
          type: 'constraint',
          content: 'x',
          session_id: 's',
          status: 'done',
        }),
      /not valid for record type/,
    );
    svc.close();
  });

  test('task isolation: records never leak across tasks', () => {
    const svc = deterministicService(':memory:');
    const a = seedTask(svc, 'sA');
    const b = svc.store.createTask({ objective: 'Unrelated task', session_id: 'sB' });
    svc.store.write({ task_id: b.id, type: 'finding', content: 'b only', session_id: 'sB' });
    const aRecords = svc.store.listRecords(a.task.id);
    assert.ok(aRecords.every((r) => r.task_id === a.task.id));
    assert.equal(aRecords.filter((r) => r.content === 'b only').length, 0);
    const rec = svc.recover({ task_id: a.task.id, session_id: 'sA' });
    assert.ok(!rec.text.includes('b only'));
    svc.close();
  });

  test('writes to a closed task are refused', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    svc.store.setTaskStatus(task.id, 'closed', 's');
    assert.throws(
      () => svc.store.write({ task_id: task.id, type: 'finding', content: 'late', session_id: 's' }),
      /refusing new records/,
    );
    svc.close();
  });

  test('unknown task and unknown record are typed errors', () => {
    const svc = deterministicService(':memory:');
    try {
      svc.store.requireTask('task_nope');
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof LedgerError);
      assert.equal(e.code, 'not_found');
    }
    svc.close();
  });
});

describe('supersession', () => {
  test('supersession marks the prior record superseded but retains it', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    const d1 = svc.store.write({
      task_id: task.id,
      type: 'decision',
      content: 'Use a fixed-window counter',
      rationale: 'simplest',
      session_id: 's',
    });
    const d2 = svc.store.write({
      task_id: task.id,
      type: 'decision',
      content: 'Use a sliding-window log',
      rationale: 'fixed window allows 2x burst at the boundary',
      supersedes: d1.id,
      session_id: 's',
    });
    assert.equal(svc.store.requireRecord(d1.id).status, 'superseded');
    assert.equal(svc.store.requireRecord(d2.id).status, 'active');
    // retained and auditable
    const chain = svc.store.history(d2.id);
    assert.deepEqual(chain.map((r) => r.id), [d1.id, d2.id]);
    svc.close();
  });

  test('a record cannot be superseded twice (no forked chains)', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    const d1 = svc.store.write({
      task_id: task.id, type: 'decision', content: 'A', rationale: 'r', session_id: 's',
    });
    svc.store.write({
      task_id: task.id, type: 'decision', content: 'B', rationale: 'r', supersedes: d1.id, session_id: 's',
    });
    assert.throws(
      () =>
        svc.store.write({
          task_id: task.id, type: 'decision', content: 'C', rationale: 'r', supersedes: d1.id, session_id: 's',
        }),
      /already superseded/,
    );
    svc.close();
  });

  test('supersession cannot cross tasks or change type', () => {
    const svc = deterministicService(':memory:');
    const a = seedTask(svc, 'sA');
    const b = svc.store.createTask({ objective: 'Other', session_id: 'sB' });
    assert.throws(
      () =>
        svc.store.write({
          task_id: b.id, type: 'constraint', content: 'x', supersedes: a.c.id, session_id: 'sB',
        }),
      /another task/,
    );
    assert.throws(
      () =>
        svc.store.write({
          task_id: a.task.id, type: 'finding', content: 'x', supersedes: a.c.id, session_id: 'sA',
        }),
      /types must match/,
    );
    svc.close();
  });

  test('superseded records are excluded from recovery but remain in the audit dump', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    const d1 = svc.store.write({
      task_id: task.id, type: 'decision', content: 'Use Redis for counters',
      rationale: 'shared across instances', session_id: 's',
    });
    svc.store.write({
      task_id: task.id, type: 'decision', content: 'Use in-process counters',
      rationale: 'Redis violates the no-new-dependency constraint',
      supersedes: d1.id, session_id: 's',
    });
    const { text } = svc.recover({ task_id: task.id, session_id: 's' });
    assert.ok(!text.includes('Use Redis for counters'));
    assert.ok(text.includes('Use in-process counters'));
    const all = svc.store.listRecords(task.id);
    assert.ok(all.some((r) => r.content === 'Use Redis for counters'));
    svc.close();
  });

  test('a superseded record is frozen: no further transitions', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    const t1 = svc.store.write({ task_id: task.id, type: 'todo', content: 'step one', session_id: 's' });
    svc.store.write({
      task_id: task.id, type: 'todo', content: 'step one, revised', supersedes: t1.id, session_id: 's',
    });
    assert.throws(() => svc.store.transition(t1.id, 'done', 's'), /frozen/);
    svc.close();
  });

  test('nothing is ever deleted', () => {
    const d = tempDir();
    const svc = deterministicService(join(d.dir, 'l.sqlite'));
    const { task } = seedTask(svc);
    let prev = svc.store.write({
      task_id: task.id, type: 'decision', content: 'v0', rationale: 'r0', session_id: 's',
    });
    for (let i = 1; i <= 5; i++) {
      prev = svc.store.write({
        task_id: task.id, type: 'decision', content: `v${i}`, rationale: `r${i}`,
        supersedes: prev.id, session_id: 's',
      });
    }
    assert.equal(svc.store.listRecords(task.id, { types: ['decision'] }).length, 6);
    assert.equal(svc.store.history(prev.id).length, 6);
    svc.close();
    d.cleanup();
  });
});

/**
 * Invariant holes found by the adversarial self-review in docs/hostile-review.md.
 * Each of these was reachable through the public store API before the fix.
 */
describe('invariant holes closed by hostile review', () => {
  test('a record cannot be BORN superseded or invalidated', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    for (const status of ['superseded', 'invalidated'] as const) {
      assert.throws(
        () =>
          svc.store.write({
            task_id: task.id, type: 'finding', content: 'x', session_id: 's', status,
          }),
        /cannot create a record with status/,
        `status '${status}' must be unreachable at creation`,
      );
    }
    svc.close();
  });

  test('transition cannot fake supersession (no successor-less superseded record)', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    const d = svc.store.write({
      task_id: task.id, type: 'decision', content: 'A', rationale: 'r', session_id: 's',
    });
    assert.throws(() => svc.store.transition(d.id, 'superseded', 's'), /cannot transition to 'superseded'/);
    // the supported ways out are a successor, or invalidation
    svc.store.transition(d.id, 'invalidated', 's');
    assert.equal(svc.store.requireRecord(d.id).status, 'invalidated');
    svc.close();
  });

  test('every superseded record has exactly one successor', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    let prev = svc.store.write({
      task_id: task.id, type: 'decision', content: 'v0', rationale: 'r', session_id: 's',
    });
    for (let i = 1; i <= 4; i++) {
      prev = svc.store.write({
        task_id: task.id, type: 'decision', content: `v${i}`, rationale: 'r',
        supersedes: prev.id, session_id: 's',
      });
    }
    const all = svc.store.listRecords(task.id, { types: ['decision'] });
    const successorOf = new Map(all.filter((r) => r.supersedes).map((r) => [r.supersedes!, r.id]));
    for (const r of all) {
      if (r.status === 'superseded') {
        assert.ok(successorOf.has(r.id), `${r.id} is superseded but nothing supersedes it`);
      }
    }
    // and exactly one record is the live head
    assert.equal(all.filter((r) => r.status === 'active').length, 1);
    svc.close();
  });

  test('an invalidated record is frozen and leaves recovery', () => {
    const svc = deterministicService(':memory:');
    const { task, c } = seedTask(svc);
    svc.store.transition(c.id, 'invalidated', 's', 'constraint withdrawn by the tech lead');
    const { text } = svc.recover({ task_id: task.id, session_id: 's' });
    assert.ok(!text.includes('No new runtime dependencies'));
    assert.throws(() => svc.store.transition(c.id, 'active', 's'), /frozen/);
    // but it is still auditable
    assert.ok(svc.store.listRecords(task.id).some((r) => r.id === c.id));
    svc.close();
  });

  test('task creation is atomic with its telemetry event', () => {
    const svc = deterministicService(':memory:');
    const t = svc.store.createTask({ objective: 'atomic', session_id: 's' });
    const evs = svc.store.listEvents(t.id);
    assert.equal(evs.length, 1);
    assert.equal(evs[0]!.type, 'task_initialized');
    svc.close();
  });
});
