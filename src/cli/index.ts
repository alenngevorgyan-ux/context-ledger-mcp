#!/usr/bin/env node
/**
 * Context Ledger CLI.
 *
 * Two audiences:
 *  - a reviewer who has five minutes  -> `context-ledger demo`
 *  - an operator inspecting a real ledger -> state / recover / metrics /
 *    events / history / secret-scan
 *
 * The CLI calls the same LedgerService the MCP server calls. There is no
 * demo-only code path; `demo` is a scripted sequence of ordinary operations.
 */
import { LedgerService } from '../service.js';
import { runExperiment, formatExperiment, replaySessionA } from '../experiment/harness.js';
import { RATE_LIMIT_SCENARIO, SCENARIOS } from '../experiment/scenario.js';
import { detectSecrets } from '../redaction/redact.js';
import { LATEST_VERSION, currentVersion } from '../storage/migrations.js';
import { TOOL_NAMES } from '../mcp/tools.js';
import { existsSync } from 'node:fs';

const DEFAULT_DB = process.env['CONTEXT_LEDGER_DB'] ?? '.ledger/ledger.sqlite';

function arg(argv: string[], name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1] !== undefined) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  return fallback;
}
function has(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

const USAGE = `context-ledger — task state that survives context loss

USAGE
  context-ledger <command> [options]

  Global: --db <path>   ledger file (default ${DEFAULT_DB}; env CONTEXT_LEDGER_DB)

COMMANDS
  demo                     End-to-end walkthrough on a throwaway ledger. Start here.
  experiment [--scenario]  Run the session-reset experiment and print measured results.
  serve-info               How to register the MCP server with an agent host.

  tasks                    List tasks in the ledger.
  state    --task <id>     Full recorded state (audit view; includes superseded).
  recover  --task <id>     The bounded reconstruction an agent would receive.
             [--budget n] [--focus "..."]
  history  --record <id>   Supersession chain for one record.
  metrics  [--task <id>]   Derived product metrics, with observability caveats.
  events   [--task <id>]   Raw telemetry event log.
  secret-scan              Re-scan stored content for anything the filter missed.
  doctor                   Environment and schema check.
`;

// `context-ledger events | head` is a normal thing to do, and it closes the
// pipe early. Without this the process dies with an unhandled EPIPE stack trace.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

function out(s: string): void {
  process.stdout.write(`${s}\n`);
}

function open(argv: string[], path?: string): LedgerService {
  return new LedgerService({ path: path ?? arg(argv, 'db', DEFAULT_DB)! });
}

// ------------------------------------------------------------------ demo

function cmdDemo(argv: string[]): void {
  const path = arg(argv, 'db') ?? ':memory:';
  const svc = new LedgerService({ path });
  const S = '  ';
  // Bold only when someone is actually watching a terminal.
  const bold = process.stdout.isTTY && !process.env['NO_COLOR'];
  const step = (n: number, title: string) =>
    out(bold ? `\n\x1b[1m[${n}] ${title}\x1b[0m` : `\n[${n}] ${title}`);

  out('CONTEXT LEDGER — five minute walkthrough');
  out(`ledger: ${path === ':memory:' ? 'in-memory (throwaway)' : path}`);

  step(1, 'Session A starts a task');
  const task = svc.store.createTask({
    objective: 'Add per-API-key rate limiting to the public REST API',
    repo: 'example/api',
    session_id: 'session_a',
  });
  out(`${S}task ${task.id}`);

  step(2, 'It records what it learns — constraints, criteria, a dead end, a decision');
  const ac = svc.store.write({
    task_id: task.id, type: 'acceptance_criterion', session_id: 'session_a', source: 'human',
    content: 'A client over 100 requests/minute for one API key receives HTTP 429',
  });
  svc.store.write({
    task_id: task.id, type: 'constraint', severity: 'blocking', session_id: 'session_a', source: 'human',
    content: 'No new runtime dependencies', evidence: 'CONTRIBUTING.md',
  });
  svc.store.write({
    task_id: task.id, type: 'rejected_approach', session_id: 'session_a',
    content: 'Keep counters in a module-level Map',
    rationale: 'with 4 worker processes the effective limit becomes 4x the configured one',
    evidence: 'load test admitted 400 requests against a limit of 100',
  });
  const decision = svc.store.write({
    task_id: task.id, type: 'decision', session_id: 'session_a', confidence: 0.85,
    content: 'Share counter state through the existing Postgres connection with an atomic UPSERT',
    rationale: 'Redis is the obvious answer but is a new runtime dependency, which is blocked',
  });
  const todo = svc.store.write({
    task_id: task.id, type: 'todo', session_id: 'session_a', content: 'Wire the limiter into the router',
  });
  svc.store.write({
    task_id: task.id, type: 'todo', session_id: 'session_a', content: 'Add an integration test for the 429',
  });
  out(`${S}4 state records + 2 todos written`);

  step(3, 'A secret is pushed at the ledger — and refused entry');
  const leaky = svc.store.write({
    task_id: task.id, type: 'finding', session_id: 'session_a',
    content: 'staging uses AKIAIOSFODNN7EXAMPLE from .env for the metrics upload',
  });
  out(`${S}stored as: ${leaky.content}`);
  out(`${S}redactions applied: ${leaky.redactions}`);

  step(4, 'A decision is reversed — the old one is superseded, never deleted');
  svc.store.write({
    task_id: task.id, type: 'decision', session_id: 'session_a', supersedes: decision.id,
    content: 'Use a fixed 60-second window keyed by (api_key, floor(now/60))',
    rationale: 'the sliding log needed one row per request and blew up table size',
  });
  out(`${S}${decision.id} -> superseded, still queryable via \`history\``);

  step(5, 'Partial progress, then the session ends');
  svc.store.transition(todo.id, 'done', 'session_a');
  svc.store.write({
    task_id: task.id, type: 'verification', session_id: 'session_a', source: 'tool',
    content: 'unit suite green; no end-to-end 429 test exists yet', evidence: 'npm test',
    metadata: { command: 'npm test', passed: true, acceptance_criteria_met: [], constraints_violated: [] },
  });
  out(`${S}--- CONTEXT LOST / SESSION RESET ---`);

  step(6, 'Session B calls ledger_recover_context before touching the repository');
  const { text, selection } = svc.recover({ task_id: task.id, session_id: 'session_b' });
  out(text.split('\n').map((l) => S + l).join('\n'));

  step(7, 'Session B finishes the work and records the verification');
  svc.store.write({
    task_id: task.id, type: 'verification', session_id: 'session_b', source: 'tool',
    content: '429 returned with Retry-After after 100 requests in a rolling minute',
    evidence: 'npm test -- rate-limit',
    metadata: { command: 'npm test -- rate-limit', passed: true, acceptance_criteria_met: [ac.id], constraints_violated: [] },
  });
  svc.store.emit('verification_recorded', {
    task_id: task.id, session_id: 'session_b', payload: { passed: true },
  });
  svc.store.transition(ac.id, 'done', 'session_b', 'met in session B');
  out(`${S}acceptance criterion ${ac.id} -> done`);

  step(8, 'Telemetry — what the ledger can honestly say about that');
  printMetrics(svc, task.id, S);

  out('');
  out(`Reconstruction cost ${selection.used_chars} chars of the ${selection.budget_chars} budgeted.`);
  out('Next: `context-ledger experiment` for the measured session-reset comparison.');
  svc.close();
}

// --------------------------------------------------------------- reports

function printMetrics(svc: LedgerService, taskId: string | undefined, indent = ''): void {
  const report = svc.metrics(taskId);
  out(`${indent}${report.sessions} session(s), ${report.generated_from_events} events`);
  for (const m of report.metrics) {
    const v = m.value === null ? 'n/a' : Number.isInteger(m.value) ? String(m.value) : m.value.toFixed(3);
    const tag = m.observability === 'direct' ? '' : `  <${m.observability.toUpperCase()}>`;
    out(`${indent}  ${m.key.padEnd(36)} ${v.padStart(8)}  (n=${m.n})${tag}`);
  }
  out(`${indent}  note: metrics marked SELF_REPORTED or PARTIAL depend on what the agent chose to`);
  out(`${indent}        record. They are lower bounds, not measured ground truth.`);
}

function cmdState(argv: string[]): void {
  const svc = open(argv);
  const id = arg(argv, 'task');
  if (!id) { out('--task <id> is required'); process.exitCode = 2; svc.close(); return; }
  const st = svc.taskState(id);
  out(`task ${st.task.id}  [${st.task.status}]  ${st.task.repo ?? ''}`);
  out(`objective: ${st.task.objective}`);
  out('');
  for (const r of st.records) {
    const flags = [r.status, r.severity, r.confidence != null ? `conf=${r.confidence}` : null]
      .filter(Boolean).join(' ');
    out(`${r.id}  ${r.type.padEnd(20)} [${flags}]`);
    out(`   ${r.content}`);
    if (r.rationale) out(`   why: ${r.rationale}`);
    if (r.evidence) out(`   evidence: ${r.evidence}`);
    if (r.supersedes) out(`   supersedes: ${r.supersedes}`);
    if (r.redactions) out(`   redactions: ${r.redactions}`);
    out(`   by ${r.source}/${r.session_id} at ${r.created_at}`);
  }
  svc.close();
}

function cmdRecover(argv: string[]): void {
  const svc = open(argv);
  const id = arg(argv, 'task');
  if (!id) { out('--task <id> is required'); process.exitCode = 2; svc.close(); return; }
  const budget = Number(arg(argv, 'budget', '4000'));
  const { text } = svc.recover({
    task_id: id, budget_chars: budget, focus: arg(argv, 'focus') ?? null, session_id: 'cli',
  });
  out(text);
  svc.close();
}

function cmdHistory(argv: string[]): void {
  const svc = open(argv);
  const id = arg(argv, 'record');
  if (!id) { out('--record <id> is required'); process.exitCode = 2; svc.close(); return; }
  for (const r of svc.store.history(id)) {
    out(`${r.created_at}  ${r.id}  [${r.status}]`);
    out(`   ${r.content}`);
    if (r.rationale) out(`   why: ${r.rationale}`);
  }
  svc.close();
}

function cmdTasks(argv: string[]): void {
  const svc = open(argv);
  const tasks = svc.store.listTasks();
  if (tasks.length === 0) out('(no tasks)');
  for (const t of tasks) {
    const n = svc.store.listRecords(t.id).length;
    out(`${t.id}  [${t.status}]  ${String(n).padStart(3)} records  ${t.objective.slice(0, 60)}`);
  }
  svc.close();
}

function cmdEvents(argv: string[]): void {
  const svc = open(argv);
  for (const e of svc.store.listEvents(arg(argv, 'task'))) {
    out(`${e.ts}  ${(e.session_id ?? '-').padEnd(14)} ${e.type.padEnd(30)} ${JSON.stringify(e.payload)}`);
  }
  svc.close();
}

/**
 * Defence in depth: the write-time filter is pattern-based and will miss
 * things. This re-scans everything already stored, so a miss is discoverable
 * rather than permanent and silent.
 */
function cmdSecretScan(argv: string[]): void {
  const svc = open(argv);
  let scanned = 0;
  let hits = 0;
  for (const t of svc.store.listTasks()) {
    for (const field of [['objective', t.objective]] as [string, string][]) {
      scanned++;
      for (const d of detectSecrets(field[1])) {
        hits++;
        out(`HIT task ${t.id} ${field[0]}: ${d.kind}`);
      }
    }
    for (const r of svc.store.listRecords(t.id)) {
      for (const [name, val] of [['content', r.content], ['rationale', r.rationale], ['evidence', r.evidence]] as [string, string | null][]) {
        if (!val) continue;
        scanned++;
        for (const d of detectSecrets(val)) {
          hits++;
          out(`HIT record ${r.id} ${name}: ${d.kind} at ${d.start}`);
        }
      }
    }
  }
  out(`scanned ${scanned} field(s); ${hits} residual detection(s)`);
  if (hits > 0) {
    out('Residual hits mean the write-time filter did not neutralise something. Investigate.');
    process.exitCode = 1;
  }
  svc.close();
}

function cmdDoctor(argv: string[]): void {
  const dbPath = arg(argv, 'db', DEFAULT_DB)!;
  out(`node             ${process.version}`);
  out(`platform         ${process.platform} ${process.arch}`);
  // `require` does not exist in an ES module; probe the builtin properly.
  const sqliteOk = (() => {
    try {
      return Boolean(process.getBuiltinModule?.('node:sqlite'));
    } catch {
      return false;
    }
  })();
  out(`node:sqlite      ${sqliteOk ? 'available' : 'MISSING — Node >= 22.5 is required'}`);
  out(`ledger path      ${dbPath} ${existsSync(dbPath) ? '(exists)' : '(will be created)'}`);
  try {
    const svc = open(argv);
    out(`schema version   ${currentVersion(svc.db)} (latest ${LATEST_VERSION})`);
    out(`tasks            ${svc.store.listTasks().length}`);
    svc.close();
  } catch (e) {
    out(`schema           ERROR: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
  out(`mcp tools        ${TOOL_NAMES.length}`);
}

function cmdServeInfo(): void {
  const abs = process.cwd();
  out('Register the Context Ledger MCP server with an agent host.');
  out('');
  out('Claude Code (project scope):');
  out(`  claude mcp add context-ledger --scope project \\`);
  out(`    --env CONTEXT_LEDGER_DB=.ledger/ledger.sqlite \\`);
  out(`    -- node ${abs}/dist/mcp/server.js`);
  out('');
  out('Generic mcpServers JSON (Codex, and most other hosts):');
  out(JSON.stringify({
    mcpServers: {
      'context-ledger': {
        command: 'node',
        args: [`${abs}/dist/mcp/server.js`],
        env: { CONTEXT_LEDGER_DB: '.ledger/ledger.sqlite', CONTEXT_LEDGER_SECRETS: 'redact' },
      },
    },
  }, null, 2));
  out('');
  out('Environment:');
  out('  CONTEXT_LEDGER_DB       ledger file path');
  out('  CONTEXT_LEDGER_SESSION  session id stamped as provenance (default: generated)');
  out('  CONTEXT_LEDGER_SECRETS  redact (default) | reject | off');
  out('');
  out('Verify without a host:  npm test   (includes protocol-level client/server tests)');
}

function cmdExperiment(argv: string[]): void {
  const name = arg(argv, 'scenario', RATE_LIMIT_SCENARIO.id)!;
  const scenario = SCENARIOS[name];
  if (!scenario) {
    out(`unknown scenario: ${name}. Known: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exitCode = 2;
    return;
  }
  const result = runExperiment({ scenario, budget_chars: Number(arg(argv, 'budget', '4000')) });
  if (has(argv, 'json')) {
    out(JSON.stringify(result, null, 2));
    return;
  }
  out(formatExperiment(result));
  if (has(argv, 'save-ledger')) {
    const path = arg(argv, 'db', '.ledger/experiment.sqlite')!;
    const svc = new LedgerService({ path });
    const { task_id } = replaySessionA(svc, scenario);
    out(`\nSession A ledger written to ${path} as ${task_id}`);
    svc.close();
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  switch (cmd) {
    case 'demo': return cmdDemo(argv);
    case 'experiment': return cmdExperiment(argv);
    case 'serve-info': return cmdServeInfo();
    case 'tasks': return cmdTasks(argv);
    case 'state': return cmdState(argv);
    case 'recover': return cmdRecover(argv);
    case 'history': return cmdHistory(argv);
    case 'metrics': {
      const svc = open(argv);
      printMetrics(svc, arg(argv, 'task'));
      svc.close();
      return;
    }
    case 'events': return cmdEvents(argv);
    case 'secret-scan': return cmdSecretScan(argv);
    case 'doctor': return cmdDoctor(argv);
    case undefined:
    case '-h':
    case '--help':
      out(USAGE);
      return;
    default:
      out(`unknown command: ${cmd}\n`);
      out(USAGE);
      process.exitCode = 2;
  }
}

main();
