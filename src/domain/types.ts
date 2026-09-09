/**
 * Canonical state model for Context Ledger.
 *
 * Design constraint: ONE record table with a discriminated `type`, not a graph.
 * The model exists to answer a single question well — "what must an agent know
 * to correctly continue this task?" — not to represent arbitrary knowledge.
 *
 * See ARCHITECTURE.md ("Why one table, not a knowledge graph").
 */

export const RECORD_TYPES = [
  'constraint',
  'acceptance_criterion',
  'decision',
  'rejected_approach',
  'finding',
  'open_question',
  'todo',
  'verification',
] as const;

export type RecordType = (typeof RECORD_TYPES)[number];

/**
 * Statuses are shared across types deliberately: a small closed set keeps
 * recovery selection logic uniform. `allowedStatuses` enforces which subset is
 * legal per type, so the uniformity does not become sloppiness.
 */
export const RECORD_STATUSES = [
  'active',
  'superseded',
  'resolved',
  'done',
  'blocked',
  'invalidated',
] as const;

export type RecordStatus = (typeof RECORD_STATUSES)[number];

export const ALLOWED_STATUSES: Record<RecordType, readonly RecordStatus[]> = {
  constraint: ['active', 'superseded', 'invalidated'],
  acceptance_criterion: ['active', 'superseded', 'done', 'invalidated'],
  decision: ['active', 'superseded', 'invalidated'],
  rejected_approach: ['active', 'superseded', 'invalidated'],
  finding: ['active', 'superseded', 'invalidated'],
  open_question: ['active', 'resolved', 'superseded', 'invalidated'],
  todo: ['active', 'done', 'blocked', 'superseded', 'invalidated'],
  verification: ['active', 'superseded'],
};

/** Terminal statuses: a record in one of these is no longer "live" state. */
export const INACTIVE_STATUSES: readonly RecordStatus[] = [
  'superseded',
  'invalidated',
];

export type Severity = 'blocking' | 'important' | 'advisory';
export const SEVERITIES: readonly Severity[] = ['blocking', 'important', 'advisory'];

export type TaskStatus = 'open' | 'closed' | 'abandoned';

export interface Task {
  id: string;
  /** The original, verbatim objective. Never rewritten — only superseded via a decision. */
  objective: string;
  repo: string | null;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

/**
 * Provenance. Every record must say who wrote it and on what basis.
 * Without this, recovery output is unfalsifiable to the reading agent.
 */
export interface Provenance {
  /** Who asserted this: the agent, the human, or a tool/command. */
  source: 'agent' | 'human' | 'tool';
  /** Session that produced the record; used for cross-session metrics. */
  session_id: string;
  /** Optional pointer to the evidence (file path, command, URL, ticket). */
  evidence: string | null;
}

export interface LedgerRecord extends Provenance {
  id: string;
  task_id: string;
  type: RecordType;
  /** The assertion itself. Immutable once written. */
  content: string;
  status: RecordStatus;
  /** Why this record exists. Required for decision/rejected_approach. */
  rationale: string | null;
  severity: Severity | null;
  /** 0..1. Only meaningful for finding / decision. Null means "not stated". */
  confidence: number | null;
  /** id of the record this one replaces. Enforced same-task, single-successor. */
  supersedes: string | null;
  /** Free-form typed payload, per record type. Validated at the boundary. */
  metadata: Record<string, unknown>;
  /** Number of secret redactions applied on write. >0 means content was altered. */
  redactions: number;
  created_at: string;
  updated_at: string;
}

export interface NewRecordInput {
  task_id: string;
  type: RecordType;
  content: string;
  session_id: string;
  source?: 'agent' | 'human' | 'tool';
  evidence?: string | null;
  rationale?: string | null;
  severity?: Severity | null;
  confidence?: number | null;
  supersedes?: string | null;
  status?: RecordStatus;
  metadata?: Record<string, unknown>;
}

export interface TelemetryEvent {
  id: string;
  ts: string;
  task_id: string | null;
  session_id: string | null;
  type: string;
  payload: Record<string, unknown>;
}

export class LedgerError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not_found'
      | 'invalid_record'
      | 'invalid_supersession'
      | 'invalid_transition'
      | 'secret_rejected'
      | 'task_mismatch',
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}
