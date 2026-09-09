# Context Ledger — Product Definition

> **Evidence discipline.** Every claim below is tagged.
> **[MEASURED]** — produced by code in this repository; the command that produces it is named.
> **[OBSERVED]** — directly witnessed in this project's own agent sessions, and reproducible.
> **[HYPOTHESIS]** — a testable proposition this project exists to test. Not established.
> **[ASSUMPTION]** — taken as given without evidence; wrong-ness would change the design.
>
> There are **no user interviews** behind this document, and none are invented.
> The absence of user research is the single largest gap in this product case,
> and it is stated in Open Questions rather than papered over.

---

## Problem

A coding agent working a task longer than one context window loses task state.
Not the code — the code is on disk — but the *reasoning state around* the code:
the constraint someone mentioned once in the ticket thread, the approach that
was tried at hour two and abandoned, the reason the obvious library was
rejected, the question that is still waiting on a human.

The repository preserves *what* was built. It does not preserve *why*, *what was
already ruled out*, or *what was still owed*. When context is compacted or a
session restarts, that layer is gone, and the agent's next move is either to
re-derive it (expensive) or to proceed without it (wrong).

**[OBSERVED]** During this project's own construction, an agent-driven session
reset produced exactly the predicted failure: a fresh Claude Code session,
given a task id and no ledger content, could not state which pagination
approach had already been rejected, and correctly refused to guess. The
transcript is in `docs/agent-integration.md`. This is a single instance and a
self-observation, not a study.

### The failure modes, stated concretely

| # | Failure | What it looks like |
|---|---------|--------------------|
| F1 | Constraint amnesia | "No new runtime dependencies" is forgotten; the agent adds Redis. |
| F2 | Dead-end repetition | An approach rejected in session A is attempted again in session B. |
| F3 | Decision contradiction | Session B reverses a settled architectural decision without knowing it was settled. |
| F4 | Acceptance drift | The definition of done quietly narrows to what has been built. |
| F5 | Question loss | A question escalated to a human is silently answered by the agent instead. |
| F6 | Redundant exploration | Files already read and understood are read and understood again. |
| F7 | Unexplainable work | Asked why something was built this way, the agent cannot say. |
| F8 | Plan loss | Completed work is redone; remaining work is re-derived. |

F1–F5 produce *wrong output*. F6–F8 produce *waste*. The wrong-output group is
the one that matters, and it is the group a bigger context window does not fix:
a compaction that summarises "we discussed rate limiting approaches" has
already destroyed F2.

---

## Target user

**Primary: the coding agent itself.** It is the only party in the loop on every
turn, and it is the party whose behaviour must change. This is unusual and it
drives the design: the tool schemas are the user interface, and they are written
to be read by a model.

**Secondary: the engineer supervising the agent.** They care about *not having
to re-explain the same constraint*, and about being able to audit why the agent
did what it did.

**Tertiary: the platform team** deciding whether to install this for everyone.
They care about cost, blast radius, and whether the metrics justify it.

**[ASSUMPTION]** The primary user is capable of following tool descriptions
about *when* to call recovery. If agents will not call it unprompted, the
product needs host-level integration (a hook, or the host injecting recovery on
resume) rather than a tool. **[MEASURED]** In four live smoke-test sessions
across Claude Code and Codex, the agent called `ledger_recover_context` when the
prompt told it it was resuming; it has not been tested unprompted.

---

## Jobs to be done

1. *When I resume a task I have no memory of, help me become correct in one
   call, before I touch the repository.*
2. *When I make a decision I will not remember, let me record it with its reason
   cheaply enough that I actually bother.*
3. *When I fail at something, let me record the failure so my future self does
   not pay for it twice.*
4. *When I am about to contradict an earlier decision, make that visible rather
   than silent.*
5. *(Engineer) When I ask why the code looks like this, give me a real answer
   with provenance.*

---

## Hypothesis

**[HYPOTHESIS] H1 (primary).** A small, structured, explicitly-written task-state
layer, reinjected as a bounded reconstruction at session start, reduces
constraint violations and repeated dead ends in long-horizon coding work,
relative to the same agent resuming from repository state and the original
ticket alone.

**[HYPOTHESIS] H2.** Deterministic selection is sufficient. Ranking task state
does not require embeddings or an LLM re-ranker, because the candidate set per
task is small (tens of records, not thousands) and the sections are
type-structured.

**[HYPOTHESIS] H3.** Explicit recording by the agent beats automatic extraction
from the transcript. Writing a record is a commitment; extraction produces
plausible-looking state that no one asserted.

**[MEASURED] H1 is not established.** What *is* measured is its necessary
condition — see Success Metrics.

---

## Non-goals

