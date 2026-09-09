/**
 * Session-reset experiment harness.
 *
 * WHAT THIS MEASURES, AND WHAT IT DOES NOT
 * ----------------------------------------
 * MEASURED, deterministically, with no model in the loop:
 *   CONTEXT SUFFICIENCY — of the state items Session B provably needs, what
 *   fraction is present in the resume context it is handed? This is a real
 *   property of a real artifact (the text the agent receives), and it is the
 *   necessary condition for the whole hypothesis: an agent cannot honour a
 *   constraint that is not in front of it.
 *
 * NOT MEASURED HERE, and reported as such:
 *   Whether a real coding agent, given a sufficient context, actually behaves
 *   better — fewer repeated dead ends, fewer constraint violations, higher task
 *   success. Sufficiency is an UPPER BOUND on those outcomes, not a substitute.
 *   Closing that gap needs live agent runs; the design is pre-registered in
 *   docs/agentdev-experiment.md and the result slots are left empty.
 *
 * The baseline condition is deliberately generous: it receives the ticket plus
 * everything the repository still carries (partial code, TODO comments, commit
 * message, test state). Weakening the baseline would manufacture a win.
 */
import { LedgerService } from '../service.js';
import type { KnowledgeProbe, Scenario, SessionAStep } from './scenario.js';
import type { LedgerRecord } from '../domain/types.js';

export interface ProbeOutcome {
  probe_id: string;
  question: string;
  criticality: KnowledgeProbe['criticality'];
  satisfied: boolean;
  /** Which requirement groups were unmet — useful for debugging a scenario. */
  missing_groups: string[][];
  failure_if_missing: string;
}

export type ConditionName = 'baseline' | 'ledger_only' | 'ledger';

export interface ConditionResult {
  condition: ConditionName;
  context_chars: number;
  probes: ProbeOutcome[];
  satisfied: number;
  total: number;
  sufficiency: number;
  critical_satisfied: number;
  critical_total: number;
  critical_sufficiency: number;
  /** Recovered facts per 1000 characters of context spent. */
  density: number;
  context: string;
}

export interface ExperimentResult {
  scenario_id: string;
  scenario_title: string;
  measured_at: string;
  budget_chars: number;
  session_a_records: number;
  conditions: {
    baseline: ConditionResult;
    /** Recovery WITHOUT the repository. Included to test the honest claim that
     *  the ledger supplements the repo rather than replacing it. */
    ledger_only: ConditionResult;
    ledger: ConditionResult;
  };
  /** Sufficiency as the recovery budget is squeezed. Shows the bounding cost. */
  budget_sweep: { budget_chars: number; used_chars: number; sufficiency: number; critical_sufficiency: number; budget_exceeded: boolean }[];
  delta: {
    sufficiency: number;
    critical_sufficiency: number;
    density: number;
  };
  /** Present so no reader mistakes this for an agent-behaviour result. */
  measurement_scope: {
    measured: string;
    not_measured: string;
    baseline_fairness: string;
  };
  recovery_fingerprint: string;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ');
}

/** Deterministic AND-of-ORs matcher. No model, no fuzzy scoring. */
export function evaluateProbe(probe: KnowledgeProbe, context: string): ProbeOutcome {
  const hay = norm(context);
  const missing: string[][] = [];
  for (const group of probe.requires) {
    if (!group.some((alt) => hay.includes(norm(alt)))) missing.push(group);
  }
  return {
    probe_id: probe.id,
    question: probe.question,
    criticality: probe.criticality,
    satisfied: missing.length === 0,
    missing_groups: missing,
    failure_if_missing: probe.failure_if_missing,
  };
}

function score(
  condition: ConditionName,
  context: string,
  probes: KnowledgeProbe[],
): ConditionResult {
  const outcomes = probes.map((p) => evaluateProbe(p, context));
  const satisfied = outcomes.filter((o) => o.satisfied).length;
  const crit = outcomes.filter((o) => o.criticality === 'critical');
  const critSat = crit.filter((o) => o.satisfied).length;
  return {
    condition,
    context_chars: context.length,
    probes: outcomes,
    satisfied,
    total: outcomes.length,
    sufficiency: outcomes.length === 0 ? 0 : satisfied / outcomes.length,
    critical_satisfied: critSat,
    critical_total: crit.length,
    critical_sufficiency: crit.length === 0 ? 0 : critSat / crit.length,
    density: context.length === 0 ? 0 : (satisfied / context.length) * 1000,
    context,
  };
}

