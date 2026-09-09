import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deterministicService, seedTask } from './helpers.js';
import { computeMetrics, signature } from '../telemetry/metrics.js';

function metric(report: ReturnType<typeof computeMetrics>, key: string) {
  const m = report.metrics.find((x) => x.key === key);
  assert.ok(m, `missing metric: ${key}`);
  return m!;
}

describe('telemetry events', () => {
  test('every state change emits exactly one event', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc); // task_initialized + 2 record events
    const types = svc.store.listEvents(task.id).map((e) => e.type);
    assert.deepEqual(types, [
      'task_initialized', 'acceptance_criterion_recorded', 'constraint_recorded',
    ]);
    svc.close();
  });

  test('supersession emits both a supersede and a record event', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    const d1 = svc.store.write({
      task_id: task.id, type: 'decision', content: 'A', rationale: 'r', session_id: 's',
    });
    svc.store.write({
      task_id: task.id, type: 'decision', content: 'B', rationale: 'r', supersedes: d1.id, session_id: 's',
    });
    const types = svc.store.listEvents(task.id).map((e) => e.type);
    assert.ok(types.includes('record_superseded'));
    assert.equal(types.filter((t) => t === 'decision_recorded').length, 2);
    svc.close();
  });

  test('events carry the session id, so cross-session behaviour is measurable', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc, 'sessionA');
    svc.recover({ task_id: task.id, session_id: 'sessionB' });
    const evs = svc.store.listEvents(task.id);
    assert.ok(evs.some((e) => e.session_id === 'sessionA'));
    assert.ok(evs.some((e) => e.session_id === 'sessionB' && e.type === 'recovery_requested'));
    svc.close();
  });
});

describe('derived metrics', () => {
  test('recovery utilisation counts recoveries per distinct session', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc, 'A');
    svc.recover({ task_id: task.id, session_id: 'B' });
    const r = computeMetrics(svc.store, task.id);
    assert.equal(r.sessions, 2);
    assert.equal(metric(r, 'context_recovery_utilization').value, 0.5);
    svc.close();
  });

  test('repeated failed approaches are detected by normalised similarity', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    svc.store.write({
      task_id: task.id, type: 'rejected_approach',
      content: 'Enforce the rate limit in nginx using limit_req',
      rationale: 'nginx cannot see the api key only the source ip', session_id: 's',
    });
    svc.store.write({
      task_id: task.id, type: 'rejected_approach',
      content: 'Enforce rate limit in nginx with limit_req',
      rationale: 'nginx cannot see the api key, only the source ip', session_id: 's',
    });
    const m = metric(computeMetrics(svc.store, task.id), 'repeated_failed_approach_rate');
    assert.equal(m.n, 2);
    assert.equal(m.value, 0.5);
    svc.close();
  });

  test('distinct failures are not counted as repeats', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    svc.store.write({
      task_id: task.id, type: 'rejected_approach', content: 'Use nginx limit_req',
      rationale: 'cannot see the api key', session_id: 's',
    });
    svc.store.write({
      task_id: task.id, type: 'rejected_approach', content: 'Store counters in a global variable',
      rationale: 'breaks entirely under multiple worker processes', session_id: 's',
    });
    assert.equal(metric(computeMetrics(svc.store, task.id), 'repeated_failed_approach_rate').value, 0);
    svc.close();
  });

  test('metrics with no data report null, not a misleading zero', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    const r = computeMetrics(svc.store, task.id);
    assert.equal(metric(r, 'repeated_failed_approach_rate').value, null);
    assert.equal(metric(r, 'constraint_violation_rate').value, null);
    assert.equal(metric(r, 'successful_resume_rate').value, null);
    svc.close();
  });

  test('every metric declares how observable it actually is', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    const r = computeMetrics(svc.store, task.id);
    for (const m of r.metrics) {
      assert.ok(['direct', 'self_reported', 'partial'].includes(m.observability), m.key);
      assert.ok(m.note.length > 20, `${m.key}: metric has no interpretation note`);
    }
    // The claim that constraint violations are self-reported must stay true:
    // it is the metric most likely to be misread as measured ground truth.
    assert.equal(metric(r, 'constraint_violation_rate').observability, 'self_reported');
    svc.close();
  });

  test('vanity metrics are deliberately absent', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    const keys = computeMetrics(svc.store, task.id).metrics.map((m) => m.key);
    for (const banned of ['records_stored', 'total_records', 'mcp_calls', 'tokens_stored']) {
      assert.ok(!keys.includes(banned), `vanity metric present: ${banned}`);
    }
    svc.close();
  });

  test('successful resume rate needs both a recovery and a passing verification', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    svc.recover({ task_id: task.id, session_id: 'B' });
    let r = computeMetrics(svc.store, task.id);
    assert.equal(metric(r, 'successful_resume_rate').value, 0);

    const v = svc.store.write({
      task_id: task.id, type: 'verification', content: 'suite green', evidence: 'npm test',
      session_id: 'B', source: 'tool', metadata: { command: 'npm test', passed: true },
    });
    svc.store.emit('verification_recorded', {
      task_id: task.id, session_id: 'B', payload: { passed: true, record_id: v.id },
    });
    r = computeMetrics(svc.store, task.id);
    assert.equal(metric(r, 'successful_resume_rate').value, 1);
    svc.close();
  });

  test('redaction guardrail rises when secret-shaped text is written', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    svc.store.write({
      task_id: task.id, type: 'finding', content: 'key AKIAIOSFODNN7EXAMPLE', session_id: 's',
    });
    const m = metric(computeMetrics(svc.store, task.id), 'redacted_record_rate');
    assert.ok((m.value ?? 0) > 0);
    svc.close();
  });

  test('signature normalisation ignores word order and duplication', () => {
    assert.equal(signature('rate limit nginx'), signature('nginx limit rate rate'));
    assert.notEqual(signature('rate limit nginx'), signature('rate limit redis'));
  });
});
