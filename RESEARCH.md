# Research Notes

What was measured, exactly how, and — at equal length — what it does not show.

**Nothing in this file is estimated, extrapolated or illustrative.** Every
number is produced by a named command in this repository, and the raw output is
committed under `docs/evidence/`. Every claim that is *not* measured is labelled.

---

## 1. Research question

**RQ.** Does a small, explicitly-recorded, structured task-state layer,
reinjected as a bounded reconstruction, improve the reliability of a coding
agent resuming work after context loss?

RQ decomposes into two questions that are usually conflated, and this project
can currently answer only the first:

| | Question | Status |
|---|---|---|
| **RQ1** | Does the resume context *contain* the state a session needs? | **Measured** |
| **RQ2** | Does an agent *given* that context behave better? | **Not measured** |

RQ1 is a property of an artifact and is measurable offline, deterministically,
with no model in the loop. RQ2 requires live agent runs with a control arm and a
blinded grader.

**RQ1 is a necessary condition for RQ2 and an upper bound on it.** An agent
cannot honour a constraint it was never shown; it can perfectly well violate one
it was shown. Reading a positive RQ1 result as an answer to RQ2 is the central
error this document is written to prevent.

---

## 2. Method — context sufficiency

**Command:** `node dist/cli/index.js experiment`
**Code:** `src/experiment/scenario.ts`, `src/experiment/harness.ts`
**Raw output:** `docs/evidence/experiment-output.txt`,
`docs/evidence/experiment-result.json`

### Construction

A scripted, realistic multi-stage software task — adding per-API-key rate
limiting to a Node service — in which Session A performs 17 recorded actions
(three constraints, two acceptance criteria, two rejected approaches with
measured failure evidence, two decisions with rationale, two findings, three
todos of which one is completed, one open question, one verification).

Session B then resumes under three conditions and is scored against **16
knowledge probes**. A probe is a fact Session A established that Session B needs,
paired with the concrete failure that follows if it is missing. Matching is
**AND-of-ORs over case-insensitive substrings** — deterministic, no model, no
fuzzy scoring — so a probe accepts paraphrase without accepting an accidental
keyword hit.

### The three conditions

| Condition | Contents |
|---|---|
| `baseline` | The ticket **plus the repository as Session A left it**: partial `src/limiter.ts`, its TODO comment, `README`, `CONTRIBUTING`, `git log -1`, passing test suite |
| `ledger_only` | The reconstruction alone, no repository |
| `ledger` | `baseline` **+** the reconstruction |

Two design choices matter for validity:

1. **The baseline is deliberately generous.** Understating what a fresh agent
   can see from the repository would manufacture the result. A test asserts the
   baseline satisfies probes on its own.
2. **The ledger condition is additive.** `ledger` is a strict extension of
   `baseline`, asserted by test. Comparing recovery *instead of* the repository
   would be a strawman; `ledger_only` is reported separately precisely so the
   "supplement, not replacement" claim is falsifiable.

### Results — [MEASURED]

| Condition | chars | All 16 probes | 7 critical probes | facts/1k chars |
|---|---|---|---|---|
| `baseline` | 680 | 3/16 = 18.8% | **0/7 = 0%** | 4.41 |
| `ledger_only` | 3 513 | 14/16 = 87.5% | 7/7 = 100% | 3.99 |
| `ledger` | 4 195 | 15/16 = 93.8% | 7/7 = 100% | 3.58 |

Reconstruction cost: **2 996 characters**.

### Cost of bounding — [MEASURED]

| Budget | Used | All probes | Critical | Note |
|---|---|---|---|---|
| 4 000 | 2 996 | 93.8% | 100% | |
| 2 500 | 2 421 | 81.3% | 100% | |
| 1 500 | 2 316 | 75.0% | 100% | over budget — protected state refused to drop |
| 900 | 2 316 | 75.0% | 100% | over budget |
| 500 | 2 068 | 75.0% | 100% | over budget |

Two real findings here. Overall sufficiency degrades **gracefully** under budget
pressure; critical sufficiency does not degrade at all. And there is a **hard
floor of ~2 068 characters** — the protected set alone. Below that, recovery
goes over budget by design rather than truncating silently.