/**
 * Replay Session A into a ledger. This is the "agent did work and recorded it"
 * half; it is scripted precisely so the experiment is reproducible.
 */
export function replaySessionA(
  svc: LedgerService,
  scenario: Scenario,
  sessionId = 'session_a',
): { task_id: string; records: LedgerRecord[] } {
  const task = svc.store.createTask({
    objective: scenario.objective,
    repo: scenario.repo,
    session_id: sessionId,
  });
  const todosByText = new Map<string, string>();
  const records: LedgerRecord[] = [];

  for (const step of scenario.session_a) {
    if (step.kind === 'todo_complete') {
      const id = todosByText.get(step.target!);
      if (!id) throw new Error(`scenario error: todo_complete targets unknown todo "${step.target}"`);
      records.push(svc.store.transition(id, 'done', sessionId, 'completed in session A'));
      continue;
    }
    const rec = svc.store.write({
      task_id: task.id,
      type: step.kind === 'verification' ? 'verification' : step.kind,
      content: step.text!,
      rationale: step.rationale ?? null,
      evidence: step.evidence ?? null,
      severity: step.severity ?? null,
      confidence: step.confidence ?? null,
      session_id: sessionId,
      source: step.kind === 'verification' ? 'tool' : 'agent',
      metadata:
        step.kind === 'verification'
          ? { command: step.evidence ?? 'npm test', passed: step.passed ?? true, acceptance_criteria_met: [], constraints_violated: [] }
          : {},
    });
    if (step.kind === 'todo') todosByText.set(step.text!, rec.id);
    records.push(rec);
  }
  return { task_id: task.id, records };
}

export interface RunOptions {
  scenario: Scenario;
  /** Where to build the experiment ledger. ':memory:' keeps runs hermetic. */
  dbPath?: string;
  budget_chars?: number;
}

export function runExperiment(opts: RunOptions): ExperimentResult {
  const { scenario } = opts;
  const budget = opts.budget_chars ?? 4000;
  const svc = new LedgerService({ path: opts.dbPath ?? ':memory:' });
  try {
    const { task_id, records } = replaySessionA(svc, scenario);

    // --- CONDITION A: baseline. Ticket + repository state, no ledger. ------
    const baseline = score('baseline', scenario.baseline_context, scenario.probes);

    // --- CONDITION B: the same baseline PLUS ledger recovery. --------------
    // Note the "plus": the ledger condition is baseline + recovery, because a
    // real Session B still has the repository. Comparing recovery *instead of*
    // the repo would be a strawman.
    const { selection, text } = svc.recover({
      task_id,
      budget_chars: budget,
      session_id: 'session_b',
    });
    const ledgerOnly = score('ledger_only', text, scenario.probes);
    const ledger = score('ledger', `${scenario.baseline_context}\n\n${text}`, scenario.probes);

    // --- budget sweep: what does bounding actually cost? -------------------
    const budget_sweep = [4000, 2500, 1500, 900, 500].map((b) => {
      const r = svc.recover({ task_id, budget_chars: b, session_id: 'session_b_sweep' });
      const sc = score('ledger', `${scenario.baseline_context}\n\n${r.text}`, scenario.probes);
      return {
        budget_chars: b,
        used_chars: r.selection.used_chars,
        sufficiency: sc.sufficiency,
        critical_sufficiency: sc.critical_sufficiency,
        budget_exceeded: r.selection.budget_exceeded,
      };
    });

    return {
      scenario_id: scenario.id,
      scenario_title: scenario.title,
      measured_at: new Date().toISOString(),
      budget_chars: budget,
      session_a_records: records.length,
      conditions: { baseline, ledger_only: ledgerOnly, ledger },
      budget_sweep,
      delta: {
        sufficiency: ledger.sufficiency - baseline.sufficiency,
        critical_sufficiency: ledger.critical_sufficiency - baseline.critical_sufficiency,
        density: ledger.density - baseline.density,
      },
      measurement_scope: {
        measured:
          'Context sufficiency: the fraction of state items Session B provably needs that are ' +
          'present in the resume context it receives. Deterministic string matching, no model.',
        not_measured:
          'Agent behaviour. Whether a real coding agent given the sufficient context actually ' +
          'avoids the repeated dead ends, honours the constraints and completes the task. ' +
          'Sufficiency is a necessary condition and an upper bound, not evidence of outcome. ' +
          'See docs/agentdev-experiment.md for the pre-registered live-agent design.',
        baseline_fairness:
          'The baseline receives the full ticket plus the repository as Session A left it ' +
          '(partial implementation, TODO comment, commit message, passing test suite), and the ' +
          'ledger condition receives that SAME context plus recovery. The comparison is additive.',
      },
      recovery_fingerprint: selection.fingerprint,
    };
  } finally {
    svc.close();
  }
}

