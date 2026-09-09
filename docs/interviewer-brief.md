# Context Ledger — Reviewer Brief

Two pages. No hype. Claims are tagged **[measured]**, **[observed]**,
**[hypothesis]**, or **[not done]**.

---

## The problem

Coding agents lose task state on long work. The repository preserves *what* was
built; it does not preserve *why*, *what was already ruled out*, or *what was
still owed*. When context is compacted or a session restarts, the agent either
re-derives that layer or proceeds without it. The second is the expensive case,
because it is silent — an agent that has forgotten "no new runtime dependencies"
does not hesitate before proposing Redis.

A larger context window does not fix this. Compaction is lossy in exactly the
wrong direction: a summary reading "we discussed rate-limiting approaches" has
already destroyed the fact that one of them was tried and failed.

## Why the product exists

**[hypothesis]** A small, *explicitly written*, structured task-state layer,
reinjected as a bounded reconstruction at session start, reduces constraint
violations and repeated dead ends in long-horizon coding work.

Two deliberate scope cuts distinguish it from "agent memory":

- **One task's live state, not a knowledge base.** Tens of records, not
  thousands. This is what makes deterministic selection viable.
- **Asserted, not extracted.** The agent writes a record as a commitment.
  Extraction from transcripts produces plausible-looking state that nobody
  asserted, which is worse than no state.

## Architecture

```
agent host ──MCP/stdio──▶ 10 tools ─▶ LedgerService ─┬─▶ deterministic recovery
                         1 resource                  ├─▶ SQLite (WAL, migrations)
                         1 prompt                    │      ▲ redaction sits here
                                                     └─▶ telemetry / metrics
```

Everything above SQLite is pure and synchronous. No network call, no model call,
no background work.

**One record table**, discriminated by type, with shared provenance columns.
Rejected a node/edge graph: recovery needs a bounded list, not a traversal, and
one table makes a single monotonic `ordinal` a total order over all state —
which is what makes recovery deterministic at all.

**Supersession, never mutation.** Content is immutable; changing what a record
says means writing a successor. A partial unique index enforces single-successor
chains in the *schema*, so "the current decision" is always well defined. Nothing
is deleted. **[measured]** A six-deep chain retains all six records.

**Redaction at the storage boundary**, not the transport, so the CLI, the
experiment harness and any future transport are covered by construction.

## MCP design

Ten tools. The alternative — one `ledger_write(type, content)` — was rejected
because the tool name and its **required** arguments are the most reliable
prompt in the system. `ledger_record_decision` with a required `rationale` makes
recording an unjustified decision *impossible*, not merely discouraged. The
opposite failure (verb × type ≈ 32 tools) is avoided by putting lifecycle
changes behind an `op` enum.

Also a **resource** (`ledger://task/{id}/recovery`, so a host can show state to
a human without an agent turn) and a **prompt** (`resume_task`).

**[observed] One real lesson.** A tool declaring an `outputSchema` may have its
text block discarded by the host — Claude Code does exactly this. The first live
smoke test handed the agent a fingerprint and a character count, and it
correctly refused to answer. Eighteen protocol tests had passed, because they
read the text block. The reconstruction now appears in both payloads, with a
regression test. **No amount of protocol testing would have found this; only a
real host did.**

## Tradeoffs worth arguing about

**Deterministic lexical selection over embeddings.** The candidate set is tens
of records; type structure already does most of the filtering; and determinism
is a *product* property — an agent that gets a different reconstruction each
call cannot be debugged. `overlapScore` is the single seam where a re-ranker
would go, for the findings section only. The evidence that would justify adding
it is pre-registered (H3).

**The protected set.** Bounding is the product, so what happens at the boundary
is the central design question. The rule is not "keep the important ones" but:
*never drop state whose loss causes silent incorrectness and that cannot be
re-derived from the repository* — blocking constraints, unmet acceptance
criteria, rejected approaches, active decisions. If they don't fit, recovery
goes **over budget and says so**. Findings are explicitly unprotected: a finding
is by definition re-derivable by reading code.