### How to read this honestly

**The informative number is the baseline's 0/7 on critical items.** A fresh
session resuming from the ticket and the repository had *none* of the seven
items whose loss causes wrong output — not the no-dependency constraint, not the
multi-worker requirement, not either of the two approaches already tried and
measured as failures, not the architectural decision.

**The ledger column is closer to a self-consistency check than to evidence of
value.** The probes were authored from Session A's own records, so a high score
mostly demonstrates that recovery selection and budgeting *did not drop what was
recorded* — a real property, and one that could easily have failed (it did fail
for decisions before the protection rule was fixed), but not a product result.

Two **negative controls** keep that check honest, and both correctly fail:

- `retry-after-value` — a fact Session A never established. It is unsatisfied in
  **every** condition, including `ledger`. The ledger does not invent knowledge.
  This is why the headline is 93.8% and not 100%; the missing 6.2% is
  load-bearing.
- `partial-impl-location` — a fact that lives only in the repository. It is
  unsatisfied in `ledger_only` and satisfied in `ledger`. The ledger supplements
  the repository; it does not replace it.

### Threats to validity — [stated, not resolved]

| Threat | Effect on the result |
|---|---|
| **Probes authored from Session A's records** | Inflates the ledger column. Mitigated by negative controls, not eliminated. |
| **A single scenario** | n = 1 task, one domain. No generality claimed. |
| **Session A recorded diligently** | The scenario assumes the behaviour that PRODUCT.md R1 says is the biggest risk. A thin ledger would score far lower, and the harness would show it. |
| **Substring matching is not comprehension** | A probe can be satisfied by text an agent would not act on. This is why sufficiency is an upper bound. |
| **Hard reset, not compaction** | Real context loss is lossy summarisation, which is *partially* informative. A hard reset is the stronger treatment and likely **overstates** the gap. |

---

## 3. Method — live agent integration

**Evidence:** `docs/agent-integration.md` (verbatim transcripts)

Executed 2026-09-09 against **Claude Code 2.1.266** and **Codex 0.153.4**.

### [MEASURED] What was established

- The server is protocol-compliant against two independent host
  implementations, neither of which is the SDK's own test transport.
- Real agents use the tool schemas without hand-holding.
- A **fresh** `claude -p` process, given only a task id and the MCP server,
  correctly reported a blocking constraint and a rejected approach from a
  session it never saw.
- Codex answered correctly from the **same ledger file** Claude Code wrote —
  the MCP portability claim, actually exercised.

### [OBSERVED] The most valuable single result of this project

Live integration found a defect that **18 protocol-level tests did not**.

When a tool declares an `outputSchema`, Claude Code surfaces only
`structuredContent` to the model and **discards the text block**. The
reconstruction lived solely in the text block. The agent therefore received a
fingerprint and a character count, and replied:

> *"I can't answer either question … so I have no recovered content, and I won't
> invent it."*

Two lessons, both kept:

1. **Protocol conformance is not host compatibility.** The tests were correct
   and passing; they read a payload the real host throws away. A tool whose
   entire value is a text payload must place that payload in the structured
   output too. Fixed, with two regression tests.
2. **The failure was loud, not silent** — the agent refused to guess. That is
   the failure mode a state-recovery tool should have, and it is worth noting
   that it arose without being designed for.

### Not established

- **That agents call recovery unprompted.** In all four sessions the prompt said
  the session was resuming. Unprompted invocation is untested; a host hook may
  be the correct mechanism. PRODUCT.md open question 2.
- **Anything about outcomes.** Four short sessions, one contrived task, no
  control condition. Smoke tests of a mechanism, not evidence for H1.

---

## 4. Method — invariants and properties

**Command:** `npm test` — 107 tests. **Raw output:** `docs/evidence/test-output.txt`
**Claim map:** `tests.json` (every suite → the claim it defends, plus
`not_covered`)

Properties established by test rather than assertion:

