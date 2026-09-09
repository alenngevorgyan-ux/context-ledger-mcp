# Hostile Self-Review

Three adversarial passes over the project, each trying to reject it. Findings
are split into **fixed** (with the commit-level change named) and
**accepted limitations** — things that cannot honestly be fixed at this stage and
are therefore written down instead of softened.

---

## Pass 1 — Skeptical staff engineer

> *"Show me the architecture theatre, the untestable claims, and the parts that
> only work in the demo."*

### Findings that were real, and fixed

**1.1 A record could be born superseded.** `write()` accepted an arbitrary
`status`, and `ALLOWED_STATUSES` permitted `superseded` for every type. A caller
could therefore create a record that was superseded by nothing — which destroys
the property recovery depends on ("the current decision is well defined").
**Fixed:** creation with any inactive status is refused. Test:
*"a record cannot be BORN superseded or invalidated"*.

**1.2 `transition()` could fake supersession.** Transitioning a record to
`superseded` produced the same successor-less state through a different door.
**Fixed:** that transition is refused with a message naming the two legitimate
paths (write a successor, or `invalidated`). Test:
*"transition cannot fake supersession"*.

**1.3 Task creation was not atomic with its event.** Invariant I7 says every
state change emits its event in the same transaction. `createTask` did two
autocommitted statements, so a crash between them would leave a task with no
`task_initialized` event, and the metrics denominator would be silently wrong.
**Fixed:** wrapped in `BEGIN IMMEDIATE`. Test: *"task creation is atomic with
its telemetry event"*.

**1.4 A test claimed something it did not test.** `recovery.test.ts` had a test
named *"output does not depend on wall-clock time"* which built both services
with the **same** injected clock. It asserted nothing. **Fixed:** the helper now
takes a start time and an id prefix, and the test compares two services with
different clocks *and* different id sequences.

**1.5 The determinism fingerprint was not reproducible across databases.** It
hashed record ids, so two ledgers holding identical state produced different
fingerprints — which made the experiment's reproducibility assertion fail for a
reason unrelated to the property being claimed. **Fixed:** it is now a *content*
fingerprint over rendered lines, and its scope is documented in the code as "not
a database identity".

**1.6 Dead configuration.** `OpenOptions.readOnly` was plumbed through and never
used by any caller — a code path with no test and no user. **Fixed:** removed.

### Accepted limitations

- **Selection is O(n) per recovery** over a task's records, with no
  index-assisted ranking. Untested past low tens of records. Listed in
  `tests.json` under `not_covered`.
- **`source` is caller-supplied.** An agent can claim `source: 'human'`. There
  is no authentication of assertions and adding one requires the host to sign
  turns. In `docs/failure-model.md` §8.
- **SQLite over a network filesystem is unsupported.** Concurrency is tested
  with two connections and a second local process; NFS is not tested and not
  claimed.

### Charges answered rather than accepted

- *"Ten tools is a bloated surface."* The alternative was measured against the
  actual failure mode: a required `rationale` field makes an unjustified
  decision impossible rather than discouraged, and the tool schema is the only
  prompt an agent reliably re-reads. The rejected designs (one `ledger_write`;
  verb × type ≈ 32 tools) are both named in ARCHITECTURE.md.
- *"The demo is special-cased."* It is not. `cmdDemo` calls the same
  `LedgerService` the MCP server calls; there is no demo-only code path.
  Verified by the fact that the live agent smoke tests produced identical
  behaviour through MCP.

---

## Pass 2 — Skeptical technical product manager

> *"Show me the fake evidence and the metrics that don't measure value."*

### Findings that were real, and fixed

**2.1 The headline experiment was near-tautological.** The first version had the
ledger scoring **100% on every probe** — unsurprising, since the probes were
written from Session A's own records. Presenting that as evidence of product
value would have been dishonest. **Fixed, three ways:**

- A **negative-control probe** for a fact Session A never established
  (`retry-after-value`). It fails in every condition, which demonstrates that
  the ledger does not invent knowledge. The overall score is now 93.8%, not
  100%, and the missing 6.2% is load-bearing.
