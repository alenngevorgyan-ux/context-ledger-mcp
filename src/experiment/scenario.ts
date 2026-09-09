/**
 * Reproducible session-reset scenario.
 *
 * A scenario is a *script*, not a recording: it declares what happened in
 * Session A, what a fresh Session B would see without the ledger, and — the
 * part that makes measurement possible — an explicit list of the state items
 * Session B must have in order to continue correctly.
 *
 * The knowledge probes are the contract. Each one is a fact that Session A
 * established and Session B needs. A probe is satisfied by a resume context if
 * that context contains the fact, checked by a deterministic matcher. Nothing
 * here consults a model, so the scenario measures the *artifact* (the resume
 * context), which is exactly the thing this project builds.
 */

export type Criticality = 'critical' | 'important' | 'useful';

export interface KnowledgeProbe {
  id: string;
  /** What Session B needs to know. Phrased as the question it answers. */
  question: string;
  criticality: Criticality;
  /**
   * Deterministic matcher. Every group must be satisfied; a group is satisfied
   * if ANY of its alternatives appears (case-insensitive) in the context.
   * Written as AND-of-ORs so a probe can accept paraphrase without accepting
   * an accidental keyword hit.
   */
  requires: string[][];
  /** What goes wrong in Session B if this is missing. */
  failure_if_missing: string;
}

export interface SessionAStep {
  kind:
    | 'constraint'
    | 'acceptance_criterion'
    | 'decision'
    | 'rejected_approach'
    | 'finding'
    | 'todo'
    | 'todo_complete'
    | 'open_question'
    | 'verification';
  /** The record content. Omitted only for `todo_complete`, which references
   *  an existing todo by `target`. */
  text?: string;
  rationale?: string;
  evidence?: string;
  severity?: 'blocking' | 'important' | 'advisory';
  confidence?: number;
  passed?: boolean;
  /** For todo_complete: the text of the todo being completed. */
  target?: string;
}

export interface Scenario {
  id: string;
  title: string;
  objective: string;
  repo: string;
  /**
   * What a fresh Session B can see WITHOUT the ledger: the ticket, plus
   * whatever the repository itself carries forward (code comments, README,
   * commit messages, test names). This is the honest baseline — not an empty
   * string. Understating the baseline would manufacture a win.
   */
  baseline_context: string;
  session_a: SessionAStep[];
  probes: KnowledgeProbe[];
}

