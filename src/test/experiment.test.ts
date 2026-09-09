import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateProbe, replaySessionA, runExperiment } from '../experiment/harness.js';
import { RATE_LIMIT_SCENARIO, SCENARIOS } from '../experiment/scenario.js';
import { deterministicService } from './helpers.js';

describe('experiment harness', () => {
  test('session A replays into a well-formed ledger', () => {
    const svc = deterministicService(':memory:');
    const { task_id, records } = replaySessionA(svc, RATE_LIMIT_SCENARIO);
    assert.equal(records.length, RATE_LIMIT_SCENARIO.session_a.length);
    const state = svc.taskState(task_id);
    assert.ok((state.counts['constraint'] ?? 0) >= 3);
    assert.ok((state.counts['rejected_approach'] ?? 0) >= 2);
    assert.equal(state.counts['todo:done'], 1, 'the completed todo must be marked done');
    svc.close();
  });

  test('the whole experiment is reproducible', () => {
    const a = runExperiment({ scenario: RATE_LIMIT_SCENARIO });
    const b = runExperiment({ scenario: RATE_LIMIT_SCENARIO });
    assert.equal(a.recovery_fingerprint, b.recovery_fingerprint);
    assert.equal(a.conditions.baseline.sufficiency, b.conditions.baseline.sufficiency);
    assert.equal(a.conditions.ledger.sufficiency, b.conditions.ledger.sufficiency);
    assert.deepEqual(a.budget_sweep, b.budget_sweep);
  });

  test('the baseline is a real baseline, not a strawman', () => {
    const r = runExperiment({ scenario: RATE_LIMIT_SCENARIO });
    // It must contain the ticket and the repository state, and it must satisfy
    // at least one probe on its own. A baseline that scores zero on everything
    // would indicate we crippled it.
    assert.ok(r.conditions.baseline.context.includes('TICKET API-4127'));
    assert.ok(r.conditions.baseline.context.includes('src/limiter.ts'));
    assert.ok(r.conditions.baseline.satisfied > 0, 'baseline satisfies nothing — likely rigged');
    // And the ledger condition must be additive over it, not a replacement.
    assert.ok(r.conditions.ledger.context.startsWith(r.conditions.baseline.context));
  });

  test('the ledger does not invent knowledge that was never recorded', () => {
    const r = runExperiment({ scenario: RATE_LIMIT_SCENARIO });
    const p = r.conditions.ledger.probes.find((x) => x.probe_id === 'retry-after-value');
    assert.ok(p, 'negative-control probe missing');
    assert.equal(p!.satisfied, false, 'a fact never recorded must not be recoverable');
  });

  test('the ledger supplements the repository rather than replacing it', () => {
    const r = runExperiment({ scenario: RATE_LIMIT_SCENARIO });
    const onlyInRepo = r.conditions.ledger_only.probes.find((x) => x.probe_id === 'partial-impl-location');
    assert.equal(onlyInRepo!.satisfied, false, 'recovery alone should not know repo-only facts');
    const withRepo = r.conditions.ledger.probes.find((x) => x.probe_id === 'partial-impl-location');
    assert.equal(withRepo!.satisfied, true);
  });

  test('recovery beats the baseline on every critical item', () => {
    const r = runExperiment({ scenario: RATE_LIMIT_SCENARIO });
    assert.equal(r.conditions.baseline.critical_sufficiency, 0);
    assert.equal(r.conditions.ledger.critical_sufficiency, 1);
  });

  test('critical sufficiency survives every budget in the sweep', () => {
    const r = runExperiment({ scenario: RATE_LIMIT_SCENARIO });
    for (const b of r.budget_sweep) {
      assert.equal(
        b.critical_sufficiency, 1,
        `critical state lost at budget ${b.budget_chars} — the protection rule regressed`,
      );
    }
    // and squeezing the budget must actually cost something, or the sweep is theatre
    const loosest = r.budget_sweep[0]!;
    const tightest = r.budget_sweep[r.budget_sweep.length - 1]!;
    assert.ok(tightest.sufficiency < loosest.sufficiency, 'budget pressure had no effect');
  });

  test('the result declares what it does not measure', () => {
    const r = runExperiment({ scenario: RATE_LIMIT_SCENARIO });
    assert.match(r.measurement_scope.not_measured, /Agent behaviour/);
    assert.match(r.measurement_scope.not_measured, /upper bound/);
  });

  test('probe matching is AND-of-ORs and does not accept a partial hit', () => {
    const probe = {
      id: 'p', question: 'q', criticality: 'critical' as const,
      requires: [['alpha', 'alfa'], ['beta']],
      failure_if_missing: 'x',
    };
    assert.equal(evaluateProbe(probe, 'alpha and beta').satisfied, true);
    assert.equal(evaluateProbe(probe, 'alfa and beta').satisfied, true);
    assert.equal(evaluateProbe(probe, 'alpha only').satisfied, false);
    assert.equal(evaluateProbe(probe, 'ALPHA and BETA').satisfied, true, 'must be case-insensitive');
    assert.deepEqual(evaluateProbe(probe, 'alpha only').missing_groups, [['beta']]);
  });

  test('every registered scenario is internally consistent', () => {
    for (const scenario of Object.values(SCENARIOS)) {
      const ids = scenario.probes.map((p) => p.id);
      assert.equal(new Set(ids).size, ids.length, `${scenario.id}: duplicate probe ids`);
      for (const p of scenario.probes) {
        assert.ok(p.requires.length > 0, `${p.id}: probe with no requirements always passes`);
        assert.ok(p.requires.every((g) => g.length > 0), `${p.id}: empty requirement group`);
        assert.ok(p.failure_if_missing.length > 20, `${p.id}: no stated consequence`);
      }
      const completions = scenario.session_a.filter((s) => s.kind === 'todo_complete');
      const todos = new Set(scenario.session_a.filter((s) => s.kind === 'todo').map((s) => s.text));
      for (const c of completions) {
        assert.ok(todos.has(c.target), `${scenario.id}: todo_complete targets a nonexistent todo`);
      }
    }
  });
});
