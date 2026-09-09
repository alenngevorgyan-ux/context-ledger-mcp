/**
 * MCP tool surface.
 *
 * Sizing rationale (see ARCHITECTURE.md "Tool surface"):
 * The temptation is one generic `ledger_write(type, content)`. Rejected: the
 * tool name and its required arguments are the only prompt the agent reliably
 * reads. `ledger_record_decision` with a REQUIRED `rationale` field changes
 * agent behaviour in a way `ledger_write` does not. The cost is ten tools
 * instead of one; the benefit is that the schema does the teaching.
 *
 * Rejected alternative also worth naming: separate tools per verb per type
 * (add/update/complete/cancel x 8 types = ~32 tools). That is the "ten
 * variations of save note" failure. Lifecycle changes go through one `op`
 * enum on the owning tool instead.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LedgerService } from '../service.js';
import { LedgerError, type LedgerRecord } from '../domain/types.js';
import { DEFAULT_BUDGET } from '../recovery/select.js';

export interface ToolContext {
  service: LedgerService;
  /** Identifies the agent session; stamped as provenance on every write. */
  sessionId: string;
}

const severity = z.enum(['blocking', 'important', 'advisory']);

function recordSummary(r: LedgerRecord) {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    redactions: r.redactions,
    created_at: r.created_at,
  };
}

type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Errors are returned as tool errors with a stable machine-readable `code`,
 * not thrown. An agent that gets a protocol-level exception has no way to
 * recover; an agent that gets `{code: "invalid_supersession"}` does.
 */
function ok(text: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function wrap(fn: () => ToolResult): ToolResult {
  try {
    return fn();
  } catch (err) {
    const code = err instanceof LedgerError ? err.code : 'internal_error';
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `ledger error [${code}]: ${message}` }],
      structuredContent: { ok: false, code, message },
      isError: true,
    };
  }
}