**[measured] This rule was corrected by measurement.** The first version
protected advisory constraints but not architectural decisions; the budget sweep
showed a Postgres-vs-Redis decision being dropped at 1 500 chars while a
spelling preference survived. The sweep is now a regression test.

**Mandatory rationale is deliberate friction.** It raises the cost of recording
a decision. Whether that suppresses recording enough to hurt is unmeasured.

## Metrics

**North Star: Assisted Resume Success Rate** — resumed sessions reaching a
passing verification with zero recorded-constraint violations and zero repeated
dead ends. Three conjunctive conditions because each alone is gameable.

Not used, and *absent from the code by test*: records stored, MCP calls, tokens
stored. Each goes **up** when the product is used badly — a ledger full of
narration scores highest.

Every metric carries an `observability` field. `constraint_violation_rate` is
labelled **self_reported** and a test enforces that it stays so: the server never
sees the diff, only what the agent declares.

## What is genuinely implemented

Full state model with enforced invariants · SQLite with WAL, forward-only
migrations, cross-process writers · redaction across 12 credential classes ·
deterministic bounded recovery · MCP server (10 tools, 1 resource, 1 prompt) ·
telemetry and derived metrics · CLI (demo, experiment, state, recover, history,
metrics, events, secret-scan, doctor) · offline experiment harness ·
**107 tests**, including protocol-level tests over a real MCP client/server pair.

## What has actually been measured

**[measured]** On the benchmark session-reset scenario (`context-ledger experiment`):

| Condition | All 16 probes | 7 critical probes |
|---|---|---|
| Baseline: ticket + repo as Session A left it | 18.8% | **0%** |
| Ledger recovery only, no repo | 87.5% | 100% |
| Ledger + repo | 93.8% | 100% |

Reconstruction cost: 2 996 chars. Critical sufficiency holds at 100% down to a
500-char budget.

**Read this honestly.** The informative number is the **baseline's 0/7** — a
fresh session had none of the state whose loss causes wrong output. The ledger
column is closer to a self-consistency check, because the probes were authored
from Session A's own records. Two negative controls keep it honest and both
correctly fail: a fact never recorded stays unrecoverable in every condition,
and a repository-only fact is unrecoverable from the ledger alone.

**[measured]** Live integration: Claude Code 2.1.266 and Codex 0.153.4 both
drove the server correctly against the **same ledger file**; a fresh Claude Code
process, given only a task id, recovered a blocking constraint and a rejected
approach from a session it never saw. Transcripts in `docs/agent-integration.md`.

## Limitations

1. **[not done] No user research.** The failure taxonomy is first-principles
   plus one self-observed instance. This is the largest gap in the case.
2. **[not done] No agent-behaviour result.** Sufficiency is a *necessary
   condition* and an *upper bound*, not an outcome. An agent can be handed a
   blocking constraint and violate it anyway.
3. **The load-bearing risk is that agents don't record.** Nothing inside the
   server can force it. This is the one that kills the product.
4. **[observed] Recovery was called only when prompted** that the session was
   resuming. Unprompted invocation is untested; a host hook may be the real
   answer.
5. **Secret redaction is pattern-based.** It catches shaped secrets, not a
   password that reads like an English phrase.
6. **Prompt injection can launder provenance** — hostile repository text
   recorded as a constraint becomes protected state. Mitigated by provenance
   display only.
7. **Scale untested** past low tens of records per task; selection is O(n).
8. **Findings go stale** and the server cannot know it; it has no repository
   access by design.

## The next experiment

Pre-registered in `docs/agentdev-experiment.md`, **with empty result tables**:
four arms — baseline, ledger, **prompt-only placebo**, and ledger-with-recovery-
disabled — across 12 tasks in four stress families, hard context resets at
scripted checkpoints, blinded automated grading, thresholds and failure
treatment fixed before any run, and a pre-declared *inconclusive* band that
cannot be narrated into a win.

The prompt-only arm is the one a skeptic should insist on: if the ledger does
not beat "write your constraints in a markdown file and read it at session
start", then the value is the discipline, not the tool, and the correct product
is a prompt. That arm is in the design because the answer might be no.
