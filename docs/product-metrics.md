# Product Metrics

## North Star Metric

> **Assisted Resume Success Rate (ARSR)**
>
> Of task-sessions that *resumed* prior work with the ledger available, the
> share that reached a **passing verification** with **zero recorded-constraint
> violations** and **zero repeated dead ends**.
>
> Unit: one resumed session. Reported weekly, segmented by task length.

Three conjunctive conditions, because each alone is gameable:

- *passing verification* alone rewards trivial or narrowed work;
- *no constraint violation* alone rewards doing nothing;
- *no repeated dead end* alone rewards not exploring.

Together they describe the actual job: **continue correctly after losing
context.**

### Why not the obvious alternatives

| Candidate | Why it fails |
|---|---|
| **Number of MCP calls** | Measures our own presence in the loop. A confused agent calling recovery eleven times scores best. Rises when the product works badly. |
| **Number of stored records** | Directly *anti-correlated* with quality past a point. Over-recording crowds out real state and degrades ranking for everyone. The bad outcome (a ledger full of narration) scores highest. |
| **Tokens stored** | A storage-cost metric wearing a value metric's clothes. We are trying to store *less*. |
| **Conversations / tasks created** | Adoption, not value. Every task initialised and never resumed is pure overhead. |
| **Recovery calls per session** | Utilisation, and we track it — but as a *leading* indicator only. It says the tool was reached for, not that it helped. |
| **Recovery precision/recall vs. a gold set** | Genuinely useful, and it is what `context-ledger experiment` measures. But it scores the *artifact*, not the *outcome*: an agent can be handed perfect context and still ignore it. It is a leading metric, not the North Star. |

The test in `src/test/telemetry.test.ts` asserts that the vanity metrics are
**absent from the implementation**, so they cannot quietly become the number
someone optimises.

### The honest problem with ARSR

Two of its three conditions are **self-reported**. The server never sees the
diff or the test run; it sees what the agent declares in
`ledger_record_verification`. An agent that under-reports its own violations
inflates ARSR.

Consequences, accepted explicitly:

- ARSR is an **upper bound** on true success.
- It is only trustworthy in an **evaluated setting**, where a harness — not the
  agent — grades the outcome. That is precisely what
  `docs/agentdev-experiment.md` specifies.
- In production it is a **trend** metric. A change in ARSR week over week is
  informative; its absolute value is not.

Every metric in `src/telemetry/metrics.ts` carries an `observability` field
(`direct` / `partial` / `self_reported`) for exactly this reason, and a test
asserts that `constraint_violation_rate` stays labelled `self_reported`.

---

## Activation

> **A task is activated when it has been *resumed at least once with recovery*
> and that resumed session subsequently wrote at least one record.**

Not "installed the server". Not "initialised a task". Not "recorded something".
The product's value proposition is exercised only at the moment a session that
lost context regains it and keeps working. Everything before that is setup.

This is a deliberately harsh definition: a user who installs the server, records
diligently for a week, and never has a session reset is **not activated**, and
should not count as one — they have paid the cost and received nothing.

**Time-to-activation** is the number that matters for onboarding, and it is
bounded below by how long a real task runs before it hits a context boundary.

## Retention

> **Week-N retention: the share of repositories with ≥ 1 activation in week 0
> that have ≥ 1 activation in week N.**

Repository-level, not user-level: the ledger is per-repository state, and a user
moving between projects is not churn.

Retention is the metric most likely to expose R1 ("agents don't record"). A
repository where recording decays produces empty reconstructions, delivers no
value on resume, and stops being resumed with the ledger. Recording decay shows
up here before it shows up anywhere else.

## Leading indicators

Movement here precedes movement in ARSR.

| Metric | Definition | Observability | Read it as |
|---|---|---|---|
| `context_recovery_utilization` | recoveries / distinct sessions | direct | Is the tool being reached for at all? A session that never recovers gets zero value. |
| **Recording coverage** | share of sessions writing ≥ 1 decision or rejected approach | direct | The supply side. Recovery quality is capped by this. |
| **Context sufficiency** | probe satisfaction of the reconstruction on the benchmark scenario | direct (offline) | Quality of the artifact. Currently **93.8% overall / 100% critical** vs **18.8% / 0%** baseline. |
| `recovery_to_action_latency_p50_ms` | recovery → next state-changing call | direct | How fast the agent became productive. Confounded by task difficulty. |
| Reconstruction size p95 | chars | direct | Context spend. Must stay ≤ 4 KB. |

