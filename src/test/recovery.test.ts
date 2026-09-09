import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deterministicService, seedTask } from './helpers.js';
import { selectRecovery, overlapScore, tokenize } from '../recovery/select.js';
import type { LedgerService } from '../service.js';

function richTask(svc: LedgerService) {
  const { task, ac, c } = seedTask(svc);
  svc.store.write({
    task_id: task.id, type: 'acceptance_criterion',
    content: 'Rate limit state is shared correctly across all worker processes', session_id: 's',
  });
  svc.store.write({
    task_id: task.id, type: 'constraint', content: 'Must not increase p99 latency by more than 5ms',
    severity: 'important', session_id: 's',
  });
  svc.store.write({
    task_id: task.id, type: 'constraint', content: 'Prefer British spelling in user-facing strings',
    severity: 'advisory', session_id: 's',
  });
  const d1 = svc.store.write({
    task_id: task.id, type: 'decision', content: 'Implement a sliding-window log limiter',
    rationale: 'fixed-window permits a 2x burst across the boundary', confidence: 0.8, session_id: 's',
  });
  svc.store.write({
    task_id: task.id, type: 'rejected_approach', content: 'Enforce limits in nginx with limit_req',
    rationale: 'nginx cannot see the API key, only the source IP, so per-key limits are impossible',
    evidence: 'nginx.conf has no access to the Authorization header at that stage', session_id: 's',
  });
  svc.store.write({
    task_id: task.id, type: 'finding', content: 'Auth middleware resolves the API key in src/app.ts:41',
    evidence: 'src/app.ts:41', confidence: 0.95, session_id: 's',
  });
  svc.store.write({
    task_id: task.id, type: 'finding', content: 'The CI image pins Node 18, not Node 20',
    evidence: '.github/workflows/ci.yml', confidence: 0.9, session_id: 's',
  });
  const todo = svc.store.write({
    task_id: task.id, type: 'todo', content: 'Wire the limiter into the router', session_id: 's',
  });
  svc.store.write({ task_id: task.id, type: 'todo', content: 'Add integration test for 429', session_id: 's' });
  svc.store.write({
    task_id: task.id, type: 'open_question', content: 'Should limits apply to internal service tokens?',
    session_id: 's',
  });
  svc.store.write({
    task_id: task.id, type: 'verification', content: 'unit suite green, integration not yet written',
    evidence: 'npm test', session_id: 's', source: 'tool',
    metadata: { command: 'npm test', passed: true, acceptance_criteria_met: [], constraints_violated: [] },
  });
  return { task, ac, c, d1, todo };
}

describe('recovery: determinism', () => {
  test('identical requests produce byte-identical output', () => {
    const svc = deterministicService(':memory:');
    const { task } = richTask(svc);
    const a = svc.recover({ task_id: task.id, session_id: 's1' });
    const b = svc.recover({ task_id: task.id, session_id: 's2' });
    assert.equal(a.text, b.text);
    assert.equal(a.selection.fingerprint, b.selection.fingerprint);
    svc.close();
  });

  test('output does not depend on wall-clock time or on record ids', () => {
    // Same logical history, different clock and a different id sequence.
    // If either leaked into the rendering, these would differ.
    const one = deterministicService(':memory:', { startIso: '2026-01-01T00:00:00.000Z', idPrefix: 'a' });
    const two = deterministicService(':memory:', { startIso: '2031-06-15T12:34:56.000Z', idPrefix: 'b' });
    const t1 = richTask(one);
    const t2 = richTask(two);
    const a = one.recover({ task_id: t1.task.id, session_id: 'x' });
    const b = two.recover({ task_id: t2.task.id, session_id: 'y' });
    // Ids legitimately differ in the header line; compare the body.
    const body = (s: string) => s.split('\n').filter((l) => !l.startsWith('task: ') && !l.startsWith('[budget'));
    assert.deepEqual(body(a.text), body(b.text));
    assert.equal(a.selection.used_chars, b.selection.used_chars);
    one.close();
    two.close();
  });

  test('a different focus changes ranking deterministically, not randomly', () => {
    const svc = deterministicService(':memory:');
    const { task } = richTask(svc);
    const f1a = svc.recover({ task_id: task.id, focus: 'CI node version', session_id: 's' });
    const f1b = svc.recover({ task_id: task.id, focus: 'CI node version', session_id: 's' });
    assert.equal(f1a.text, f1b.text);
    const f2 = svc.recover({ task_id: task.id, focus: 'auth middleware api key', session_id: 's' });
    assert.notEqual(f1a.selection.fingerprint, f2.selection.fingerprint);
    svc.close();
  });

  test('ranking has no ties left to chance: equal-score items order by ordinal then id', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    for (let i = 0; i < 5; i++) {
      svc.store.write({
        task_id: task.id, type: 'finding', content: `unrelated observation number ${i}`, session_id: 's',
      });
    }
    const sel = selectRecovery(svc.store, { task_id: task.id, focus: 'zzzzz nonmatching' });
    const findings = sel.sections.find((s) => s.key === 'findings')!;
    const ids = findings.items.map((i) => i.record.id);
    assert.deepEqual(ids, [...ids].sort().reverse(), 'expected descending ordinal for equal scores');
    svc.close();
  });
});

