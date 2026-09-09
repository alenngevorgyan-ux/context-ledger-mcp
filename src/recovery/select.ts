/**
 * Context recovery — deterministic selection.
 *
 * This is the product, not the storage. Storage is table stakes; the claim
 * under test is that a *bounded, ordered, minimal* reconstruction of task state
 * is what lets an agent resume correctly after a context reset.
 *
 * Two properties are load-bearing and are both tested:
 *
 *  D1 DETERMINISM. Same ledger + same request => byte-identical output.
 *     Achieved by ranking on a total order (score, then ordinal, then id) and
 *     never consulting a clock, a random source, or a model.
 *
 *  D2 HONEST BOUNDING. Output respects a character budget, EXCEPT that blocking
 *     constraints and unmet acceptance criteria are never silently dropped —
 *     they are the state whose loss causes the failures this project exists to
 *     prevent. If they do not fit, the budget is reported as exceeded rather
 *     than quietly truncating them. Everything dropped is counted in
 *     `omitted`, so the reading agent knows the reconstruction is partial.
 *
 * Ranking uses deterministic lexical overlap, not embeddings. An optional
 * model-based re-ranker is deliberately NOT implemented; see
 * ARCHITECTURE.md ("Why no embeddings (yet)").
 */
import type { LedgerRecord, Task } from '../domain/types.js';
import type { LedgerStore } from '../storage/store.js';

export interface RecoveryRequest {
  task_id: string;
  /** Character budget for the rendered body. Default 4000. */
  budget_chars?: number;
  /** Optional free text describing what the agent is about to do. Biases
   *  finding/decision selection only; never affects mandatory sections. */
  focus?: string | null;
}

export type SectionKey =
  | 'objective'
  | 'constraints'
  | 'acceptance_criteria'
  | 'todos'
  | 'decisions'
  | 'rejected_approaches'
  | 'open_questions'
  | 'findings'
  | 'verification';

export interface SelectedItem {
  record: LedgerRecord;
  /** Rendered line, already budget-accounted. */
  line: string;
  score: number;
}

export interface Section {
  key: SectionKey;
  title: string;
  items: SelectedItem[];
  /** Candidates that existed but did not fit or did not rank high enough. */
  omitted: number;
  mandatory: boolean;
}

export interface RecoverySelection {
  task: Task;
  sections: Section[];
  budget_chars: number;
  used_chars: number;
  budget_exceeded: boolean;
  total_omitted: number;
  /** Stable hash of the selection inputs+outputs; used to assert determinism. */
  fingerprint: string;
}

export const DEFAULT_BUDGET = 4000;

/** Section order is fixed and meaningful: it is reading order for the agent. */
const SECTION_SPEC: {
  key: SectionKey;
  title: string;
  mandatory: boolean;
  /** Max items considered for inclusion, before budget. */
  cap: number;
}[] = [
  { key: 'objective', title: 'ORIGINAL OBJECTIVE', mandatory: true, cap: 1 },
  { key: 'constraints', title: 'ACTIVE CONSTRAINTS', mandatory: true, cap: 40 },
  { key: 'acceptance_criteria', title: 'ACCEPTANCE CRITERIA', mandatory: true, cap: 40 },
  { key: 'todos', title: 'CURRENT PLAN (REMAINING TODOS)', mandatory: false, cap: 20 },
  { key: 'decisions', title: 'DECISIONS ALREADY MADE', mandatory: false, cap: 20 },
  { key: 'rejected_approaches', title: 'FAILED APPROACHES — DO NOT REPEAT', mandatory: true, cap: 20 },
  { key: 'open_questions', title: 'OPEN QUESTIONS', mandatory: false, cap: 12 },
  { key: 'findings', title: 'RELEVANT FINDINGS', mandatory: false, cap: 12 },
  { key: 'verification', title: 'LAST VERIFICATION STATE', mandatory: false, cap: 1 },
];

