/**
 * Derived product metrics.
 *
 * Explicit stance: this module reports what the ledger can honestly observe and
 * refuses to synthesise the rest. Several metrics people would want here
 * (true constraint-violation rate, true duplicate exploration) are NOT
 * observable from inside an MCP server — the server never sees the agent's
 * file reads or its final diff. Those are marked `observability: 'partial'`
 * or 'self_reported' and are explained in docs/product-metrics.md.
 *
 * Metrics NOT provided, on purpose: total records stored, total MCP calls,
 * tokens persisted. They measure our own activity, not the user's outcome.
 */
import type { LedgerStore } from '../storage/store.js';
import type { TelemetryEvent } from '../domain/types.js';
import { tokenize } from '../recovery/select.js';

export type Observability = 'direct' | 'self_reported' | 'partial';

export interface Metric {
  key: string;
  value: number | null;
  unit: string;
  observability: Observability;
  /** Denominator, so a reader can judge whether the value means anything. */
  n: number;
  note: string;
}

/** Normalised signature of a text assertion, for duplicate detection. */
export function signature(text: string): string {
  return [...new Set(tokenize(text))].sort().join(' ');
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface MetricsReport {
  task_id: string | null;
  metrics: Metric[];
  sessions: number;
  generated_from_events: number;
}

const DUPLICATE_THRESHOLD = 0.8;

export function computeMetrics(store: LedgerStore, task_id?: string): MetricsReport {
  const events: TelemetryEvent[] = store.listEvents(task_id);
  const sessions = new Set(events.map((e) => e.session_id).filter(Boolean)).size;
  const metrics: Metric[] = [];

  const count = (type: string) => events.filter((e) => e.type === type).length;

  // --- utilisation -------------------------------------------------------
  const recoveries = count('recovery_requested');
  metrics.push({
    key: 'context_recovery_utilization',
    value: sessions === 0 ? null : recoveries / sessions,
    unit: 'recoveries per session',
    observability: 'direct',
    n: sessions,
    note: 'Sessions that never call recovery are getting no value from the ledger.',
  });

  // --- repeated failure --------------------------------------------------
  const tasks = task_id ? [task_id] : store.listTasks().map((t) => t.id);
  let rejected = 0;
  let repeatedRejections = 0;
  let findings = 0;
  let duplicateFindings = 0;
  for (const tid of tasks) {
    const seenRejected: Set<string>[] = [];
    for (const r of store.listRecords(tid, { types: ['rejected_approach'] })) {
      rejected++;
      const sig = new Set(signature(`${r.content} ${r.rationale ?? ''}`).split(' '));
      if (seenRejected.some((s) => jaccard(s, sig) >= DUPLICATE_THRESHOLD)) repeatedRejections++;
      seenRejected.push(sig);
    }
    const seenFindings: Set<string>[] = [];
    for (const r of store.listRecords(tid, { types: ['finding'] })) {
      findings++;
      const sig = new Set(signature(r.content).split(' '));
      if (seenFindings.some((s) => jaccard(s, sig) >= DUPLICATE_THRESHOLD)) duplicateFindings++;
      seenFindings.push(sig);
    }
  }
  metrics.push({
    key: 'repeated_failed_approach_rate',
    value: rejected === 0 ? null : repeatedRejections / rejected,
    unit: 'fraction',
    observability: 'partial',
    n: rejected,
    note:
      'Counts near-duplicate rejected approaches (Jaccard >= 0.8 on normalised tokens). ' +
      'Only sees approaches the agent bothered to record; a silently repeated failure is invisible here.',
  });
  metrics.push({
    key: 'duplicate_exploration_rate',
    value: findings === 0 ? null : duplicateFindings / findings,
    unit: 'fraction',
    observability: 'partial',
    n: findings,
    note: 'Near-duplicate findings — the agent rediscovering something it already knew.',
  });

  // --- constraint violations (self-reported only) ------------------------
  const verifications = store.listEvents(task_id).filter((e) => e.type === 'verification_recorded');
  let violations = 0;
  for (const tid of tasks) {
    for (const v of store.listRecords(tid, { types: ['verification'] })) {
      const vio = v.metadata['constraints_violated'];
      if (Array.isArray(vio)) violations += vio.length;
    }
  }
  metrics.push({
    key: 'constraint_violation_rate',
    value: verifications.length === 0 ? null : violations / verifications.length,
    unit: 'violations per verification',
    observability: 'self_reported',
    n: verifications.length,
    note:
      'SELF-REPORTED. The server cannot inspect the diff; it only knows what the agent declared ' +
      'in record_verification. Treat as a lower bound, never as a measured violation rate.',
  });

  // --- recovery -> action latency ---------------------------------------
  const latencies: number[] = [];
  const bySession = new Map<string, TelemetryEvent[]>();
  for (const e of events) {
    const k = e.session_id ?? '';
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k)!.push(e);
  }
  for (const evs of bySession.values()) {
    for (let i = 0; i < evs.length; i++) {
      if (evs[i]!.type !== 'recovery_requested') continue;
      const next = evs.slice(i + 1).find((e) => e.type.endsWith('_recorded') || e.type === 'record_transitioned');
      if (!next) continue;
      latencies.push(Date.parse(next.ts) - Date.parse(evs[i]!.ts));
    }
  }
  latencies.sort((a, b) => a - b);
  metrics.push({
    key: 'recovery_to_action_latency_p50_ms',
    value: latencies.length === 0 ? null : latencies[Math.floor(latencies.length / 2)]!,
    unit: 'ms',
    observability: 'direct',
    n: latencies.length,
    note:
      'Wall-clock from a recovery call to the next state-changing call in the same session. ' +
      'Proxy for "how fast did the agent get productive". Confounded by task difficulty.',
  });

  // --- resume outcome ----------------------------------------------------
  let resumedSessions = 0;
  let resumedAndVerified = 0;
  for (const [sid, evs] of bySession) {
    if (!sid) continue;
    const idx = evs.findIndex((e) => e.type === 'recovery_requested');
    if (idx === -1) continue;
    resumedSessions++;
    const passed = evs
      .slice(idx)
      .some((e) => e.type === 'verification_recorded' && e.payload['passed'] === true);
    if (passed) resumedAndVerified++;
  }
  metrics.push({
    key: 'successful_resume_rate',
    value: resumedSessions === 0 ? null : resumedAndVerified / resumedSessions,
    unit: 'fraction',
    observability: 'self_reported',
    n: resumedSessions,
    note:
      'Sessions that called recovery and later recorded a passing verification. ' +
      'Depends on the agent honestly recording verification results.',
  });

  // --- decision churn ----------------------------------------------------
  const superseded = count('record_superseded');
  const decisions = count('decision_recorded');
  metrics.push({
    key: 'decision_supersession_rate',
    value: decisions === 0 ? null : superseded / decisions,
    unit: 'fraction',
    observability: 'direct',
    n: decisions,
    note:
      'Guardrail. A high rate can mean healthy correction OR that the ledger is being used ' +
      'as a scratchpad. Interpret with decision count, not alone.',
  });

  // --- hygiene guardrail -------------------------------------------------
  let totalRecords = 0;
  let redactedRecords = 0;
  for (const tid of tasks) {
    for (const r of store.listRecords(tid)) {
      totalRecords++;
      if (r.redactions > 0) redactedRecords++;
    }
  }
  metrics.push({
    key: 'redacted_record_rate',
    value: totalRecords === 0 ? null : redactedRecords / totalRecords,
    unit: 'fraction',
    observability: 'direct',
    n: totalRecords,
    note: 'Guardrail. Non-zero means agents are pushing secret-shaped text at the ledger.',
  });

  return {
    task_id: task_id ?? null,
    metrics,
    sessions,
    generated_from_events: events.length,
  };
}