describe('recovery: bounding', () => {
  test('a generous budget stays within budget', () => {
    const svc = deterministicService(':memory:');
    const { task } = richTask(svc);
    const { selection, text } = svc.recover({ task_id: task.id, budget_chars: 4000, session_id: 's' });
    assert.ok(selection.used_chars <= 4000);
    assert.equal(selection.budget_exceeded, false);
    assert.ok(text.length < 6000);
    svc.close();
  });

  test('a tight budget drops low-priority material and says so', () => {
    const svc = deterministicService(':memory:');
    const { task } = richTask(svc);
    const { selection, text } = svc.recover({ task_id: task.id, budget_chars: 600, session_id: 's' });
    assert.ok(selection.total_omitted > 0, 'expected omissions at a 600-char budget');
    assert.ok(text.includes('not shown (budget)'), 'omissions must be visible in the output');
    assert.ok(text.includes('This reconstruction is partial.'));
    svc.close();
  });

  test('blocking constraints are NEVER dropped, even at an absurd budget', () => {
    const svc = deterministicService(':memory:');
    const { task } = richTask(svc);
    const { selection, text } = svc.recover({ task_id: task.id, budget_chars: 200, session_id: 's' });
    assert.ok(text.includes('No new runtime dependencies'), 'blocking constraint was dropped');
    assert.equal(selection.budget_exceeded, true);
    assert.ok(text.includes('BUDGET EXCEEDED'), 'over-budget must be declared');
    svc.close();
  });

  test('unmet acceptance criteria and rejected approaches are never dropped', () => {
    const svc = deterministicService(':memory:');
    const { task } = richTask(svc);
    const { text } = svc.recover({ task_id: task.id, budget_chars: 200, session_id: 's' });
    assert.ok(text.includes('HTTP 429'), 'unmet acceptance criterion was dropped');
    assert.ok(text.includes('limit_req'), 'rejected approach was dropped');
    svc.close();
  });

  test('an advisory constraint IS droppable under pressure', () => {
    const svc = deterministicService(':memory:');
    const { task } = richTask(svc);
    const { text } = svc.recover({ task_id: task.id, budget_chars: 200, session_id: 's' });
    assert.ok(!text.includes('British spelling'));
    svc.close();
  });
});

describe('recovery: content', () => {
  test('contains every mandated section, and marks empty ones explicitly', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    const { text } = svc.recover({ task_id: task.id, session_id: 's' });
    for (const h of [
      'ORIGINAL OBJECTIVE', 'ACTIVE CONSTRAINTS', 'ACCEPTANCE CRITERIA',
      'CURRENT PLAN', 'DECISIONS ALREADY MADE', 'FAILED APPROACHES — DO NOT REPEAT',
      'OPEN QUESTIONS', 'RELEVANT FINDINGS', 'LAST VERIFICATION STATE',
    ]) {
      assert.ok(text.includes(h), `missing section: ${h}`);
    }
    assert.ok(text.includes('(none recorded)'), 'empty sections must be explicit, not omitted');
    svc.close();
  });

  test('decisions carry their rationale into recovery', () => {
    const svc = deterministicService(':memory:');
    const { task } = richTask(svc);
    const { text } = svc.recover({ task_id: task.id, session_id: 's' });
    assert.ok(text.includes('because: fixed-window permits a 2x burst'));
    svc.close();
  });

  test('completed todos and resolved questions leave the plan', () => {
    const svc = deterministicService(':memory:');
    const { task, todo } = richTask(svc);
    svc.store.transition(todo.id, 'done', 's');
    const { text } = svc.recover({ task_id: task.id, session_id: 's' });
    assert.ok(!text.includes('Wire the limiter into the router'));
    assert.ok(text.includes('Add integration test for 429'));
    svc.close();
  });

  test('met acceptance criteria are shown as MET, not hidden', () => {
    const svc = deterministicService(':memory:');
    const { task, ac } = richTask(svc);
    svc.store.transition(ac.id, 'done', 's');
    const { text } = svc.recover({ task_id: task.id, session_id: 's' });
    assert.ok(text.includes('[MET] Requests over 100/min'));
    svc.close();
  });

  test('the output tells the reader not to trust it over the repository', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    const { text } = svc.recover({ task_id: task.id, session_id: 's' });
    assert.ok(text.includes('trust the repository'));
    svc.close();
  });

  test('recovery emits a telemetry event so utilisation is measurable', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    svc.recover({ task_id: task.id, session_id: 's' });
    const evs = svc.store.listEvents(task.id).filter((e) => e.type === 'recovery_requested');
    assert.equal(evs.length, 1);
    assert.equal(evs[0]!.session_id, 's');
    svc.close();
  });
});

describe('lexical ranking primitives', () => {
  test('tokenize strips stopwords and short tokens', () => {
    assert.deepEqual(tokenize('The auth middleware is in src/app.ts'), ['auth', 'middleware', 'src/app.ts']);
  });

  test('overlapScore is coverage of the query, bounded to [0,1]', () => {
    const q = new Set(['auth', 'middleware']);
    assert.equal(overlapScore(q, 'the auth middleware'), 1);
    assert.equal(overlapScore(q, 'the auth layer'), 0.5);
    assert.equal(overlapScore(q, 'nothing relevant'), 0);
    assert.equal(overlapScore(new Set(), 'anything'), 0);
  });
});
