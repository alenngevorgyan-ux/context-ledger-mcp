import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  ALLOWED_STATUSES,
  INACTIVE_STATUSES,
  LedgerError,
  RECORD_TYPES,
  SEVERITIES,
  type LedgerRecord,
  type NewRecordInput,
  type RecordStatus,
  type RecordType,
  type Task,
  type TaskStatus,
  type TelemetryEvent,
} from '../domain/types.js';
import {
  DEFAULT_REDACTION_POLICY,
  redact,
  type RedactionPolicy,
} from '../redaction/redact.js';

export interface StoreOptions {
  db: DatabaseSync;
  redaction?: RedactionPolicy;
  /** Injectable for deterministic tests. */
  now?: () => Date;
  newId?: (prefix: string) => string;
}

/** Fields whose free text is passed through the secret filter. */
const REDACTED_FIELDS = ['content', 'rationale', 'evidence'] as const;

/** Types for which a rationale is mandatory — these are the records an agent
 *  later has to *justify*, and an unjustified one is worse than none. */
const RATIONALE_REQUIRED: readonly RecordType[] = ['decision', 'rejected_approach'];

interface RowShape {
  id: string;
  task_id: string;
  type: string;
  content: string;
  status: string;
  rationale: string | null;
  severity: string | null;
  confidence: number | null;
  supersedes: string | null;
  source: string;
  session_id: string;
  evidence: string | null;
  metadata: string;
  redactions: number;
  created_at: string;
  updated_at: string;
  ordinal: number;
}