- A **repository-only probe** (`partial-impl-location`) that the ledger cannot
  supply, plus a third condition (`ledger_only`, no repository) that fails it.
  This makes the "supplement, not replacement" claim falsifiable instead of
  rhetorical.
- Every document that quotes the number now says the informative figure is the
  **baseline's 0/7 on critical items**, and that the ledger column is closer to
  a self-consistency check.

**2.2 The baseline was at risk of being a strawman.** An empty or ticket-only
baseline would have manufactured the result. **Fixed:** the baseline carries the
full ticket *plus* the repository as Session A left it — partial
`src/limiter.ts`, its TODO comment, the commit message, the passing test suite —
and the ledger condition is `baseline + recovery`, additive rather than
substitutive. A test asserts the baseline satisfies probes on its own
(*"the baseline is a real baseline, not a strawman"*) and that the ledger
context is a strict prefix-extension of it.

**2.3 A metric was presented as measured when it is self-reported.**
`constraint_violation_rate` can only count what the agent *declares* in
`record_verification`; the server never sees the diff. **Fixed:** every metric
carries an `observability` field (`direct` / `partial` / `self_reported`), the
CLI prints the tag, and a test asserts that this particular metric stays
labelled `self_reported`.

**2.4 Metrics with no data reported `0`.** A zero repeated-failure rate on a task
with zero recorded failures reads as a success. **Fixed:** those metrics return
`null` with the denominator `n` exposed. Test: *"metrics with no data report
null, not a misleading zero"*.

**2.5 The vanity metrics were only *discouraged* in prose.** **Fixed:** a test
asserts `records_stored`, `total_records`, `mcp_calls` and `tokens_stored` are
absent from the implementation, so they cannot quietly become the number
someone optimises.

### Accepted limitations

- **There is no user research, and none is invented.** The failure taxonomy is
  first-principles plus one self-observed instance. This is the largest gap in
  the product case and is stated as such in PRODUCT.md, the PRD, and the
  interviewer brief.
- **The North Star is self-reported in production.** ARSR is only trustworthy in
  an evaluated setting where a harness grades the outcome. In production it is a
  *trend*, not an absolute. Stated in `docs/product-metrics.md`.
- **Activation is defined harshly on purpose.** A user who installs, records
  diligently, and never has a session reset is *not* activated — they paid the
  cost and got nothing. This will make the activation number look worse than a
  friendlier definition would.

---

## Pass 3 — Skeptical AI-agent researcher

> *"Your hypothesis is unfalsifiable, your MCP usage is decorative, and you
> haven't shown the mechanism does anything."*

### Findings that were real, and fixed

**3.1 The central claim was untested against a real host.** Protocol tests
against the SDK's in-memory transport are necessary but not sufficient.
**Fixed:** live integration against Claude Code 2.1.266 and Codex 0.153.4 — and
it immediately found a defect that 18 protocol tests had missed. When a tool
declares an `outputSchema`, Claude Code surfaces **only** `structuredContent` and
discards the text block; the reconstruction lived solely in the text block, so
the agent received a fingerprint and a character count. It correctly refused to
answer. The reconstruction is now in both payloads, with two regression tests.
Transcript, including the failure, in `docs/agent-integration.md`.

**3.2 The protection rule was arbitrary.** "Keep the important ones" was the real
rule, and the budget sweep exposed it: at a 1 500-char budget the
Postgres-vs-Redis architectural decision was dropped while an advisory
constraint about British spelling survived. **Fixed** with a principled rule —
*never drop state whose loss causes silent incorrectness and which the agent
cannot re-derive from the repository* — which admits active decisions and
excludes findings and todos, with the reasoning in the code comment. The sweep
is now a regression test asserting 100% critical sufficiency at every budget
from 4 000 down to 500 chars.

**3.3 Bounding was claimed without measuring its cost.** **Fixed:** the budget
sweep reports sufficiency at five budgets, so the tradeoff is visible rather
than asserted. It shows a real floor: protected state alone costs ~2 068 chars
on this scenario, and below that recovery goes over budget by design.