## Lagging indicators

| Metric | Definition | Observability |
|---|---|---|
| **ARSR** (North Star) | see above | self_reported in prod, direct in eval |
| `repeated_failed_approach_rate` | near-duplicate rejected approaches within a task (Jaccard ≥ 0.8) | partial — only sees dead ends the agent recorded |
| `duplicate_exploration_rate` | near-duplicate findings | partial |
| `successful_resume_rate` | resumed sessions reaching a passing verification | self_reported |
| **Human interventions per task** | not instrumented; requires host cooperation | — |

`partial` is doing real work in that table: a dead end the agent repeats
*without recording* is invisible to us. `repeated_failed_approach_rate` is
therefore a **lower bound**, and improving it by recording less would look like
a win. It must never be read alone.

## Guardrails

| Guardrail | Trigger | Response |
|---|---|---|
| `redacted_record_rate` | sustained > 0 | Incident. Agents are pushing credentials at the ledger. |
| Records per task | p95 > 60 | Over-recording. Tighten tool descriptions. |
| `decision_supersession_rate` | > 0.4 | The ledger is a scratchpad, not a commitment log. |
| `duplicate_exploration_rate` | > 0.2 | The ledger is accumulating restatements of itself. |
| Recovery latency p95 | > 50 ms | It runs at the top of every resumed session. |
| Reconstruction size p95 | > 4 KB | Context spend is escaping. |
| Tasks initialised but never resumed | > 60% | Pure overhead for those users; the product may be aimed at the wrong task length. |

---

## The A/B experiment

**Question.** Does Context Ledger improve long-horizon coding-agent work?

**Unit of randomisation: the repository.** Not the session — a session is not
independent of the sessions before it in the same repo, because the ledger
carries state across them. Not the user — users work across repos and would
contaminate arms.

**Arms.**
- **A (control)** — agent as-is. Host-native compaction and repository state.
- **B (treatment)** — same agent, Context Ledger MCP server installed, server
  instructions active.

A third arm is worth running if budget allows, because it separates *the
mechanism* from *the nudge*:
- **C (placebo/prompt-only)** — no ledger, but the agent is instructed to write
  its constraints, decisions and dead ends into a plain markdown file and read
  it at session start. If B does not beat C, the value is in the discipline, not
  in the tool, and the correct product is a prompt.

**Population.** Repositories whose tasks routinely exceed one context window.
Screening criterion: median task spans ≥ 2 sessions. Short-task repos are
excluded — the product is overhead there, and including them adds noise, not
generality.

**Primary metric.** ARSR, graded by harness, not self-report.

**Secondary.** Constraint violations per completed task (graded from the diff);
repeated dead ends per task (graded from the transcript); wall-clock to first
useful edit after a resume; total tokens per completed task.

**Guardrails.** Tokens per completed task must not rise more than 10%; p95
recovery latency ≤ 50 ms; zero credential leaks into a ledger file.

**Sizing.** With a baseline ARSR of 0.5 and a target of +10 points (0.5 → 0.6)
at α = 0.05 and 80% power, a two-proportion test needs ≈ 390 resumed sessions
per arm. At an assumed 5 resumed sessions per repository per week, that is
≈ 78 repository-weeks per arm — call it **80 repositories per arm for four
weeks**, and pre-register that duration rather than peeking. If the true effect
is smaller than 10 points, this experiment is not powered to find it, and the
correct conclusion is "underpowered", not "no effect".

**Analysis.** Intention-to-treat on all randomised repos, including B-arm repos
whose agents never recorded anything — dropping them would measure the product
under conditions that do not exist in the field.

**Pre-registered failure conditions.** Any of these means the hypothesis loses:

1. ARSR difference < 2 points.
2. B-arm tokens per completed task up more than 10%.
3. Recording coverage in the B arm below 30% of sessions — R1 confirmed, and the
   tool cannot work as designed.
4. B does not beat C. The value is the discipline; ship the prompt, not the
   server.

**Ethics / safety.** Ledger files stay on the user's machine; only aggregate
counters leave. No record content is transmitted. Users in either arm can
inspect and delete their ledger at any time.