export function formatExperiment(r: ExperimentResult): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push(`SCENARIO: ${r.scenario_title}  (${r.scenario_id})`);
  lines.push(`Session A recorded ${r.session_a_records} ledger records.`);
  lines.push('');
  lines.push('MEASURED — context sufficiency of the Session B resume context');
  lines.push('');
  lines.push(
    `  ${'condition'.padEnd(12)} ${'chars'.padStart(7)} ${'all probes'.padStart(12)} ${'critical'.padStart(12)} ${'facts/1k'.padStart(9)}`,
  );
  for (const c of [r.conditions.baseline, r.conditions.ledger_only, r.conditions.ledger]) {
    lines.push(
      `  ${c.condition.padEnd(12)} ${String(c.context_chars).padStart(7)} ` +
        `${`${c.satisfied}/${c.total} ${pct(c.sufficiency)}`.padStart(12)} ` +
        `${`${c.critical_satisfied}/${c.critical_total} ${pct(c.critical_sufficiency)}`.padStart(12)} ` +
        `${c.density.toFixed(2).padStart(9)}`,
    );
  }
  lines.push('');
  lines.push(
    `  delta: ${pct(r.delta.sufficiency)} overall, ${pct(r.delta.critical_sufficiency)} on critical items`,
  );
  lines.push('');
  lines.push('Cost of bounding — sufficiency as the recovery budget is squeezed:');
  lines.push(`  ${'budget'.padStart(7)} ${'used'.padStart(6)} ${'all'.padStart(7)} ${'critical'.padStart(9)}  note`);
  for (const b of r.budget_sweep) {
    lines.push(
      `  ${String(b.budget_chars).padStart(7)} ${String(b.used_chars).padStart(6)} ` +
        `${pct(b.sufficiency).padStart(7)} ${pct(b.critical_sufficiency).padStart(9)}  ` +
        (b.budget_exceeded ? 'over budget: critical state refused to be dropped' : ''),
    );
  }
  lines.push('');
  const missed = r.conditions.baseline.probes.filter((p) => !p.satisfied);
  if (missed.length) {
    lines.push('State the BASELINE lacks (and the predicted consequence):');
    for (const m of missed) {
      const fixed = r.conditions.ledger.probes.find((p) => p.probe_id === m.probe_id)?.satisfied;
      lines.push(`  [${m.criticality}] ${m.question}`);
      lines.push(`      -> ${m.failure_if_missing}`);
      lines.push(`      -> recovered by ledger: ${fixed ? 'YES' : 'NO'}`);
    }
    lines.push('');
  }
  const stillMissed = r.conditions.ledger.probes.filter((p) => !p.satisfied);
  if (stillMissed.length) {
    lines.push('State the LEDGER condition ALSO lacks (honest negative result):');
    for (const m of stillMissed) lines.push(`  [${m.criticality}] ${m.question}`);
    lines.push('');
  }
  lines.push('NOT MEASURED: ' + r.measurement_scope.not_measured);
  return lines.join('\n');
}
