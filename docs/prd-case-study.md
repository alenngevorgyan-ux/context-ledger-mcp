# PRD — Context Ledger

| | |
|---|---|
| **Status** | Draft for engineering review |
| **Author** | Product |
| **Date** | 2026-09-09 |
| **Reviewers** | Agent Platform eng, Security, Developer Productivity |
| **Decision requested** | Approve a 6-week build to a gated A/B, or reject |

---

## 1. Problem statement

Coding agents lose task state on long work. Not source code — that is on disk —
but the reasoning layer around it: constraints stated once, approaches already
tried and abandoned, decisions and the reasons behind them, questions still
owed to a human.

When a session is compacted or restarted, that layer is gone. The agent either
re-derives it (token cost, wall-clock cost) or proceeds without it (wrong
output). The second is the expensive one, because it is silent: an agent that
has forgotten "no new runtime dependencies" does not hesitate.

**This is not fixed by a larger context window.** A window ten times bigger
still eventually compacts, and compaction is lossy in exactly the wrong
direction — a summary that says "we discussed rate-limiting approaches" has
already destroyed the fact that one of them was tried and failed.

---

## 2. Evidence vs. assumptions

**This section exists so the rest of the document cannot be read as more
grounded than it is.**

### Measured (reproducible in this repository)

| Finding | Value | How to reproduce |
|---|---|---|
| A fresh session on a realistic multi-stage task has **none** of the critical state it needs, from ticket + repository alone | 0 / 7 critical items | `context-ledger experiment` |
| Overall state availability, baseline | 3 / 16 = 18.8% | same |
| With ledger recovery added | 15 / 16 = 93.8%; 7 / 7 critical | same |
| Cost of that context | 2 996 characters | same |
| Critical state survives budget compression to 500 chars | 100% at every budget | same (sweep) |
| A live Claude Code session, given only a task id, correctly recovered a constraint and a dead end from a session it never saw | pass | `docs/agent-integration.md` |
| The same ledger drove Codex correctly | pass | same |
| Secret redaction across 12 credential classes, zero false positives on engineering prose | 20 tests | `npm test` |

### Observed (single instances, not studies)

- A live agent handed a metadata-only recovery payload **refused to guess** and
  said the ledger returned nothing. Useful: the failure mode was loud.
- Registering a project-scoped MCP server in Claude Code requires an
  interactive approval — real onboarding friction.

### Assumptions (would change the design if wrong)

- **A1** Agents will record durable state if the tool schema makes it cheap and
  the description says when. *Untested.* This is the load-bearing assumption.
- **A2** Agents will call recovery at the start of a resumed session. *In four
  live sessions they did — but each was prompted that it was resuming.*
- **A3** ~4 KB is an affordable context budget for a resume.
- **A4** Per-task isolation is correct; repository-level constraints are not
  needed in v1.

### Explicitly absent

- **No user interviews. No usage data. No production telemetry.** The failure
  taxonomy is derived from first principles and one self-observed instance.
  This is the largest gap in the case, and the first thing to close.

### The honest caveat on the headline number

The 18.8% → 93.8% comparison measures **context sufficiency** — whether the
state is *present in the resume context*. It does not measure whether an agent
given that context behaves better. Sufficiency is a necessary condition and an
**upper bound**. The probes were also authored from Session A's own records, so
the ledger side is closer to a self-consistency check than to evidence of value;
two negative-control probes (one fact never recorded, one repository-only fact)
are included to keep it honest, and both correctly fail. **The informative half
of that table is the baseline's 0/7.**

---

## 3. User scenario

Priya is four hours into adding rate limiting. She has told the agent once, in
passing, that the team does not add runtime dependencies. The agent has tried
enforcing limits at the nginx layer and abandoned it after discovering nginx
cannot see the API key. It has settled on sharing counters through the existing
Postgres connection. Two of five todos are done.

Her session is compacted.

**Today:** the agent proposes Redis — the textbook answer. Priya re-explains the
constraint. Twenty minutes later it proposes nginx. She re-explains that too.
She has now spent more time managing the agent's memory than reviewing its code,
and her trust in leaving it unattended is gone.

**With Context Ledger:** the agent's first call is
`ledger_recover_context`. It receives ~3 KB: the objective verbatim, the
blocking no-dependency constraint with its source, the two rejected approaches
with the measurements that killed them, the Postgres decision with its reason,
the three remaining todos, the open question about internal tokens, and the last
verification state. It continues from todo three.

---

## 4. Goals