| Property | Evidence |
|---|---|
| Recovery is byte-identical across calls, and independent of clock and record ids | `recovery.test.ts` |
| Protected state is never silently dropped at any budget from 4 000 to 500 chars | `recovery.test.ts`, `experiment.test.ts` |
| Nothing is ever deleted; a 6-deep supersession chain retains all 6 records | `model.test.ts` |
| Every superseded record has exactly one successor | `model.test.ts` |
| A record cannot be born inactive, and `transition` cannot fake supersession | `model.test.ts` |
| State and telemetry survive a real close/reopen of the file | `persistence.test.ts` |
| A v1 database migrates to v2 with data preserved; a newer-version file is refused | `persistence.test.ts` |
| Two connections and a second OS process share one ledger without loss | `concurrency.test.ts` |
| A rejected write leaves neither record nor event behind | `concurrency.test.ts` |
| 12 secret classes redacted on every write path, zero prose false positives | `redaction.test.ts` |
| Vanity metrics are absent from the implementation | `telemetry.test.ts` |

---

## 5. Design questions answered by measurement

Both of these were *changed by evidence*, which is the part worth reading.

### 5.1 The protection rule was arbitrary

The first protection rule was, in effect, "keep the important ones". The budget
sweep falsified it: at a 1 500-char budget the Postgres-vs-Redis architectural
decision — with its rationale and its benchmark — was dropped, while an advisory
constraint about British spelling survived. Critical sufficiency fell to 85.7%.

Replaced with a principled rule: **never drop state whose loss causes silent
incorrectness and which the agent cannot re-derive from the repository.** That
admits active decisions; it excludes findings (re-derivable by reading code) and
todos (re-derivable from acceptance criteria). Critical sufficiency is now 100%
at every budget, and the sweep is a regression test.

### 5.2 Determinism had to be defined before it could be tested

"Deterministic" was initially a slogan. Made into three testable claims —
byte-identical across calls, independent of wall-clock time, independent of
record ids — one of which immediately failed: the fingerprint hashed record ids,
so two ledgers holding identical state disagreed. It is now a *content*
fingerprint over rendered lines. `ordinal` exists as a schema column for the
same reason: ISO timestamps collide at millisecond resolution, and a collision
would make output order undefined.

---

## 6. Hypotheses and their status

| | Hypothesis | Status |
|---|---|---|
| **H1** | Structured task-state reinjection reduces constraint violations and repeated dead ends | **Untested.** RQ1 (its necessary condition) measured. Pre-registered in `docs/agentdev-experiment.md`. |
| **H2** | Deterministic selection suffices; no embeddings needed | **Supported for RQ1** — 100% critical sufficiency with lexical selection alone. Untested against a model re-ranker (registered as H3 there). |
| **H3** | Explicit recording beats automatic extraction | **Untested.** No extraction baseline exists. Design rationale only. |

---

## 7. What would change our mind

Falsification conditions, committed in advance:

1. **Recording coverage below 30% of sessions** in dogfood → the mechanism does
   not get used, and no server-side change can fix it. Kill.
2. **Prompt-only placebo matches the ledger** (B − C < 2 points) → the value is
   the discipline, not the tool. Ship a prompt; kill the server.
3. **Constraint violations do not fall** despite sufficient context → RQ1 does
   not transfer to RQ2, and reinjection is not the right intervention.
4. **Tokens per completed task rise more than 10%** → the cure costs more than
   the disease.
5. **Recovery-with-recording beats recording-alone by nothing** (arm D) → the
   value is in forcing the agent to articulate state, and recovery is
   ceremony.

---

## 8. Open research questions

1. **How much does recording discipline decay over a long task?** Everything
   here assumes a diligent Session A. This is the single most important unknown,
   and it is a behavioural question, not an engineering one.
2. **Does bounded reinjection beat unbounded?** We assume a smaller, ordered
   block beats a larger dump. Untested; `budget_chars` makes it directly
   testable.
3. **Does section *ordering* matter?** Reading order is fixed and unjustified by
   evidence.
4. **Is deterministic lexical ranking adequate at 10× the record count?**
   Untested past low tens.
5. **Can staleness be detected without repository access?** Findings carry
   `evidence` anchors; verifying them at recovery time would require file
   access, which C1 currently forbids. This is the most likely source of active
   harm from the tool.
6. **Does mandatory rationale suppress recording enough to hurt?** The friction
   is deliberate; its cost is unmeasured.
