# progress.md

Exact state of Context Ledger MCP. Updated in the same commit as the work it
describes.

**Last updated:** 2026-09-09
**Version:** 0.1.0
**Verified on:** Node v24.18.0, darwin x64, MCP SDK 1.30.0

---

## Status in one line

The mechanism is built, tested and verified against two real agent hosts. The
product hypothesis is **not tested** — that requires live agent runs, which are
pre-registered and not run.

---

## Final acceptance gate

| Gate | State | Evidence |
|---|---|---|
| Clean install works | ✅ | `npm install` — no native deps (`node:sqlite`) |
| Authoritative tests pass | ✅ | `npm test` → **107 tests, 107 pass, 0 fail** |
| MCP protocol-level tests pass | ✅ | 18 tests in `src/test/mcp.test.ts` over a real `Client`/`McpServer` pair |
| Persistence survives restart | ✅ | `persistence.test.ts` — close, reopen, identical fingerprint |
| Recovery deterministic where claimed | ✅ | `recovery.test.ts` — byte-identical; clock- and id-independent |
| Secret scan passes | ✅ | `context-ledger secret-scan` → 0 residual detections |
| Docs reflect actual implementation | ✅ | `tests.json` maps every suite to the claim it defends |
| No fabricated user research | ✅ | None exists; absence stated in PRODUCT.md, PRD, brief |
| No fabricated benchmark results | ✅ | Every number reproducible by a named command; raw output in `docs/evidence/` |
| No uncommitted stable work | ✅ | see git log |
| progress.md holds exact final state | ✅ | this file |
| Committed and pushed to origin/main | ✅ | see git log |

---

## What is implemented and verified

**State model** (`src/domain`, `src/storage`)
One `records` table discriminated by 8 types, plus `tasks` and `events`.
Enforced at the storage boundary so no caller can bypass: mandatory rationale on
decisions and rejected approaches; single-successor supersession (partial unique
index in the schema); no cross-task or cross-type supersession; inactive records
frozen; a record cannot be born inactive; `transition` cannot fake supersession;
nothing is ever deleted; every write emits its event in the same transaction.

**Storage** (`node:sqlite`, WAL)
Forward-only migrations via `user_version`; v1→v2 exercised against a real v1
database; a newer-version file is refused rather than misread. `BEGIN IMMEDIATE`
on every write; monotonic `ordinal` for a total order. Verified with two
connections, 40 interleaved writes, and a second OS process.

**Secret hygiene** (`src/redaction`)
Runs at the storage boundary, not the transport. 12 credential classes plus an
entropy detector on assignment right-hand sides. `content`, `rationale`,
`evidence` and the task objective all scrubbed. `redact` / `reject` / `off`
modes. Per-record redaction count surfaced as a guardrail metric.
`secret-scan` re-scans everything already stored.

**Context recovery** (`src/recovery`) — the product
Deterministic bounded reconstruction across nine sections. Byte-identical for a
given ledger state; independent of clock and record ids; ties broken on a total
order. Protected set (blocking constraints, unmet acceptance criteria, rejected
approaches, active decisions) never silently dropped — over-budget is declared
instead. Every omission counted inline; empty sections explicit.

**MCP server** (`src/mcp`)
10 tools, 1 resource (`ledger://task/{id}/recovery`), 1 prompt (`resume_task`),
server instructions telling the agent *when* to recover. Domain errors return a
machine-readable code rather than a protocol exception. Payloads present in both
text and structured content.

**Telemetry** (`src/telemetry`)
8 derived metrics, each declaring `observability` (direct / partial /
self_reported) and carrying an interpretation note. Metrics with no data return
`null` with the denominator exposed. Vanity metrics absent by test.

**Experiment harness** (`src/experiment`)
Reproducible session-reset scenario, 16 deterministic probes including two
negative controls, three conditions, budget sweep.

**CLI** (`src/cli`)
`demo`, `experiment`, `serve-info`, `tasks`, `state`, `recover`, `history`,
`metrics`, `events`, `secret-scan`, `doctor`. No demo-only code path — the demo
calls the same service the MCP server calls.

---

## What is measured

`node dist/cli/index.js experiment` — raw output in `docs/evidence/`.

| Condition | All 16 probes | 7 critical probes |
|---|---|---|
| baseline (ticket + repo as Session A left it) | 3/16 = 18.8% | **0/7 = 0%** |
| ledger recovery only, no repo | 14/16 = 87.5% | 7/7 = 100% |
| ledger + repo | 15/16 = 93.8% | 7/7 = 100% |