| # | Goal | Measure |
|---|---|---|
| G1 | A resumed session starts with the state it needs | Context sufficiency ≥ 90% of critical items on the benchmark set |
| G2 | Recovery is affordable | p95 reconstruction ≤ 4 KB; p95 latency ≤ 50 ms |
| G3 | Recovery is trustworthy | Deterministic; protected state never silently dropped; both tested |
| G4 | The ledger never becomes a credential store | Zero unredacted secrets; `secret-scan` clean |
| G5 | Decisions are auditable | Every superseded decision retrievable with rationale and provenance |
| G6 | Ship a decision-grade A/B | Powered experiment run to the pre-registered thresholds |

---

## 5. Non-goals

- Generic or long-term memory across tasks.
- Vector search or embeddings in v1.
- Any UI beyond a CLI.
- Automatic extraction of state from transcripts (v1 is explicit recording;
  extraction produces plausible state nobody asserted).
- Replacing the repository as the source of truth.
- Hosted or multi-tenant operation.

---

## 6. Functional requirements

**Must (v1 — all implemented)**

| # | Requirement |
|---|---|
| FR1 | Initialise a task with a verbatim objective, acceptance criteria, constraints |
| FR2 | Record: constraint, acceptance criterion, decision, rejected approach, finding, open question, todo, verification |
| FR3 | Reject a decision or rejected approach submitted without a rationale |
| FR4 | Supersede a record; retain the prior version with full provenance |
| FR5 | Return a bounded reconstruction of task state |
| FR6 | Reconstruction is deterministic for a given ledger state |
| FR7 | Never silently drop blocking constraints, unmet acceptance criteria, rejected approaches, or active decisions; declare over-budget instead |
| FR8 | Redact secret-shaped content at the storage boundary, on every write path |
| FR9 | Emit one telemetry event per state change, in the write transaction |
| FR10 | Survive restart; support concurrent writers on one machine |
| FR11 | Forward-only schema migration; refuse a newer-version file |
| FR12 | Expose all of the above over MCP with typed schemas |

**Should (v1.1)** — repository-scoped constraints outliving tasks; a
`ledger_check` pre-flight the agent calls before committing; staleness signalling
on findings whose `evidence` anchor no longer resolves.

**Won't (v1)** — cross-task search; embeddings; team-shared ledgers; a web UI.

---

## 7. Technical constraints

| # | Constraint | Rationale |
|---|---|---|
| TC1 | Local-first; no network egress from the server | A ledger is the user's file. Also removes the entire network threat surface. |
| TC2 | Zero native dependencies (`node:sqlite`, Node ≥ 22.5) | `npm install` must not fail on a compiler toolchain. |
| TC3 | No LLM call inside the server | A memory layer that hallucinates is worse than none, and this call sits at the top of every resumed session. |
| TC4 | Recovery deterministic and synchronous | Debuggability is a product property here, not an engineering preference. |
| TC5 | No destructive updates | "Why did this change?" must be answerable. |
| TC6 | Redaction at the storage boundary, not the transport | No future transport can bypass it. |
| TC7 | Reconstruction present in both text and structured tool output | Hosts discard one or the other; learned in live testing. |

---

## 8. Success metrics

**North Star: Assisted Resume Success Rate** — resumed sessions reaching a
passing verification with no recorded-constraint violation and no repeated dead
end. Full tree in `docs/product-metrics.md`.

| Layer | Metric | v1 target |
|---|---|---|
| Activation | Task resumed ≥ 1× with recovery, and that session wrote a record | 40% of installs within 2 weeks |
| Leading | Recording coverage (sessions writing ≥ 1 decision or dead end) | ≥ 50% |
| Leading | Recovery utilisation (recoveries / resumed session) | ≥ 0.8 |
| Leading | Context sufficiency, benchmark | ≥ 90% critical |
| Lagging | ARSR | +10 points vs. control |
| Retention | Repo-level week-4 | ≥ 50% of activated repos |

Deliberately not tracked: records stored, MCP calls, tokens stored. Each rises
when the product is used *badly*. Their absence is enforced by a test.

---

## 9. Guardrails

| Guardrail | Threshold | Response if breached |
|---|---|---|
| Tokens per completed task vs. control | ≤ +10% | Block rollout |
| p95 recovery latency | ≤ 50 ms | Block rollout |
| p95 reconstruction size | ≤ 4 KB | Tune caps |
| Unredacted credentials in any ledger | 0 | **Halt. Security incident.** |
| `redacted_record_rate` sustained > 0 | — | Investigate agent behaviour |
| Records per task p95 | ≤ 60 | Tighten tool descriptions |
| `decision_supersession_rate` | ≤ 0.4 | Ledger being used as a scratchpad |

