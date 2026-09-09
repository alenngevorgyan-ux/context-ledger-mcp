/**
 * Application service: the operations the MCP tools and the CLI both need.
 * Keeping this separate from the MCP layer is what makes the CLI, the tests
 * and the experiment harness exercise the same code paths the agent uses.
 */
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './storage/db.js';
import { LedgerStore } from './storage/store.js';
import { computeMetrics, type MetricsReport } from './telemetry/metrics.js';
import { renderRecovery } from './recovery/render.js';
import { selectRecovery, type RecoveryRequest, type RecoverySelection } from './recovery/select.js';
import type { LedgerRecord, Task } from './domain/types.js';
import type { RedactionPolicy } from './redaction/redact.js';

export interface ServiceOptions {
  path: string;
  redaction?: RedactionPolicy;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export interface TaskStateView {
  task: Task;
  counts: Record<string, number>;
  records: LedgerRecord[];
}

export class LedgerService {
  readonly store: LedgerStore;
  readonly db: DatabaseSync;

  constructor(opts: ServiceOptions) {
    this.db = openDatabase({ path: opts.path });
    this.store = new LedgerStore({
      db: this.db,
      ...(opts.redaction ? { redaction: opts.redaction } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.newId ? { newId: opts.newId } : {}),
    });
  }

  close(): void {
    this.db.close();
  }

  /**
   * Recovery. Emits `recovery_requested` so utilisation is measurable — this is
   * the one read path that is also a product event.
   */
  recover(req: RecoveryRequest & { session_id: string }): {
    selection: RecoverySelection;
    text: string;
  } {
    const selection = selectRecovery(this.store, req);
    const text = renderRecovery(selection);
    this.store.emit('recovery_requested', {
      task_id: req.task_id,
      session_id: req.session_id,
      payload: {
        budget_chars: selection.budget_chars,
        used_chars: selection.used_chars,
        omitted: selection.total_omitted,
        budget_exceeded: selection.budget_exceeded,
        focus: req.focus ?? null,
        fingerprint: selection.fingerprint,
      },
    });
    return { selection, text };
  }

  taskState(task_id: string): TaskStateView {
    const task = this.store.requireTask(task_id);
    const records = this.store.listRecords(task_id);
    const counts: Record<string, number> = {};
    for (const r of records) {
      counts[r.type] = (counts[r.type] ?? 0) + 1;
      const liveKey = `${r.type}:${r.status}`;
      counts[liveKey] = (counts[liveKey] ?? 0) + 1;
    }
    return { task, counts, records };
  }

  metrics(task_id?: string): MetricsReport {
    return computeMetrics(this.store, task_id);
  }
}
