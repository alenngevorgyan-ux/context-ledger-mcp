# Context Ledger MCP

Task state that survives context loss.

An MCP server that stores the small amount of structured state a coding agent
must not forget — the objective, the constraints, the decisions and their
reasons, the approaches already rejected, the open questions, the remaining plan
— and reconstructs it as a bounded, deterministic block when a session resumes.

Not vector memory. Not a transcript store. Not an LLM wrapper. One task's live
state, explicitly recorded, deliberately small.

---

## Five minutes

```bash
npm install
npm run build
node dist/cli/index.js demo
```

The demo runs a full session-A → context-loss → session-B cycle on a throwaway
in-memory ledger: records constraints and a dead end, has a secret redacted on
the way in, reverses a decision via supersession, then reconstructs the whole
state for a fresh session and prints the derived telemetry.

Then the measured experiment:

```bash
node dist/cli/index.js experiment
```

```
  condition      chars   all probes     critical  facts/1k
  baseline         680   3/16 18.8%     0/7 0.0%      4.41
  ledger_only     3513  14/16 87.5%   7/7 100.0%      3.99
  ledger          4195  15/16 93.8%   7/7 100.0%      3.58
```

**Read the baseline row, not the ledger row.** A fresh session resuming from the
ticket and the repository had **none** of the seven items whose loss causes wrong
output. The ledger rows are partly a self-consistency check — see
[What is actually measured](#what-is-actually-measured).

---

## Why

A coding agent working past one context window loses the reasoning layer around
the code. Not the code — that is on disk — but *why* it looks like that, *what
was already ruled out*, and *what was still owed*.

Concretely, eight failure modes:

| | Failure | Consequence |
|---|---|---|
| F1 | Constraint amnesia | wrong output |
| F2 | Dead-end repetition | wasted cycles, then wrong output |
| F3 | Decision contradiction | wrong output |
| F4 | Acceptance drift | incomplete work shipped as done |
| F5 | Question loss | the agent answers what was escalated to a human |
| F6 | Redundant exploration | token and wall-clock cost |
| F7 | Unexplainable work | no audit trail |
| F8 | Plan loss | completed work redone |

F1–F5 produce wrong output, and a bigger context window does not fix them:
compaction is lossy in exactly the wrong direction. A summary that reads "we
discussed rate-limiting approaches" has already destroyed F2.

Full problem framing, hypotheses and non-goals: [PRODUCT.md](PRODUCT.md).

---

## Install as an MCP server

```bash
node dist/cli/index.js serve-info    # prints host-specific registration
```

Claude Code:

```bash
claude mcp add context-ledger --scope project \
  -e CONTEXT_LEDGER_DB=.ledger/ledger.sqlite \
  -- node "$PWD/dist/mcp/server.js"
```

Generic `mcpServers` JSON (Codex and most other hosts):

```json
{ "mcpServers": { "context-ledger": {
    "command": "node",
    "args": ["/abs/path/dist/mcp/server.js"],
    "env": { "CONTEXT_LEDGER_DB": ".ledger/ledger.sqlite",
             "CONTEXT_LEDGER_SECRETS": "redact" } } } }
```

| Env var | Default | Meaning |
|---|---|---|
| `CONTEXT_LEDGER_DB` | `.ledger/ledger.sqlite` | Ledger file |
| `CONTEXT_LEDGER_SESSION` | generated | Session id stamped as provenance |
| `CONTEXT_LEDGER_SECRETS` | `redact` | `redact` \| `reject` \| `off` |

Verified against **Claude Code 2.1.266** and **Codex 0.153.4**, both driving the
same ledger file — real transcripts in
[docs/agent-integration.md](docs/agent-integration.md).

---

## Tool surface

Ten tools. The agent-facing contract, in the order an agent uses them:

| Tool | Purpose |
|---|---|
| `ledger_init_task` | Start a task with a verbatim objective, acceptance criteria, constraints |
| `ledger_recover_context` | **The primary tool.** Bounded reconstruction of task state |
| `ledger_record_constraint` | A requirement a future session must still respect |
| `ledger_record_decision` | A decision — **rationale required** |
| `ledger_record_rejected_approach` | Something tried that failed, and why |
| `ledger_record_finding` | A hard-won fact about the codebase |
| `ledger_open_question` | Raise or resolve a question needing a human |
| `ledger_update_todo` | Maintain the remaining plan |
| `ledger_record_verification` | The result of actually running something |
| `ledger_get_task_state` | Unbounded audit dump (debugging, not resuming) |

Plus a resource `ledger://task/{task_id}/recovery` and a prompt `resume_task`.

Why ten and not one generic `ledger_write`: the tool name and its **required**
arguments are the most reliable prompt in the system. A required `rationale`
makes an unjustified decision *impossible*, not merely discouraged. See
[ARCHITECTURE.md](ARCHITECTURE.md#tool-surface).

---

## What recovery returns

```
=== CONTEXT LEDGER — TASK STATE RECONSTRUCTION ===
task: task_… repo: example/api

ORIGINAL OBJECTIVE:
  Add per-API-key rate limiting to the public REST API

ACTIVE CONSTRAINTS:
  - [blocking] No new runtime dependencies — src: CONTRIBUTING.md

ACCEPTANCE CRITERIA:
  - [NOT MET] A client over 100 requests/minute for one API key receives HTTP 429

CURRENT PLAN (REMAINING TODOS):
  - [TODO] Add an integration test for the 429

DECISIONS ALREADY MADE:
  - Use a fixed 60-second window keyed by (api_key, floor(now/60))
    — because: the sliding log needed one row per request and blew up table size

FAILED APPROACHES — DO NOT REPEAT:
  - Keep counters in a module-level Map — failed because: with 4 worker processes
    the effective limit becomes 4x the configured one
    (evidence: load test admitted 400 requests against a limit of 100)

OPEN QUESTIONS: … RELEVANT FINDINGS: … LAST VERIFICATION STATE: …

NOTES:
  - This is recorded task state, not ground truth. If it contradicts the
    repository, trust the repository and record a correction.

[budget 754/4000 chars; fingerprint d3f7f20eee0a372a]
```

Two properties that are tested, not asserted:

- **Deterministic.** Same ledger state, same request → byte-identical output.
  Independent of wall-clock time and of record ids.
- **Honestly bounded.** Respects a character budget, *except* that blocking
  constraints, unmet acceptance criteria, rejected approaches and active
  decisions are never silently dropped. If they don't fit, the output declares
  `BUDGET EXCEEDED`. Every omission is counted inline. A silently partial
  reconstruction is the one failure that would make this worse than nothing.

---

## Secret hygiene

Agents read `.env` files. A persistent, inspectable SQLite file must not become
a credential store.

Redaction runs at the **storage boundary** — not the MCP layer — so no transport
can bypass it. Twelve credential classes plus an entropy detector on assignment
right-hand sides; `content`, `rationale`, `evidence` and the task objective are
all scrubbed; the redaction count is stored per record and surfaced as a
guardrail metric.

```bash
node dist/cli/index.js secret-scan   # re-scan everything already stored
CONTEXT_LEDGER_SECRETS=reject        # refuse the write instead of redacting
```

**Limits, stated plainly:** this is pattern matching. It catches *shaped*
secrets. It will not catch a password that reads like an English phrase, and it
is deliberately biased toward false positives. It is damage control, not a
licence to paste secrets. Details and residual risk:
[docs/failure-model.md](docs/failure-model.md#5-secrets-persisted).

---

## What is actually measured

**Measured** (`context-ledger experiment`, reproducible): context sufficiency —
of the state items a resumed session provably needs, what share is present in
the context it receives. Baseline 3/16 (0/7 critical) vs. ledger+repo 15/16
(7/7 critical), at 2 996 characters.

**Not measured:** whether an agent handed that context actually behaves better.
Sufficiency is a *necessary condition* and an *upper bound*, not an outcome. An
agent can be given a blocking constraint and violate it anyway.

The probes were also authored from Session A's own records, so the ledger side
is closer to a self-consistency check (recovery didn't drop what was recorded)
than to evidence of product value. Two negative controls keep it honest, and both
correctly fail:

- a fact **never recorded** stays unrecoverable in every condition — the ledger
  does not invent knowledge;
- a **repository-only** fact is unrecoverable from the ledger alone — the ledger
  supplements the repository, it does not replace it.

The live-agent experiment that would actually test the hypothesis is
pre-registered with **empty result tables** in
[docs/agentdev-experiment.md](docs/agentdev-experiment.md). It includes a
prompt-only placebo arm, because if the ledger does not beat "keep a NOTES.md",
the value is the discipline and the right product is a prompt.

---

## Tests

```bash
npm test        # 107 tests
```

[tests.json](tests.json) maps every suite to the **claim it defends**, and lists
what is *not* covered. A claim in the docs that no suite defends is a claim this
project is not entitled to make.

Includes protocol-level tests over a real MCP `Client`/`McpServer` pair, a
cross-process concurrency test, a v1→v2 migration test against a real v1
database, and a regression test for a host-compatibility bug that only live
agent integration found.

---

## CLI

```
demo                     End-to-end walkthrough on a throwaway ledger
experiment [--json]      Session-reset experiment with measured results
serve-info               Host registration snippets
tasks                    List tasks
state    --task <id>     Full recorded state (audit view)
recover  --task <id>     The reconstruction an agent would receive
             [--budget n] [--focus "..."]
history  --record <id>   Supersession chain for one record
metrics  [--task <id>]   Derived metrics, with observability caveats
events   [--task <id>]   Raw telemetry log
secret-scan              Re-scan stored content
doctor                   Environment and schema check
```

---

## Documents

| | |
|---|---|
| [PRODUCT.md](PRODUCT.md) | Problem, hypotheses, requirements, risks, open questions |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The five decisions that matter, and what they foreclose |
| [RESEARCH.md](RESEARCH.md) | What was measured, how, and what it does not show |
| [docs/product-metrics.md](docs/product-metrics.md) | North Star, activation, retention, A/B design |
| [docs/failure-model.md](docs/failure-model.md) | Failure and threat model, ordered by harm |
| [docs/agentdev-experiment.md](docs/agentdev-experiment.md) | Pre-registered live-agent experiment |
| [docs/prd-case-study.md](docs/prd-case-study.md) | PRD as it would go to an engineering team |
| [docs/interviewer-brief.md](docs/interviewer-brief.md) | Two-page technical summary |
| [docs/agent-integration.md](docs/agent-integration.md) | Real host transcripts, including a bug they found |
| [docs/hostile-review.md](docs/hostile-review.md) | Adversarial self-review and what it changed |
| [progress.md](progress.md) | Exact current state |

---

## Requirements

Node ≥ 22.5 (for built-in `node:sqlite`). No native dependencies — `npm install`
cannot fail on a compiler toolchain. Developed on Node 24.18.

## Status

Prototype. Mechanism implemented and tested; product hypothesis **not yet
tested**. See [progress.md](progress.md) and the limitations section of
[docs/interviewer-brief.md](docs/interviewer-brief.md).