const STOPWORDS = new Set(
  ('the a an and or of to in for on with is are be that this it as at by from we you i not no ' +
    'should must can will would could do does did have has had if then else when while use using')
    .split(' '),
);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Lexical overlap score in [0,1]. Deterministic and cheap.
 * Uses term coverage of the query, not TF-IDF: with tens of records per task,
 * corpus statistics are noise, and coverage is easier to reason about.
 */
export function overlapScore(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0) return 0;
  const docTokens = new Set(tokenize(text));
  let hits = 0;
  for (const t of queryTokens) if (docTokens.has(t)) hits++;
  return hits / queryTokens.size;
}

function fmtConfidence(c: number | null): string {
  return c == null ? '' : ` (confidence ${c.toFixed(2)})`;
}

function renderLine(r: LedgerRecord): string {
  switch (r.type) {
    case 'constraint': {
      const sev = r.severity ? `[${r.severity}] ` : '';
      const src = r.evidence ? ` — src: ${r.evidence}` : '';
      return `${sev}${r.content}${src}`;
    }
    case 'acceptance_criterion':
      return `[${r.status === 'done' ? 'MET' : 'NOT MET'}] ${r.content}`;
    case 'todo': {
      const state = r.status === 'blocked' ? 'BLOCKED' : 'TODO';
      return `[${state}] ${r.content}`;
    }
    case 'decision': {
      const why = r.rationale ? ` — because: ${r.rationale}` : '';
      return `${r.content}${why}${fmtConfidence(r.confidence)}`;
    }
    case 'rejected_approach': {
      const why = r.rationale ? ` — failed because: ${r.rationale}` : '';
      const ev = r.evidence ? ` (evidence: ${r.evidence})` : '';
      return `${r.content}${why}${ev}`;
    }
    case 'open_question':
      return `${r.content}`;
    case 'finding': {
      const ev = r.evidence ? ` (${r.evidence})` : '';
      return `${r.content}${ev}${fmtConfidence(r.confidence)}`;
    }
    case 'verification': {
      const passed = r.metadata['passed'];
      const flag = passed === true ? 'PASS' : passed === false ? 'FAIL' : 'UNKNOWN';
      const cmd = typeof r.metadata['command'] === 'string' ? ` \`${r.metadata['command']}\`` : '';
      return `[${flag}]${cmd} ${r.content}`;
    }
    default:
      return r.content;
  }
}

/** Total order for ties: higher score, then more recent (ordinal), then id. */
function cmp(a: SelectedItem & { ordinal: number }, b: SelectedItem & { ordinal: number }): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.ordinal !== a.ordinal) return b.ordinal - a.ordinal;
  return a.record.id.localeCompare(b.record.id);
}

function fingerprintOf(parts: string[]): string {
  // FNV-1a 64-bit, hex. No crypto import needed and stable across platforms.
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) {
      h = (h ^ BigInt(p.charCodeAt(i))) & mask;
      h = (h * prime) & mask;
    }
    h = (h ^ 0x7cn) & mask;
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