- **Not a memory system.** No transcript storage, no conversation history, no
  "remember everything" surface. Scope is one task's live state.
- **Not vector search.** No embeddings in the core path. See ARCHITECTURE.md.
- **Not cross-task knowledge.** Findings do not leak between tasks; task
  isolation is a tested invariant.
- **Not a replacement for the repository.** **[MEASURED]** The `ledger_only`
  experiment condition scores 87.5% against 93.8% for ledger+repo, because a
  repository-only fact is provably unrecoverable from the ledger. Run
  `context-ledger experiment`.
- **Not an agent framework, a UI, or a SaaS.** There is a CLI and an MCP server.
- **Not a credential store.** See PART: secret hygiene, and docs/failure-model.md.

---

## User scenarios

**S1 — Compaction mid-task.** An agent is four hours into a refactor. The host
compacts its context. It calls `ledger_recover_context`, receives 2–4 KB of
objective, constraints, decisions-with-rationale, rejected approaches and
remaining todos, and continues without re-reading the codebase.

**S2 — Next-day resume.** A different session, possibly a different model,
picks up the task id. Same call, same reconstruction. **[MEASURED]** Verified
end to end against both Claude Code and Codex (`docs/agent-integration.md`).

**S3 — Reversal.** The agent decides the earlier storage choice was wrong. It
records the new decision with `supersedes`. The old decision leaves recovery
output but stays in the audit trail, so "why did this change?" is answerable.

**S4 — Handover to a human.** An engineer runs
`context-ledger state --task <id>` and reads the decision log with provenance,
rather than scrolling a transcript.

**S5 — Secret near-miss.** The agent reads `.env` and writes a finding that
embeds a live key. The storage layer redacts it before it lands. **[MEASURED]**
Tested for twelve secret classes, at every write path, including through the
MCP layer.

---

## Functional requirements

| ID | Requirement | Status |
|----|-------------|--------|
| FR1 | Initialise a task with a verbatim objective, acceptance criteria and constraints | Implemented |
| FR2 | Record constraint, acceptance criterion, decision, rejected approach, finding, open question, todo, verification | Implemented |
| FR3 | A decision or rejected approach cannot be recorded without a rationale | Implemented, tested |
| FR4 | Supersede a record; the prior version is retained and auditable | Implemented, tested |
| FR5 | Produce a bounded reconstruction of task state | Implemented, tested |
| FR6 | The reconstruction is deterministic for a given ledger state | Implemented, tested |
| FR7 | State whose loss causes silent incorrectness is never dropped for budget | Implemented, tested |
| FR8 | Redact secret-shaped content at the storage boundary | Implemented, tested |
| FR9 | Emit a telemetry event for every state change and every recovery | Implemented, tested |
| FR10 | Survive process restart and concurrent writers | Implemented, tested |
| FR11 | Schema migration with forward-only versioning | Implemented, tested |
| FR12 | Expose all of the above over MCP | Implemented, tested at protocol level |

---

## Constraints

- **C1** Local-first. No network calls, no service dependency, no telemetry
  egress. A ledger is a file the user owns.
- **C2** Zero native dependencies. Uses `node:sqlite` (Node ≥ 22.5), so
  `npm install` cannot fail on a compiler toolchain.
- **C3** The recovery payload must fit a context budget an agent can afford —
  target ≤ 4 KB. **[MEASURED]** The scenario reconstruction is 2 996 chars.
- **C4** No LLM inside the server. A memory layer that hallucinates is worse
  than no memory layer, and a server that calls a model is a server with a
  latency floor, a cost, and a failure mode on every read.
- **C5** No silent destructive updates. Superseded state stays queryable.

---

## Success metrics

North Star and the full metric tree are in `docs/product-metrics.md`. In brief:

**North Star: Assisted Resume Success Rate** — the share of resumed task
sessions that reach a passing verification without violating a recorded
constraint or repeating a recorded dead end.

**[MEASURED] today — context sufficiency.** Of the state items a resumed
session provably needs, what share is present in the context it receives?
Command: `context-ledger experiment`.

| Condition | All 16 probes | 7 critical probes |
|---|---|---|
| Baseline (ticket + repo as Session A left it) | 3/16 = 18.8% | 0/7 = **0%** |
| Ledger recovery only, no repo | 14/16 = 87.5% | 7/7 = 100% |
| Ledger + repo | 15/16 = 93.8% | 7/7 = 100% |

Reading this honestly: the informative number is the **baseline's 0/7 on
critical items** — a fresh session had none of the state whose loss causes
wrong output. The ledger side is closer to a self-consistency check (recovery
did not drop what was recorded) than to evidence of product value, because the
probes were written from Session A's records. The two negative-control probes
exist to keep that check honest: one fact was never recorded and stays
unrecoverable in every condition, and one repository-only fact is unrecoverable
from the ledger alone.