export const RATE_LIMIT_SCENARIO: Scenario = {
  id: 'rate-limit-resume',
  title: 'Per-API-key rate limiting, resumed after a session reset',
  objective:
    'Add per-API-key rate limiting to the public REST API so that abusive clients cannot ' +
    'degrade service for everyone else.',
  repo: 'example/api',

  // Deliberately generous: this is everything a competent fresh agent could
  // pick up from the ticket and from the repository as Session A left it.
  baseline_context: [
    'TICKET API-4127: Add per-API-key rate limiting to the public REST API so that abusive',
    'clients cannot degrade service for everyone else.',
    '',
    'Repository state visible to a fresh session:',
    '  README.md      — "example/api is a Node service. Run tests with `npm test`."',
    '  CONTRIBUTING.md— "Open a PR against main. Keep the CI green."',
    '  src/app.ts     — express app setup, middleware registration',
    '  src/routes/    — route handlers',
    '  src/limiter.ts — NEW, uncommitted, partial:',
    '      // TODO: wire into the router',
    '      export function createLimiter(opts) { /* counter map, partial */ }',
    '  git log -1     — "wip: start rate limiter"',
    '  npm test       — passes (no rate limiter tests exist yet)',
  ].join('\n'),

  session_a: [
    {
      kind: 'constraint',
      text: 'No new runtime dependencies may be added to the service',
      severity: 'blocking',
      evidence: 'CONTRIBUTING.md line 12, confirmed by the tech lead in the ticket thread',
    },
    {
      kind: 'constraint',
      text: 'The service runs 4 worker processes behind a load balancer; limiter state must be correct across all of them',
      severity: 'blocking',
      evidence: 'deploy/ecs-task.json sets desired count 4',
    },
    {
      kind: 'constraint',
      text: 'Must not add more than 5ms to p99 request latency',
      severity: 'important',
      evidence: 'SLO doc',
    },
    {
      kind: 'acceptance_criterion',
      text: 'A client exceeding 100 requests per minute for one API key receives HTTP 429 with a Retry-After header',
    },
    {
      kind: 'acceptance_criterion',
      text: 'Limits are enforced per API key, not per source IP',
    },
    {
      kind: 'finding',
      text: 'The API key is resolved by the auth middleware in src/app.ts:41, and is attached as req.apiKey; anything registered after that line can read it',
      evidence: 'src/app.ts:41',
      confidence: 0.95,
    },
    {
      kind: 'rejected_approach',
      text: 'Enforce the limit at the edge in nginx using limit_req',
      rationale:
        'nginx terminates TLS before the Authorization header is parsed by the app, so it can key only on source IP; that violates the per-API-key acceptance criterion, and NAT-ed customers would be limited collectively',
      evidence: 'tried it in deploy/nginx.conf, per-key zone had no usable key variable',
    },
    {
      kind: 'rejected_approach',
      text: 'Keep the counters in a module-level Map in the Node process',
      rationale:
        'with 4 worker processes each holding its own Map, the effective limit becomes 4x the configured one; a 100/min limit let 400 requests through in the load test',
      evidence: 'load test: 400 requests admitted against a configured limit of 100',
    },
    {
      kind: 'decision',
      text: 'Implement the limiter in-process but share state across workers via the existing Postgres connection, using an atomic UPSERT on a counters table',
      rationale:
        'Redis is the obvious choice but would be a new runtime dependency, which is blocked. Postgres is already a dependency, and an atomic UPSERT with a windowed key is correct across all 4 workers. Measured cost was 1.8ms p99, inside the 5ms budget.',
      confidence: 0.85,
      evidence: 'benchmark in scripts/bench-limiter.ts: +1.8ms p99',
    },
    {
      kind: 'decision',
      text: 'Use a fixed 60-second window keyed by (api_key, floor(now/60)) rather than a sliding window log',
      rationale:
        'a sliding log needs one row per request and blew up table size in the benchmark; a fixed window admits at most a 2x boundary burst, which the tech lead accepted as a tradeoff for this ticket',
      confidence: 0.7,
    },
    {
      kind: 'finding',
      text: 'The counters table migration must go in migrations/ and CI runs migrations before tests; a test added without the migration fails with relation "rate_limit_counters" does not exist',
      evidence: '.github/workflows/ci.yml step "db:migrate"',
      confidence: 0.9,
    },
    { kind: 'todo', text: 'Add the rate_limit_counters migration' },
    { kind: 'todo', text: 'Wire createLimiter into the router after the auth middleware in src/app.ts' },
    { kind: 'todo', text: 'Add an integration test asserting 429 and Retry-After after 100 requests' },
    { kind: 'todo_complete', target: 'Add the rate_limit_counters migration' },
    {
      kind: 'open_question',
      text: 'Should internal service-to-service tokens be exempt from the limit, or limited at a higher threshold?',
    },
    {
      kind: 'verification',
      text: 'Unit tests pass; the limiter module is correct in isolation but is not yet wired into the router, so no end-to-end 429 exists',
      evidence: 'npm test',
      passed: true,
    },
  ],

  probes: [
    {
      id: 'no-new-deps',
      question: 'Is the agent allowed to add Redis (or any new runtime dependency)?',
      criticality: 'critical',
      requires: [['no new runtime dependencies', 'no new runtime dependency']],
      failure_if_missing:
        'Session B reaches for Redis, the canonical rate-limiting answer, and the PR is rejected.',
    },
    {
      id: 'multi-worker',
      question: 'Must limiter state be shared across processes?',
      criticality: 'critical',
      requires: [['4 worker', 'across all of them', 'worker processes']],
      failure_if_missing:
        'Session B ships an in-process counter that silently allows 4x the configured limit.',
    },
    {
      id: 'per-key-not-ip',
      question: 'Is the limit keyed on the API key or the source IP?',
      criticality: 'critical',
      requires: [['per api key', 'per-api-key', 'per API key'], ['not per source ip', 'not per-source-ip', 'not per source IP']],
      failure_if_missing: 'Session B implements IP-based limiting and misses the acceptance criterion.',
    },
    {
      id: 'rejected-nginx',
      question: 'Was edge enforcement in nginx already tried and rejected?',
      criticality: 'critical',
      requires: [['nginx'], ['limit_req', 'source ip', 'source IP']],
      failure_if_missing:
        'Session B spends a cycle re-implementing and re-discarding the nginx approach.',
    },
    {
      id: 'rejected-inprocess-map',
      question: 'Was a module-level Map of counters already tried and rejected?',
      criticality: 'critical',
      requires: [['map', 'in-process', 'module-level'], ['4x', '400 requests', 'each holding its own']],
      failure_if_missing:
        'Session B re-implements the exact bug that Session A already found in a load test.',
    },
    {
      id: 'chosen-postgres',
      question: 'What storage was chosen for the counters, and why?',
      criticality: 'critical',
      requires: [['postgres'], ['upsert', 'already a dependency', 'atomic']],
      failure_if_missing:
        'Session B re-litigates a settled architectural decision, or contradicts it.',
    },
    {
      id: 'window-strategy',
      question: 'Fixed window or sliding log, and was the burst tradeoff accepted?',
      criticality: 'important',
      requires: [['fixed', '60-second', 'fixed window'], ['sliding', '2x', 'burst']],
      failure_if_missing:
        'Session B switches to a sliding window, reversing an accepted tradeoff without knowing it was accepted.',
    },
    {
      id: 'auth-middleware-location',
      question: 'Where is the API key available in the request pipeline?',
      criticality: 'important',
      requires: [['src/app.ts:41', 'src/app.ts', 'auth middleware']],
      failure_if_missing:
        'Session B re-reads the middleware chain to rediscover where req.apiKey is set.',
    },
    {
      id: 'ci-migration-order',
      question: 'What does the test setup require before an integration test can pass?',
      criticality: 'important',
      requires: [['migration'], ['ci', 'db:migrate', 'before tests']],
      failure_if_missing:
        'Session B writes the integration test, hits a confusing missing-relation error, and debugs CI.',
    },
    {
      id: 'remaining-plan',
      question: 'What work is left, and what is already done?',
      criticality: 'critical',
      requires: [['wire', 'router'], ['integration test', '429']],
      failure_if_missing:
        'Session B re-derives the plan, and may redo the migration that Session A already completed.',
    },
    {
      id: 'migration-already-done',
      question: 'Is the counters migration already written?',
      criticality: 'important',
      requires: [['migration']],
      failure_if_missing: 'Session B writes a duplicate migration.',
    },
    {
      id: 'open-question-exemption',
      question: 'Is there an unresolved question blocking a design choice?',
      criticality: 'useful',
      requires: [['internal service', 'exempt']],
      failure_if_missing:
        'Session B silently picks an answer to a question that was escalated to a human.',
    },
    {
      id: 'latency-budget',
      question: 'Is there a latency budget the implementation must respect?',
      criticality: 'important',
      requires: [['5ms', '5 ms'], ['p99', 'latency']],
      failure_if_missing: 'Session B ships a per-request extra query with no awareness of the SLO.',
    },
    {
      id: 'last-verification',
      question: 'What was the last known verification state?',
      criticality: 'useful',
      requires: [['npm test', 'unit test'], ['not yet wired', 'pass']],
      failure_if_missing: 'Session B does not know whether the tree was green when it stopped.',
    },
    {
      id: 'retry-after-value',
      question: 'What exact Retry-After value should the 429 response carry?',
      criticality: 'important',
      requires: [['retry-after'], ['seconds until', 'remainder of the window', 'exact value']],
      failure_if_missing:
        'Session B guesses a Retry-After value. NOTE: Session A never established this, so no ' +
        'condition can supply it. This probe exists to prove the ledger does not invent knowledge.',
    },
    {
      id: 'partial-impl-location',
      question: 'Which file holds the partial implementation from Session A?',
      criticality: 'important',
      requires: [['src/limiter.ts']],
      failure_if_missing:
        'Session B writes a second limiter module. NOTE: this fact lives in the repository, not ' +
        'the ledger. It exists to prove the ledger is a supplement to the repo, not a replacement.',
    },
  ],
};

export const SCENARIOS: Record<string, Scenario> = {
  [RATE_LIMIT_SCENARIO.id]: RATE_LIMIT_SCENARIO,
};