function toRecord(r: RowShape): LedgerRecord {
  return {
    id: r.id,
    task_id: r.task_id,
    type: r.type as RecordType,
    content: r.content,
    status: r.status as RecordStatus,
    rationale: r.rationale,
    severity: r.severity as LedgerRecord['severity'],
    confidence: r.confidence,
    supersedes: r.supersedes,
    source: r.source as LedgerRecord['source'],
    session_id: r.session_id,
    evidence: r.evidence,
    metadata: JSON.parse(r.metadata) as Record<string, unknown>,
    redactions: r.redactions,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/**
 * The single write/read boundary for ledger state.
 *
 * Invariants enforced here (not in the MCP layer, so they cannot be bypassed):
 *   I1  content is immutable; changing meaning requires supersession
 *   I2  a record can be superseded at most once (no forked chains)
 *   I3  supersession cannot cross task boundaries
 *   I4  an already-inactive record cannot be superseded again
 *   I5  status transitions are restricted to the type's allowed set
 *   I6  nothing is ever deleted; superseded records stay queryable
 *   I7  every write emits a telemetry event in the same transaction
 */
export class LedgerStore {
  private readonly db: DatabaseSync;
  private readonly policy: RedactionPolicy;
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;
  private readonly stmts = new Map<string, StatementSync>();

  constructor(opts: StoreOptions) {
    this.db = opts.db;
    this.policy = opts.redaction ?? DEFAULT_REDACTION_POLICY;
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? ((p) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 20)}`);
  }

  private sql(q: string): StatementSync {
    let s = this.stmts.get(q);
    if (!s) {
      s = this.db.prepare(q);
      this.stmts.set(q, s);
    }
    return s;
  }

  private ts(): string {
    return this.now().toISOString();
  }

  // ---------------------------------------------------------------- tasks

  createTask(input: {
    objective: string;
    repo?: string | null;
    session_id: string;
    id?: string;
  }): Task {
    const objective = input.objective.trim();
    if (!objective) throw new LedgerError('objective must be non-empty', 'invalid_record');
    const scrubbed = this.scrub(objective);
    const now = this.ts();
    const task: Task = {
      id: input.id ?? this.newId('task'),
      objective: scrubbed.text,
      repo: input.repo ?? null,
      status: 'open',
      created_at: now,
      updated_at: now,
    };
    // I7 applies to task creation too: the task row and its event commit
    // together, so the event log can never disagree with the task table.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.sql(
        `INSERT INTO tasks (id, objective, repo, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(task.id, task.objective, task.repo, task.status, task.created_at, task.updated_at);
      this.emitInTx('task_initialized', {
        task_id: task.id,
        session_id: input.session_id,
        payload: { repo: task.repo, redactions: scrubbed.count },
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return task;
  }

  getTask(id: string): Task | null {
    const row = this.sql('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as Task | undefined;
    return row ?? null;
  }

  requireTask(id: string): Task {
    const t = this.getTask(id);
    if (!t) throw new LedgerError(`unknown task: ${id}`, 'not_found');
    return t;
  }

  listTasks(): Task[] {
    return this.sql('SELECT * FROM tasks ORDER BY created_at DESC, id ASC').all() as unknown as Task[];
  }

  setTaskStatus(id: string, status: TaskStatus, session_id: string): Task {
    this.requireTask(id);
    const now = this.ts();
    this.sql('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
    this.emit('task_status_changed', { task_id: id, session_id, payload: { status } });
    return this.requireTask(id);
  }

  // -------------------------------------------------------------- records

  private scrub(text: string): { text: string; count: number } {
    if (this.policy.mode === 'off') return { text, count: 0 };
    const r = redact(text);
    if (r.count > 0 && this.policy.mode === 'reject') {
      const kinds = [...new Set(r.detections.map((d) => d.kind))].join(', ');
      throw new LedgerError(
        `refusing to store content containing likely secrets (${kinds}); ` +
          `remove the value or reference it indirectly`,
        'secret_rejected',
      );
    }
    return { text: r.text, count: r.count };
  }

  write(input: NewRecordInput): LedgerRecord {
    this.validateShape(input);
    const task = this.requireTask(input.task_id);
    if (task.status !== 'open') {
      throw new LedgerError(`task ${task.id} is ${task.status}; refusing new records`, 'invalid_record');
    }

    let redactions = 0;
    const scrubField = (v: string | null | undefined): string | null => {
      if (typeof v !== 'string' || v.length === 0) return v ?? null;
      const s = this.scrub(v);
      redactions += s.count;
      return s.text;
    };
    // REDACTED_FIELDS documents the covered surface; the calls below must match it.
    const content = scrubField(input.content)!;
    const rationale = scrubField(input.rationale);
    const evidence = scrubField(input.evidence);

    const status = input.status ?? this.defaultStatus(input.type);
    this.assertStatusAllowed(input.type, status);
    // A record must not be born inactive. `superseded` is reachable only by
    // being superseded (which requires a successor), and `invalidated` only by
    // an explicit transition. Allowing either at creation would let a caller
    // manufacture a superseded record with no successor, which breaks the
    // "the current record is well defined" property that recovery relies on.
    if (INACTIVE_STATUSES.includes(status)) {
      throw new LedgerError(
        `cannot create a record with status '${status}'; a record is born active ` +
          `and becomes ${status} only through supersession or an explicit transition`,
        'invalid_record',
      );
    }

    const now = this.ts();
    const id = this.newId('rec');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      let supersededPrior: LedgerRecord | null = null;
      if (input.supersedes) {
        supersededPrior = this.assertSupersedable(input.supersedes, input.task_id, input.type);
      }

      const ordinal =
        ((this.sql('SELECT COALESCE(MAX(ordinal), 0) AS m FROM records').get() as { m: number }).m ??
          0) + 1;

      this.sql(
        `INSERT INTO records
           (id, task_id, type, content, status, rationale, severity, confidence, supersedes,
            source, session_id, evidence, metadata, redactions, created_at, updated_at, ordinal)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        input.task_id,
        input.type,
        content,
        status,
        rationale,
        input.severity ?? null,
        input.confidence ?? null,
        input.supersedes ?? null,
        input.source ?? 'agent',
        input.session_id,
        evidence,
        JSON.stringify(input.metadata ?? {}),
        redactions,
        now,
        now,
        ordinal,
      );

      if (supersededPrior) {
        this.sql('UPDATE records SET status = ?, updated_at = ? WHERE id = ?').run(
          'superseded',
          now,
          supersededPrior.id,
        );
        this.emitInTx('record_superseded', {
          task_id: input.task_id,
          session_id: input.session_id,
          payload: { prior_id: supersededPrior.id, new_id: id, type: input.type },
        });
      }

      this.sql('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, input.task_id);

      this.emitInTx(`${input.type}_recorded`, {
        task_id: input.task_id,
        session_id: input.session_id,
        payload: {
          record_id: id,
          status,
          redactions,
          has_rationale: Boolean(rationale),
          confidence: input.confidence ?? null,
        },
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.requireRecord(id);
  }

  private defaultStatus(type: RecordType): RecordStatus {
    return type === 'todo' ? 'active' : 'active';
  }

  private validateShape(input: NewRecordInput): void {
    if (!RECORD_TYPES.includes(input.type)) {
      throw new LedgerError(`unknown record type: ${input.type}`, 'invalid_record');
    }
    if (typeof input.content !== 'string' || input.content.trim().length === 0) {
      throw new LedgerError('content must be a non-empty string', 'invalid_record');
    }
    if (input.content.length > 8000) {
      throw new LedgerError(
        'content exceeds 8000 chars; ledger records are task state, not transcripts',
        'invalid_record',
      );
    }
    if (!input.session_id || typeof input.session_id !== 'string') {
      throw new LedgerError('session_id is required (provenance)', 'invalid_record');
    }
    if (RATIONALE_REQUIRED.includes(input.type) && !input.rationale?.trim()) {
      throw new LedgerError(`${input.type} requires a rationale`, 'invalid_record');
    }
    if (input.severity != null && !SEVERITIES.includes(input.severity)) {
      throw new LedgerError(`invalid severity: ${input.severity}`, 'invalid_record');
    }
    if (input.confidence != null && !(input.confidence >= 0 && input.confidence <= 1)) {
      throw new LedgerError('confidence must be within [0, 1]', 'invalid_record');
    }
  }

  private assertStatusAllowed(type: RecordType, status: RecordStatus): void {
    if (!ALLOWED_STATUSES[type].includes(status)) {
      throw new LedgerError(
        `status '${status}' is not valid for record type '${type}' ` +
          `(allowed: ${ALLOWED_STATUSES[type].join(', ')})`,
        'invalid_transition',
      );
    }
  }

  private assertSupersedable(priorId: string, taskId: string, type: RecordType): LedgerRecord {
    const prior = this.getRecord(priorId);
    if (!prior) throw new LedgerError(`supersedes references unknown record: ${priorId}`, 'invalid_supersession');
    if (prior.task_id !== taskId) {
      throw new LedgerError(
        `cannot supersede a record belonging to another task (${prior.task_id})`,
        'task_mismatch',
      );
    }
    if (prior.type !== type) {
      throw new LedgerError(
        `cannot supersede a '${prior.type}' with a '${type}'; types must match`,
        'invalid_supersession',
      );
    }
    if (INACTIVE_STATUSES.includes(prior.status)) {
      throw new LedgerError(
        `record ${priorId} is already ${prior.status}; supersede its successor instead`,
        'invalid_supersession',
      );
    }
    return prior;
  }

  /**
   * Status-only transition. Content stays immutable (I1) — this exists for
   * lifecycle moves such as todo -> done or open_question -> resolved.
   */
  transition(
    id: string,
    status: RecordStatus,
    session_id: string,
    note?: string,
  ): LedgerRecord {
    const rec = this.requireRecord(id);
    if (INACTIVE_STATUSES.includes(rec.status)) {
      throw new LedgerError(
        `record ${id} is ${rec.status} and is frozen; transitions are not allowed`,
        'invalid_transition',
      );
    }
    this.assertStatusAllowed(rec.type, status);
    // `superseded` means "a successor exists". Reaching it by transition would
    // create a superseded record with nothing superseding it, so the
    // supersession chain would no longer have a well-defined head. Use
    // write({ supersedes }) instead; use `invalidated` to retire a record with
    // no replacement.
    if (status === 'superseded') {
      throw new LedgerError(
        `cannot transition to 'superseded' directly; write a successor record with ` +
          `supersedes='${id}', or use 'invalidated' to retire it without a replacement`,
        'invalid_transition',
      );
    }
    const now = this.ts();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.sql('UPDATE records SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
      this.emitInTx('record_transitioned', {
        task_id: rec.task_id,
        session_id,
        payload: { record_id: id, type: rec.type, from: rec.status, to: status, note: note ?? null },
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.requireRecord(id);
  }

  getRecord(id: string): LedgerRecord | null {
    const row = this.sql('SELECT * FROM records WHERE id = ?').get(id) as unknown as RowShape | undefined;
    return row ? toRecord(row) : null;
  }

  requireRecord(id: string): LedgerRecord {
    const r = this.getRecord(id);
    if (!r) throw new LedgerError(`unknown record: ${id}`, 'not_found');
    return r;
  }

  /** Deterministic order: ordinal ASC is a total order over all records. */
  listRecords(
    task_id: string,
    filter?: { types?: RecordType[]; statuses?: RecordStatus[] },
  ): LedgerRecord[] {
    const clauses = ['task_id = ?'];
    const params: unknown[] = [task_id];
    if (filter?.types?.length) {
      clauses.push(`type IN (${filter.types.map(() => '?').join(',')})`);
      params.push(...filter.types);
    }
    if (filter?.statuses?.length) {
      clauses.push(`status IN (${filter.statuses.map(() => '?').join(',')})`);
      params.push(...filter.statuses);
    }
    const rows = this.db
      .prepare(`SELECT * FROM records WHERE ${clauses.join(' AND ')} ORDER BY ordinal ASC`)
      .all(...(params as never[])) as unknown as RowShape[];
    return rows.map(toRecord);
  }

  /** Full supersession chain, oldest first. Auditability, not decoration. */
  history(id: string): LedgerRecord[] {
    const chain: LedgerRecord[] = [];
    let cur: LedgerRecord | null = this.requireRecord(id);
    while (cur) {
      chain.unshift(cur);
      cur = cur.supersedes ? this.getRecord(cur.supersedes) : null;
    }
    let head = this.sql('SELECT * FROM records WHERE supersedes = ?').get(id) as unknown as RowShape | undefined;
    while (head) {
      chain.push(toRecord(head));
      head = this.sql('SELECT * FROM records WHERE supersedes = ?').get(head.id) as unknown as RowShape | undefined;
    }
    return chain;
  }

  // ------------------------------------------------------------ telemetry

  private emitInTx(
    type: string,
    o: { task_id?: string | null; session_id?: string | null; payload?: Record<string, unknown> },
  ): void {
    this.sql('INSERT INTO events (id, ts, task_id, session_id, type, payload) VALUES (?,?,?,?,?,?)').run(
      this.newId('evt'),
      this.ts(),
      o.task_id ?? null,
      o.session_id ?? null,
      type,
      JSON.stringify(o.payload ?? {}),
    );
  }

  emit(
    type: string,
    o: { task_id?: string | null; session_id?: string | null; payload?: Record<string, unknown> },
  ): void {
    this.emitInTx(type, o);
  }

  listEvents(task_id?: string): TelemetryEvent[] {
    const rows = task_id
      ? (this.sql('SELECT * FROM events WHERE task_id = ? ORDER BY ts ASC, id ASC').all(task_id) as any[])
      : (this.sql('SELECT * FROM events ORDER BY ts ASC, id ASC').all() as unknown as any[]);
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      task_id: r.task_id,
      session_id: r.session_id,
      type: r.type,
      payload: JSON.parse(r.payload),
    }));
  }
}