Reconstruction cost 2 996 chars. Critical sufficiency holds at 100% down to a
500-char budget; protected state alone floors at ~2 068 chars.

**Live integration** (`docs/agent-integration.md`): Claude Code 2.1.266 and
Codex 0.153.4 both drove the server correctly against the same ledger file. A
fresh Claude Code process, given only a task id, recovered a blocking constraint
and a rejected approach from a session it never saw.

**How to read the table honestly:** the informative figure is the baseline's
0/7. The ledger column is closer to a self-consistency check, because the probes
were authored from Session A's own records. See RESEARCH.md §2.

---

## What is NOT done

1. **The product hypothesis is untested.** Context sufficiency is measured;
   agent *behaviour* is not. Sufficiency is a necessary condition and an upper
   bound. Pre-registered design with empty result tables:
   `docs/agentdev-experiment.md`.
2. **No user research.** None exists and none is invented. Largest gap in the
   product case.
3. **Unprompted recovery invocation untested.** All four live sessions were told
   they were resuming.
4. **No staleness detection.** A finding that goes false stays in the ledger;
   the server has no repository access by design. Most likely source of active
   harm from the tool.
5. **No semantic conflict detection** between two live constraints.
6. **Scale untested** past low tens of records per task; selection is O(n).
7. **No model-based re-ranker**, and no evidence it is needed. The seam is
   `overlapScore` in `src/recovery/select.ts`; the evidence that would justify
   it is registered as H3.
8. **Repository-scoped constraints not implemented** — constraints live and die
   with a task. PRODUCT.md open question 3.
9. **Networked SQLite unsupported and untested.**
10. **`source` is caller-supplied** — an agent can claim `human`. No
    authentication of assertions.

---

## Known limitations, not bugs

- Redaction is pattern-based. It catches *shaped* secrets, not a password that
  reads like an English phrase. Deliberately biased toward false positives.
- Prompt injection can launder provenance: hostile repository text recorded as a
  constraint becomes protected state. Mitigated by provenance display only.
  `docs/failure-model.md` §4.
- The protected set is bounded by per-section caps (40 constraints, 20
  decisions). A task exceeding them overflows loudly rather than silently — a
  signal the task should be split.
- Registering a project-scoped MCP server in Claude Code needs an interactive
  approval. Real onboarding friction; the headless `--mcp-config` path avoids it.

---

## Known-broken

Nothing known-broken. 107/107 tests pass; `secret-scan` clean.

---

## Bugs found and fixed during construction

Kept because the provenance is part of the deliverable — both were found by
measurement or live testing, not by design.

1. **Host discards tool text content.** Claude Code surfaces only
   `structuredContent` when a tool declares an `outputSchema`; the
   reconstruction lived solely in the text block, so a real agent received a
   fingerprint and a character count and correctly refused to answer. 18
   protocol tests had passed. Fixed; 2 regression tests.
2. **Protection rule was arbitrary.** The budget sweep showed an architectural
   decision being dropped at 1 500 chars while an advisory spelling constraint
   survived. Replaced with a principled rule; sweep is now a regression test.
3. **Three invariant holes** reachable through the public store API: a record
   could be born `superseded`; `transition` could reach `superseded` without a
   successor; task creation was not atomic with its event. All fixed with tests.
   `docs/hostile-review.md` §1.
4. **A test that asserted nothing** — the clock-independence test used the same
   clock twice. Fixed to be real.
5. **Fingerprint not reproducible across databases** — it hashed record ids.
   Now a content fingerprint.

---

## Immediate next steps, in order

1. **Dogfood to measure recording coverage.** This tests R1/A1, the assumption
   the entire product rests on. Everything else is premature until it clears.
2. **Talk to engineers who supervise long agent tasks.** Close the user-research
   gap before building more.
3. **Decide whether recovery should be a host hook** rather than a tool the
   agent chooses to call (open question 2).
4. **Run the pre-registered A/B**, including the prompt-only placebo arm.
5. **Prototype staleness signalling** on findings whose `evidence` anchor no
   longer resolves.

---

## Repository layout

```
README.md ARCHITECTURE.md PRODUCT.md RESEARCH.md CLAUDE.md progress.md tests.json
src/{domain,storage,redaction,recovery,telemetry,mcp,cli,experiment,test}/
docs/{product-metrics,failure-model,agentdev-experiment,prd-case-study,
      interviewer-brief,agent-integration,hostile-review}.md
docs/evidence/{experiment-output.txt,experiment-result.json,demo-output.txt,
               test-output.txt}
```

**AgentDev Lab is a separate repository and was not modified.**