**3.4 "Deterministic" was underspecified.** **Fixed** into three testable
claims: byte-identical across repeated calls; independent of wall-clock time;
independent of record ids. Ties resolve on a total order `(score, ordinal, id)`,
and `ordinal` exists as a schema column precisely because ISO timestamps collide
at millisecond resolution.

### The charge that lands, and is not fixed

> **Context sufficiency is not agent behaviour.**

This is correct and it is the project's central limitation. Everything measured
here concerns the **artifact** — whether the resume context contains the state a
session needs. Nothing measured here shows that an agent handed that context
behaves better. An agent can be given a blocking constraint and violate it
anyway.

Sufficiency is a *necessary condition* and an *upper bound* on the outcome. The
response is not a better argument, it is an experiment: `docs/agentdev-experiment.md`
pre-registers a four-arm design with thresholds, failure treatment and an
explicit *inconclusive* band fixed **before** any run, and its result tables are
**empty**.

That design includes the arm a hostile reviewer should insist on: **prompt-only
placebo** — no server, but the agent is told to keep a `NOTES.md` of
constraints, decisions and dead ends and read it at session start. If the ledger
does not beat that, the value is the discipline rather than the tool, and the
correct product is a prompt. That arm exists because the answer might be no, and
a pre-registered failure condition says so in those words.

### Failure states that would invalidate the hypothesis

Stated plainly, because a project that cannot say how it would lose is not
making a claim.

1. **Agents don't record** (PRODUCT.md R1). The ledger is only as good as the
   discipline of the agent writing to it, and nothing inside the server can
   force recording. Pre-registered kill criterion: recording coverage below 30%
   of sessions.
2. **Recording happens but recovery is ignored.** Arm D exists to detect this.
3. **The nudge is the whole effect.** Arm C. Pre-registered: B − C < 2 points
   means ship the prompt and kill the server.
4. **Stale state actively harms.** If findings go wrong often enough, the tool
   becomes a source of the errors it exists to prevent. Findings are already the
   least-protected record type; the honest fix is staleness detection, which is
   not built.
5. **Host-native memory subsumes it.** Plausible. Note that context length alone
   does not address F1–F5, because compaction is lossy in the wrong direction.

---

## What this review changed, in summary

| # | Finding | Status |
|---|---|---|
| 1.1 | Record could be born superseded | Fixed + test |
| 1.2 | `transition` could fake supersession | Fixed + test |
| 1.3 | Task creation not atomic with its event | Fixed + test |
| 1.4 | A test asserted nothing | Fixed |
| 1.5 | Fingerprint not reproducible across databases | Fixed |
| 1.6 | Dead `readOnly` config path | Removed |
| 2.1 | Experiment near-tautological (ledger scored 100%) | Fixed: 2 negative controls + 3rd condition |
| 2.2 | Baseline risked being a strawman | Fixed + test |
| 2.3 | Self-reported metric presented as measured | Fixed: `observability` on every metric |
| 2.4 | Empty metrics reported misleading zeros | Fixed: `null` + exposed `n` |
| 2.5 | Vanity metrics only discouraged in prose | Fixed: absence asserted by test |
| 3.1 | Never tested against a real host | Fixed: 2 hosts; found and fixed a real bug |
| 3.2 | Protection rule arbitrary | Fixed: principled rule + regression test |
| 3.3 | Bounding cost unmeasured | Fixed: budget sweep |
| 3.4 | "Deterministic" underspecified | Fixed: 3 testable claims |
| — | No user research | **Accepted, documented** |
| — | Sufficiency ≠ behaviour | **Accepted, documented, experiment pre-registered** |
| — | Agents may never record | **Accepted; kill criterion pre-registered** |
| — | Pattern-based redaction misses unshaped secrets | **Accepted, documented** |
| — | Prompt injection can launder provenance | **Accepted, documented** |
| — | Scale untested past tens of records | **Accepted, documented** |