**Not measured: whether agents behave better.** Sufficiency is a *necessary
condition* and an *upper bound* on the outcome, not the outcome. The live-agent
design that would close this is pre-registered in `docs/agentdev-experiment.md`
with empty result slots.

---

## Guardrail metrics

| Guardrail | Why | Threshold |
|---|---|---|
| `redacted_record_rate` | Agents pushing secret-shaped text at the ledger | Any sustained non-zero rate is an incident, not a metric |
| `decision_supersession_rate` | Ledger used as a scratchpad instead of a commitment log | Investigate above ~0.4 |
| Recovery payload size | Context spend must stay bounded | p95 ≤ 4 KB |
| Records per task | Over-recording degrades ranking for everyone | Investigate above ~60 |
| `duplicate_exploration_rate` | The ledger accumulating restatements of itself | Investigate above ~0.2 |
| Recovery latency | It runs at the top of every resumed session | p95 ≤ 50 ms |

Deliberately **not** metrics: records stored, MCP calls, tokens persisted,
tasks created. They measure our activity, not the user's outcome, and they all
go *up* when the product is being used badly. `src/test/telemetry.test.ts`
asserts their absence.

---

## Acceptance criteria

1. `npm install && npm test` passes from a clean clone on Node ≥ 22.5 with no
   native toolchain. ✅
2. Protocol-level MCP tests pass against a real client/server pair. ✅ (18 tests)
3. Recovery is byte-identical across repeated calls and independent of clock
   and record ids. ✅
4. Blocking constraints, unmet acceptance criteria, rejected approaches and
   active decisions are never silently dropped; over-budget is declared. ✅
5. Twelve secret classes are redacted at every write path, with zero false
   positives on the engineering-prose corpus. ✅
6. State survives restart; two connections and a second OS process share one
   ledger without loss. ✅
7. A live agent, given only a task id and the MCP server, correctly answers
   questions about state from a session it never saw. ✅ (Claude Code and Codex)
8. Every metric declares its observability; no metric is presented as measured
   ground truth when it is self-reported. ✅

---

## Risks

| Risk | Severity | Current mitigation | Residual |
|---|---|---|---|
| **R1 Agents don't record.** The ledger is only as good as the discipline of the agent writing to it. | **Fatal to the product** | Tool descriptions instruct; rationale is mandatory on the highest-value types | Large. No mitigation inside the server can force recording. This is the risk that would kill the product. |
| **R2 Agents record noise.** Narration and restatement crowd out real state. | High | Explicit "do not record narration" instruction; 8 000-char cap; `duplicate_exploration_rate` guardrail | Moderate. Not enforced, only discouraged. |
| **R3 Stale state trusted over the repo.** | High | Every reconstruction ends with "if this contradicts the repository, trust the repository" | Moderate. Advisory only. |
| **R4 Sufficiency ≠ behaviour.** The measured win may not translate into agent behaviour at all. | High | Stated everywhere; pre-registered live experiment | Large and honest. |
| **R5 Secret leakage.** Pattern matching misses unshaped secrets. | High | Redaction at the storage boundary, 12 classes, `secret-scan` re-scan, `reject` mode | Real. Documented as best-effort in docs/failure-model.md. |
| **R6 Prompt injection stored as state.** Hostile repo content becomes a "constraint". | Moderate | Provenance on every record; recovery is labelled as recorded claims, not ground truth | Real. See docs/failure-model.md. |
| **R7 Host discards structured output.** | Moderate | Found in live testing; reconstruction now in both text and structured content, with a regression test | Closed for the two hosts tested. |
| **R8 The problem gets solved elsewhere.** Longer contexts, better host-native compaction. | Moderate | None available to us | Real. Note that context length does not fix F1–F5; lossy compaction does not preserve a rejected approach. |

---

## Open questions

1. **The largest one: no user research exists.** The failure modes are derived
   from first principles and one self-observed instance, not from watching
   engineers. The first thing this project needs is not more code.
2. Will agents call recovery unprompted, or does this need to be a host hook?
3. Is per-task isolation right, or does a repository-level constraint set
   ("this repo never adds dependencies") need to outlive tasks?
4. What is the correct default budget? 4 KB is an assumption, not a finding.
5. Who resolves a conflict between two live constraints — the agent, or a human?
6. Does mandatory-rationale reduce recording volume enough to hurt? The friction
   is deliberate, but its cost is unmeasured.
7. Does this help at all on tasks *shorter* than one context window, or is the
   overhead pure cost there?