const RECORD_ACK = z.object({
  ok: z.boolean(),
  record: z
    .object({
      id: z.string(),
      type: z.string(),
      status: z.string(),
      redactions: z.number(),
      created_at: z.string(),
    })
    .optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const { service, sessionId } = ctx;
  const store = service.store;

  // ---------------------------------------------------------------- 1
  server.registerTool(
    'ledger_init_task',
    {
      title: 'Initialise a task in the Context Ledger',
      description:
        'Start tracking a coding task. Call this ONCE at the beginning of a task, before ' +
        'exploring the repository. Returns a task_id required by every other ledger tool. ' +
        'Record the objective verbatim as the user stated it — do not paraphrase it, because ' +
        'this text is what a future session will resume from.',
      inputSchema: {
        objective: z.string().min(1).describe('The task objective, verbatim from the requester.'),
        repo: z.string().optional().describe('Repository path or URL, if applicable.'),
        acceptance_criteria: z
          .array(z.string().min(1))
          .optional()
          .describe('Testable conditions that define "done". Prefer verifiable statements.'),
        constraints: z
          .array(
            z.object({
              text: z.string().min(1),
              severity: severity.default('important'),
              source: z.string().optional().describe('Where this constraint came from.'),
            }),
          )
          .optional()
          .describe('Known constraints at task start (stack, compatibility, policy, deadlines).'),
      },
      outputSchema: {
        ok: z.boolean(),
        task_id: z.string().optional(),
        acceptance_criteria: z.number().optional(),
        constraints: z.number().optional(),
        code: z.string().optional(),
        message: z.string().optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      wrap(() => {
        const task = store.createTask({
          objective: args.objective,
          repo: args.repo ?? null,
          session_id: sessionId,
        });
        for (const ac of args.acceptance_criteria ?? []) {
          store.write({
            task_id: task.id,
            type: 'acceptance_criterion',
            content: ac,
            session_id: sessionId,
            source: 'human',
          });
        }
        for (const c of args.constraints ?? []) {
          store.write({
            task_id: task.id,
            type: 'constraint',
            content: c.text,
            severity: c.severity,
            evidence: c.source ?? null,
            session_id: sessionId,
            source: 'human',
          });
        }
        return ok(
          `task ${task.id} initialised with ${args.acceptance_criteria?.length ?? 0} acceptance ` +
            `criteria and ${args.constraints?.length ?? 0} constraints`,
          {
            ok: true,
            task_id: task.id,
            acceptance_criteria: args.acceptance_criteria?.length ?? 0,
            constraints: args.constraints?.length ?? 0,
          },
        );
      }),
  );

  // ---------------------------------------------------------------- 2
  server.registerTool(
    'ledger_record_constraint',
    {
      title: 'Record a constraint or acceptance criterion',
      description:
        'Record a requirement discovered during the task that a future session must still ' +
        'respect — e.g. "must stay compatible with Node 18", "do not add runtime dependencies". ' +
        'Use kind="acceptance_criterion" for testable definitions of done. ' +
        'Use `supersedes` when a requirement is replaced; the old one stays auditable.',
      inputSchema: {
        task_id: z.string(),
        kind: z.enum(['constraint', 'acceptance_criterion']).default('constraint'),
        text: z.string().min(1),
        severity: severity.default('important').describe('blocking constraints are never dropped from recovery output.'),
        source: z.string().optional().describe('Evidence: file path, ticket, or who said it.'),
        supersedes: z.string().optional().describe('Record id this replaces.'),
      },
      outputSchema: RECORD_ACK.shape,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      wrap(() => {
        const rec = store.write({
          task_id: args.task_id,
          type: args.kind,
          content: args.text,
          severity: args.kind === 'constraint' ? args.severity : null,
          evidence: args.source ?? null,
          supersedes: args.supersedes ?? null,
          session_id: sessionId,
        });
        return ok(`recorded ${args.kind} ${rec.id}`, { ok: true, record: recordSummary(rec) });
      }),
  );

  // ---------------------------------------------------------------- 3
  server.registerTool(
    'ledger_record_decision',
    {
      title: 'Record an architectural or implementation decision',
      description:
        'Record a decision that shapes the implementation, together with WHY. A rationale is ' +
        'required — a decision without one cannot be re-evaluated later and will simply be ' +
        'contradicted by a future session. If this reverses an earlier decision, pass ' +
        '`supersedes`: the earlier decision is retained and marked superseded, never deleted.',
      inputSchema: {
        task_id: z.string(),
        decision: z.string().min(1).describe('What was decided, stated as a commitment.'),
        rationale: z.string().min(1).describe('Why. Include the alternative that lost and why.'),
        alternatives_considered: z.array(z.string()).optional(),
        confidence: z.number().min(0).max(1).optional(),
        evidence: z.string().optional(),
        supersedes: z.string().optional(),
      },
      outputSchema: RECORD_ACK.shape,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      wrap(() => {
        const rec = store.write({
          task_id: args.task_id,
          type: 'decision',
          content: args.decision,
          rationale: args.rationale,
          confidence: args.confidence ?? null,
          evidence: args.evidence ?? null,
          supersedes: args.supersedes ?? null,
          session_id: sessionId,
          metadata: { alternatives_considered: args.alternatives_considered ?? [] },
        });
        return ok(`recorded decision ${rec.id}`, { ok: true, record: recordSummary(rec) });
      }),
  );

  // ---------------------------------------------------------------- 4
  server.registerTool(
    'ledger_record_rejected_approach',
    {
      title: 'Record an approach that was tried and rejected',
      description:
        'Record something you attempted that did NOT work, and why. This is the highest-value ' +
        'record type: without it, a resumed session re-attempts the same dead end. Include the ' +
        'concrete failure signal (error text, failing test, benchmark number) as evidence. ' +
        'Rejected approaches are never dropped from recovery output.',
      inputSchema: {
        task_id: z.string(),
        approach: z.string().min(1).describe('What was attempted, specifically enough to recognise a repeat.'),
        reason: z.string().min(1).describe('Why it failed or was abandoned.'),
        evidence: z.string().optional().describe('Error message, failing command, or measurement.'),
        supersedes: z.string().optional(),
      },
      outputSchema: RECORD_ACK.shape,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      wrap(() => {
        const rec = store.write({
          task_id: args.task_id,
          type: 'rejected_approach',
          content: args.approach,
          rationale: args.reason,
          evidence: args.evidence ?? null,
          supersedes: args.supersedes ?? null,
          session_id: sessionId,
        });
        return ok(`recorded rejected approach ${rec.id}`, { ok: true, record: recordSummary(rec) });
      }),
  );

  // ---------------------------------------------------------------- 5
  server.registerTool(
    'ledger_record_finding',
    {
      title: 'Record a durable finding about the codebase',
      description:
        'Record something learned about the repository that was expensive to discover and will ' +
        'matter later — e.g. "auth middleware is registered in src/app.ts:41, not in routes". ' +
        'Do NOT record transient narration or step-by-step progress; the ledger is task state, ' +
        'not a transcript. Findings are ranked by relevance during recovery, so keep them ' +
        'self-contained and specific.',
      inputSchema: {
        task_id: z.string(),
        finding: z.string().min(1),
        evidence: z.string().optional().describe('file:line, command output, or doc URL.'),
        confidence: z.number().min(0).max(1).optional(),
        supersedes: z.string().optional(),
      },
      outputSchema: RECORD_ACK.shape,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      wrap(() => {
        const rec = store.write({
          task_id: args.task_id,
          type: 'finding',
          content: args.finding,
          evidence: args.evidence ?? null,
          confidence: args.confidence ?? null,
          supersedes: args.supersedes ?? null,
          session_id: sessionId,
        });
        return ok(`recorded finding ${rec.id}`, { ok: true, record: recordSummary(rec) });
      }),
  );

  // ---------------------------------------------------------------- 6
  server.registerTool(
    'ledger_open_question',
    {
      title: 'Raise or resolve an open question',
      description:
        'Track a question that blocks or shapes the work and that you could not answer ' +
        '(typically needing a human). Resolve it with op="resolve" and the answer, so a future ' +
        'session does not re-ask. Unresolved questions appear in every recovery.',
      inputSchema: {
        task_id: z.string(),
        op: z.enum(['ask', 'resolve']),
        question: z.string().optional().describe('Required for op="ask".'),
        question_id: z.string().optional().describe('Required for op="resolve".'),
        answer: z.string().optional().describe('Required for op="resolve".'),
      },
      outputSchema: RECORD_ACK.shape,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      wrap(() => {
        if (args.op === 'ask') {
          if (!args.question) throw new LedgerError('question is required for op="ask"', 'invalid_record');
          const rec = store.write({
            task_id: args.task_id,
            type: 'open_question',
            content: args.question,
            session_id: sessionId,
          });
          return ok(`opened question ${rec.id}`, { ok: true, record: recordSummary(rec) });
        }
        if (!args.question_id || !args.answer) {
          throw new LedgerError('question_id and answer are required for op="resolve"', 'invalid_record');
        }
        const rec = store.transition(args.question_id, 'resolved', sessionId, args.answer);
        // The answer itself becomes a finding, so it survives into recovery.
        store.write({
          task_id: rec.task_id,
          type: 'finding',
          content: `Answer to "${rec.content}": ${args.answer}`,
          evidence: `resolves ${rec.id}`,
          session_id: sessionId,
          source: 'human',
          confidence: 0.9,
        });
        return ok(`resolved question ${rec.id}`, { ok: true, record: recordSummary(rec) });
      }),
  );

  // ---------------------------------------------------------------- 7
  server.registerTool(
    'ledger_update_todo',
    {
      title: 'Add or advance a todo',
      description:
        'Maintain the remaining plan. op="add" creates a step; op="complete"/"block" advance an ' +
        'existing one. Remaining todos are what a resumed session uses as its next action, so ' +
        'keep them actionable and close them as you finish them.',
      inputSchema: {
        task_id: z.string(),
        op: z.enum(['add', 'complete', 'block']),
        text: z.string().optional().describe('Required for op="add".'),
        todo_id: z.string().optional().describe('Required for op="complete" or "block".'),
        note: z.string().optional().describe('For "block": what is blocking it.'),
      },
      outputSchema: RECORD_ACK.shape,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      wrap(() => {
        if (args.op === 'add') {
          if (!args.text) throw new LedgerError('text is required for op="add"', 'invalid_record');
          const rec = store.write({
            task_id: args.task_id,
            type: 'todo',
            content: args.text,
            session_id: sessionId,
          });
          return ok(`added todo ${rec.id}`, { ok: true, record: recordSummary(rec) });
        }
        if (!args.todo_id) throw new LedgerError('todo_id is required', 'invalid_record');
        const rec = store.transition(
          args.todo_id,
          args.op === 'complete' ? 'done' : 'blocked',
          sessionId,
          args.note ?? undefined,
        );
        return ok(`todo ${rec.id} -> ${rec.status}`, { ok: true, record: recordSummary(rec) });
      }),
  );

  // ---------------------------------------------------------------- 8
  server.registerTool(
    'ledger_record_verification',
    {
      title: 'Record the result of a verification run',
      description:
        'Record the outcome of actually running something (tests, build, lint, manual check). ' +
        'Include the exact command so a future session can re-run it. Declare which acceptance ' +
        'criteria this run satisfied and which constraints it violated — these declarations are ' +
        'the only signal the ledger has about correctness, and they are reported as ' +
        'SELF-REPORTED in metrics.',
      inputSchema: {
        task_id: z.string(),
        command: z.string().min(1).describe('Exact command that was run.'),
        passed: z.boolean(),
        summary: z.string().min(1).describe('One line: what the run showed.'),
        acceptance_criteria_met: z.array(z.string()).optional().describe('Record ids now satisfied.'),
        constraints_violated: z.array(z.string()).optional().describe('Record ids this run violates.'),
      },
      outputSchema: RECORD_ACK.shape,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      wrap(() => {
        const rec = store.write({
          task_id: args.task_id,
          type: 'verification',
          content: args.summary,
          evidence: args.command,
          session_id: sessionId,
          source: 'tool',
          metadata: {
            command: args.command,
            passed: args.passed,
            acceptance_criteria_met: args.acceptance_criteria_met ?? [],
            constraints_violated: args.constraints_violated ?? [],
          },
        });
        // Advance the acceptance criteria the agent claims are now met.
        for (const acId of args.acceptance_criteria_met ?? []) {
          const ac = store.getRecord(acId);
          if (ac && ac.task_id === args.task_id && ac.type === 'acceptance_criterion' && ac.status === 'active') {
            store.transition(acId, 'done', sessionId, `met by ${rec.id}`);
          }
        }
        store.emit('verification_recorded', {
          task_id: args.task_id,
          session_id: sessionId,
          payload: { passed: args.passed, record_id: rec.id, command: args.command },
        });
        return ok(
          `recorded verification ${rec.id} (${args.passed ? 'PASS' : 'FAIL'})`,
          { ok: true, record: recordSummary(rec) },
        );
      }),
  );

  // ---------------------------------------------------------------- 9
  server.registerTool(
    'ledger_recover_context',
    {
      title: 'Reconstruct task state after a context reset',
      description:
        'THE PRIMARY TOOL. Call this at the start of every session that continues existing work, ' +
        'and after any context compaction, BEFORE reading files. Returns a bounded, ordered ' +
        'reconstruction: objective, active constraints, acceptance criteria, remaining plan, ' +
        'decisions with rationale, approaches already rejected, open questions, relevant ' +
        'findings, and the last verification state. Output is deterministic for a given ledger ' +
        'state. Pass `focus` to bias finding selection toward what you are about to do.',
      inputSchema: {
        task_id: z.string(),
        budget_chars: z
          .number()
          .int()
          .min(200)
          .max(20000)
          .optional()
          .describe(`Character budget for the reconstruction. Default ${DEFAULT_BUDGET}.`),
        focus: z.string().optional().describe('What you are about to work on.'),
      },
      outputSchema: {
        ok: z.boolean(),
        task_id: z.string().optional(),
        used_chars: z.number().optional(),
        budget_chars: z.number().optional(),
        omitted: z.number().optional(),
        budget_exceeded: z.boolean().optional(),
        fingerprint: z.string().optional(),
        code: z.string().optional(),
        message: z.string().optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      wrap(() => {
        const { selection, text } = service.recover({
          task_id: args.task_id,
          budget_chars: args.budget_chars ?? DEFAULT_BUDGET,
          focus: args.focus ?? null,
          session_id: sessionId,
        });
        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: {
            ok: true,
            task_id: selection.task.id,
            used_chars: selection.used_chars,
            budget_chars: selection.budget_chars,
            omitted: selection.total_omitted,
            budget_exceeded: selection.budget_exceeded,
            fingerprint: selection.fingerprint,
          },
        };
      }),
  );

  // ---------------------------------------------------------------- 10
  server.registerTool(
    'ledger_get_task_state',
    {
      title: 'Inspect full recorded task state',
      description:
        'Unbounded, unranked dump of every record for a task, including superseded ones. This is ' +
        'a debugging and audit tool. For resuming work use ledger_recover_context instead — this ' +
        'output is not budgeted and will waste context.',
      inputSchema: {
        task_id: z.string(),
        include_superseded: z.boolean().default(false),
      },
      outputSchema: {
        ok: z.boolean(),
        task: z.record(z.unknown()).optional(),
        counts: z.record(z.number()).optional(),
        records: z.array(z.record(z.unknown())).optional(),
        code: z.string().optional(),
        message: z.string().optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      wrap(() => {
        const state = service.taskState(args.task_id);
        const records = args.include_superseded
          ? state.records
          : state.records.filter((r) => r.status !== 'superseded');
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ task: state.task, counts: state.counts, records }, null, 2),
            },
          ],
          structuredContent: {
            ok: true,
            task: state.task as unknown as Record<string, unknown>,
            counts: state.counts,
            records: records as unknown as Record<string, unknown>[],
          },
        };
      }),
  );
}

export const TOOL_NAMES = [
  'ledger_init_task',
  'ledger_record_constraint',
  'ledger_record_decision',
  'ledger_record_rejected_approach',
  'ledger_record_finding',
  'ledger_open_question',
  'ledger_update_todo',
  'ledger_record_verification',
  'ledger_recover_context',
  'ledger_get_task_state',
] as const;