---

## 10. Acceptance criteria

1. Clean clone → `npm install && npm test` green on Node ≥ 22.5, no native
   toolchain. **✅**
2. Protocol-level MCP conformance against a real client/server pair. **✅ 18 tests**
3. Recovery byte-identical across calls; independent of clock and record ids. **✅**
4. Protected state never silently dropped; over-budget declared in the output. **✅**
5. 12 secret classes redacted on every write path; zero false positives on the
   prose corpus; `secret-scan` clean. **✅**
6. State survives restart; two connections and a second OS process share one
   ledger without loss. **✅**
7. Live agent integration on ≥ 2 independent hosts. **✅ Claude Code + Codex**
8. Every metric declares its observability. **✅**
9. Powered A/B meeting pre-registered thresholds. **❌ Not run — this is the gate.**

Criteria 1–8 are met. **9 is the release gate and is deliberately open.**

---

## 11. Rollout

**Phase 0 — internal dogfood (2 weeks).** Ship to the agent-platform team's own
repositories. Success = recording coverage ≥ 50%. *This phase primarily tests
A1, the assumption the whole product rests on.* If agents do not record, stop
here; the remaining phases are wasted.

**Phase 1 — closed beta (4 weeks, ~20 repositories).** Opt-in, selected for long
tasks. Collect activation, retention, guardrails. No efficacy claims made.

**Phase 2 — gated A/B (4 weeks).** Per `docs/agentdev-experiment.md`.
Randomise by repository. Include the prompt-only arm; without it a positive
result cannot distinguish the tool from the nudge.

**Phase 3 — general availability.** Only if Phase 2 clears the thresholds.
Default off; opt-in per repository. Default-on is a separate decision requiring
its own guardrail review.

**Kill criteria — pre-committed:**
- Recording coverage < 30% in Phase 0 or 1 → **kill**. The mechanism does not
  get used.
- Any unredacted credential found in a real ledger → **halt**, fix, restart
  Phase 1.
- Phase 2 shows B ≈ C → **ship the prompt, kill the server.**
- Phase 2 inconclusive with adequate power → **do not ship**; publish the null.

---

## 12. Experiment

Pre-registered in full at `docs/agentdev-experiment.md`: four arms (baseline /
ledger / prompt-only / ledger-without-recovery), 12 tasks across four stress
families, hard context resets at scripted checkpoints, blinded automated
grading, thresholds and failure treatment fixed in advance, and an explicit
"inconclusive" band that cannot be narrated into a win.

---

## 13. Risks

| # | Risk | Sev | Mitigation | Residual |
|---|---|---|---|---|
| R1 | **Agents don't record.** No mitigation inside the server can force it. | **Critical** | Mandatory rationale; instructions; coverage metric; Phase 0 gate | **High. This is the one that kills the product.** |
| R2 | Sufficiency doesn't convert to behaviour | High | Pre-registered A/B; prompt-only arm | High until Phase 2 |
| R3 | Stale state trusted over the repo | High | Advisory framing in every reconstruction; evidence anchors; findings least protected | Real; server has no repo access by design |
| R4 | Prompt injection stored as a constraint | High | Provenance on every record; rendered inline; nothing deleted | Real; v1.1 should require `source: human` for protected constraints |
| R5 | Secret leakage | High | Boundary redaction, 12 classes, reject mode, re-scan tool | Pattern-based; misses unshaped secrets |
| R6 | Over-recording degrades quality | Med | Caps; duplicate detection; instructions | Retrospective only |
| R7 | Host incompatibility | Med | Found and fixed in live testing; regression tests | Closed for 2 hosts; unknown for others |
| R8 | Obsolescence via better host-native memory | Med | None available | Real. Note that context length alone does not address the failure modes; lossy compaction does. |

---

## 14. Open questions for engineering review

1. Should recovery be a **host hook** rather than a tool the agent must choose
   to call? A2 is unverified for unprompted sessions, and a hook would remove
   the dependency entirely.
2. Are repository-scoped constraints v1.1 or v1? A1's failure mode is partly
   "the agent didn't record a constraint that is true of every task in this
   repo".
3. Is 4 KB the right default budget, or should it scale with the host's window?
4. Who owns conflict resolution between two live constraints — the agent, or an
   escalation to a human?
5. Can the harness for Phase 2 reuse AgentDev Lab without modifying it?