export function selectRecovery(store: LedgerStore, req: RecoveryRequest): RecoverySelection {
  const task = store.requireTask(req.task_id);
  const budget = req.budget_chars ?? DEFAULT_BUDGET;
  const all = store.listRecords(req.task_id);

  // `ordinal` is not on the public record type; recover it from list order,
  // which listRecords guarantees is ordinal ASC.
  const ordinalOf = new Map<string, number>();
  all.forEach((r, i) => ordinalOf.set(r.id, i + 1));

  const live = all.filter((r) => r.status !== 'superseded' && r.status !== 'invalidated');
  const byType = (t: LedgerRecord['type']) => live.filter((r) => r.type === t);

  const openTodos = byType('todo').filter((r) => r.status === 'active' || r.status === 'blocked');
  const queryText = [task.objective, req.focus ?? '', ...openTodos.map((t) => t.content)].join(' ');
  const queryTokens = new Set(tokenize(queryText));

  const candidates: Record<SectionKey, { rec: LedgerRecord; score: number }[]> = {
    objective: [],
    constraints: byType('constraint').map((r) => ({
      rec: r,
      // Severity dominates relevance for constraints: a blocking constraint is
      // relevant whether or not it shares vocabulary with the current step.
      score: r.severity === 'blocking' ? 3 : r.severity === 'important' ? 2 : 1,
    })),
    acceptance_criteria: byType('acceptance_criterion').map((r) => ({
      rec: r,
      score: r.status === 'done' ? 0 : 1, // unmet first
    })),
    todos: openTodos.map((r) => ({ rec: r, score: r.status === 'blocked' ? 1 : 0 })),
    decisions: byType('decision').map((r) => ({
      rec: r,
      score: overlapScore(queryTokens, `${r.content} ${r.rationale ?? ''}`),
    })),
    rejected_approaches: byType('rejected_approach').map((r) => ({ rec: r, score: 1 })),
    open_questions: byType('open_question')
      .filter((r) => r.status === 'active')
      .map((r) => ({ rec: r, score: overlapScore(queryTokens, r.content) })),
    findings: byType('finding').map((r) => ({
      rec: r,
      score: overlapScore(queryTokens, `${r.content} ${r.evidence ?? ''}`) + (r.confidence ?? 0) * 0.01,
    })),
    verification: byType('verification').map((r) => ({ rec: r, score: 0 })),
  };

  // Objective is synthetic (comes from the task row, not a record).
  const objectiveLine = task.objective;

  const sections: Section[] = [];
  let used = objectiveLine.length + 'ORIGINAL OBJECTIVE'.length;
  let exceeded = false;
  let totalOmitted = 0;

  for (const spec of SECTION_SPEC) {
    if (spec.key === 'objective') {
      sections.push({
        key: 'objective',
        title: spec.title,
        items: [],
        omitted: 0,
        mandatory: true,
      });
      continue;
    }

    const ranked = candidates[spec.key]
      .map((c) => ({
        record: c.rec,
        line: renderLine(c.rec),
        score: c.score,
        ordinal: ordinalOf.get(c.rec.id) ?? 0,
      }))
      .sort(cmp);

    const considered = ranked.slice(0, spec.cap);
    let omitted = ranked.length - considered.length;

    const chosen: SelectedItem[] = [];
    for (const item of considered) {
      const cost = item.line.length + 4; // "  - " prefix
      // Mandatory-critical items are never dropped for budget: blocking
      // constraints, unmet acceptance criteria, and rejected approaches.
      const critical =
        (spec.key === 'constraints' && item.record.severity === 'blocking') ||
        (spec.key === 'acceptance_criteria' && item.record.status !== 'done') ||
        spec.key === 'rejected_approaches';

      if (used + cost > budget && !critical) {
        omitted++;
        continue;
      }
      if (used + cost > budget && critical) exceeded = true;
      used += cost;
      chosen.push({ record: item.record, line: item.line, score: item.score });
    }

    // Verification: only the most recent one is useful state.
    const items = spec.key === 'verification' ? chosen.slice(0, 1) : chosen;
    if (spec.key === 'verification' && chosen.length > 1) omitted += chosen.length - 1;

    totalOmitted += omitted;
    sections.push({
      key: spec.key,
      title: spec.title,
      items,
      omitted,
      mandatory: spec.mandatory,
    });
  }

  const fingerprint = fingerprintOf([
    task.id,
    task.objective,
    String(budget),
    req.focus ?? '',
    ...sections.flatMap((s) => [s.key, ...s.items.map((i) => `${i.record.id}:${i.line}`)]),
  ]);

  return {
    task,
    sections,
    budget_chars: budget,
    used_chars: used,
    budget_exceeded: exceeded || used > budget,
    total_omitted: totalOmitted,
    fingerprint,
  };
}
