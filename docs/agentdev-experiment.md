# Pre-registered Experiment: Baseline Agent vs. Agent + Context Ledger

**Status: PRE-REGISTRATION. No results. All result tables below are empty on
purpose and must stay empty until the runs actually happen.**

This document is written to be evaluable by AgentDev Lab. **AgentDev Lab is a
separate repository and is not modified by this project.** What follows is the
specification an evaluation harness would need; Context Ledger deliberately
exposes the interfaces that make it runnable (a scriptable MCP server, a
deterministic recovery call, and a machine-readable event log).

Written and registered **before** any run: 2026-09-09.

---

## 1. Why this is needed

`context-ledger experiment` measures **context sufficiency** — whether the
resume context contains the state a session needs. That is a property of an
artifact, and it is a *necessary condition* for the hypothesis. It says nothing
about whether an agent handed sufficient context actually behaves better. An
agent can be given a blocking constraint and violate it anyway.

This experiment measures behaviour. It is the only thing that can promote H1
from hypothesis to finding.

---

## 2. Hypotheses

**H1 (primary, confirmatory).** An agent with Context Ledger, resuming a task
after a context reset, produces fewer **constraint violations** and fewer
**repeated rejected approaches** than the same agent resuming from repository
state and the original ticket alone.

**H2 (primary, confirmatory).** Task success rate on multi-session tasks is
higher with Context Ledger than without.

**H3 (secondary).** Deterministic lexical selection is not inferior to a
model-based re-ranker on recovery quality. *(Powers the decision in
ARCHITECTURE.md §3. If H3 is rejected, add the optional re-ranking layer at the
`overlapScore` seam.)*

**H4 (secondary, mechanism-vs-nudge).** The benefit is not fully explained by
the instruction to write things down. Formally: arm B beats arm C.
*If H4 fails, the correct product is a prompt, not a server.* This is the arm a
skeptical reviewer will ask for, and it is included deliberately.

**H0 for each: no difference.**

---

## 3. Design

Four arms, between-subjects on tasks, within-model.

| Arm | Resume condition |
|---|---|
| **A — baseline** | Original ticket + repository state. Host-native compaction only. |
| **B — ledger** | A + Context Ledger MCP server, server instructions active. |
| **C — prompt-only placebo** | A + instruction to maintain `NOTES.md` with constraints, decisions and dead ends, and to read it at session start. No server. |
| **D — ledger, no recovery** | Ledger server installed and recorded to, but `ledger_recover_context` disabled at resume. Isolates *recording discipline* from *reinjection*. |

A and B answer "does it work". C answers "is it the tool or the discipline". D
answers "is it the recording or the recovery".

**Randomisation.** Task × arm, stratified by task family and by number of forced
resets, so no arm draws easier tasks. Seeds fixed and recorded.

**Blinding.** Grading is automated. The grader receives the final diff, the
transcript and the task spec, and **not** the arm label. Any human adjudication
of ambiguous cases is done on arm-stripped records.

---

## 4. Task set

Twelve tasks minimum, three per stress family. Each task ships with machine-
checkable ground truth: a constraint set, an acceptance test suite, and a
registry of known dead ends.

| Family | Stresses | Task shape |
|---|---|---|
| **F-CONSTRAINT** | constraint retention | A blocking constraint is stated once, early (ticket thread or `CONTRIBUTING.md`), and never repeated. The naive solution violates it. *Example: implement rate limiting; the obvious answer is Redis; a new runtime dependency is forbidden.* |
| **F-DEADEND** | rejected-approach memory | The task has an attractive approach that fails for a non-obvious reason discoverable only by trying it. Session A is forced to discover and reject it. |
| **F-MULTISTAGE** | multi-stage work | Four or more dependent stages, each requiring the previous stage's decisions. Resets forced between stages. |
| **F-ARCHDECISION** | decision consistency | Requires an architectural choice in stage 1 that stages 3 and 4 must remain consistent with; both later stages have a locally attractive inconsistent option. |

**Forced context reset.** The harness kills the session and starts a new process
at scripted checkpoints. Not compaction — a hard boundary, so the manipulation
is unambiguous and identical across arms.

**Task authoring rule.** Tasks are authored against arm A only, before arm B
exists for that task, by someone who has not read the ledger's tool descriptions.
This is the guard against writing tasks that happen to suit the ledger's record
types. **Ground truth is never derived from what Session A recorded** — that is
the tautology the offline probe experiment has to live with, and this design must
not inherit it.

---

## 5. Metrics

### Primary (confirmatory, graded from artifacts, not self-report)

| Metric | Definition | Grading |
|---|---|---|
| **CVR** — constraint violation rate | violations of the ground-truth constraint set per completed task | Static check / test against the final diff |
| **RDE** — repeated dead ends | attempts, post-reset, at an approach the task registry marks rejected AND that this run already rejected pre-reset | Transcript matcher over the dead-end registry, with human adjudication of the ambiguous 10% |
| **TSR** — task success rate | acceptance suite passes AND CVR = 0 | Test run |

### Secondary

| Metric | Definition |
|---|---|
| Redundant file reads | reads of a file already read pre-reset, no intervening write |
| Time to first useful edit | reset → first edit retained in the final diff |
| Tokens per completed task | total, both arms |
| Human interventions | scripted-operator unblocks per task |
| Acceptance criteria missed | ground-truth criteria unmet at termination |
| Recovery utilisation | arm B/D only: recovery calls per resumed session |
| Recording coverage | arms B/C/D: sessions writing ≥ 1 decision or dead end |

### Guardrails

- Tokens per completed task in B must not exceed A by more than 10%.
- p95 recovery latency ≤ 50 ms.
- Zero credentials in any ledger file at run end (`context-ledger secret-scan`).

---

## 6. Acceptance thresholds — set now, before any data

H1 and H2 are **confirmatory** and are tested at α = 0.05 with
Holm–Bonferroni correction across the two primaries. H3 and H4 are
**exploratory-secondary**, reported with confidence intervals and explicitly not
corrected — no claim of significance is made from them.

| Hypothesis | Supported if | Rejected if |
|---|---|---|
| **H1** | CVR reduction ≥ 30% relative, AND RDE reduction ≥ 30% relative, both with 95% CI excluding zero | Either point estimate < 10% relative, or CI includes zero |
| **H2** | TSR improvement ≥ 10 percentage points, CI excluding zero | < 3 points, or CI includes zero |
| **H3** | Re-ranker's TSR does not exceed deterministic by > 5 points | Re-ranker exceeds by > 5 points → build the optional layer |
| **H4** | B beats C on TSR by ≥ 5 points | B − C < 2 points → the value is the discipline; ship a prompt |

**Ambiguous zone (10–30% on H1, 3–10 points on H2)** is pre-declared
**inconclusive**. It will be reported as inconclusive and will not be narrated
into a win.

**Power.** 12 tasks × 3 seeds = 36 runs per arm detects a ~25-point TSR
difference at 80% power — enough for H2 but **underpowered for H1's rate
metrics**. If H1's confidence intervals include zero at n = 36, the pre-declared
conclusion is *"underpowered"*, not *"no effect"*, and the follow-up is
30 tasks × 5 seeds = 150 runs per arm.

---

## 7. Failure treatment — declared in advance

| Situation | Treatment |
|---|---|
| Run crashes for harness reasons (infra, rate limit, timeout) | Excluded, logged with reason, re-run with the same seed. Exclusion rate reported per arm; **> 10% asymmetry between arms invalidates the comparison.** |
| Agent gives up and says so | Counted as a **failure**, not excluded. Giving up is an outcome. |
| Agent writes nothing to the ledger in arm B | **Retained.** Intention-to-treat. This is R1 materialising, and dropping it would measure the product under conditions that do not exist. |
| Ambiguous constraint violation | Two independent human graders on arm-stripped records; disagreements resolved by a third; inter-rater agreement reported. |
| Ledger corrupted mid-run | Run excluded, reported as a **product defect**, not a task failure. |
| Ground-truth error found mid-experiment | The task is removed from **all** arms and the removal is reported. Never removed from one arm. |

**Analysis plan is fixed now.** Two-proportion tests for TSR, negative-binomial
for count metrics (CVR, RDE) with task as a random effect. No metric will be
added, and no subgroup will be defined, after seeing data. Any post-hoc analysis
is labelled exploratory and cannot support a claim.

**No peeking.** No interim analysis. Results are read once, after all runs.

---

## 8. Results

**Not run. Nothing to report.**

| Metric | A baseline | B ledger | C prompt-only | D no-recovery |
|---|---|---|---|---|
| TSR | — | — | — | — |
| CVR | — | — | — | — |
| RDE | — | — | — | — |
| Tokens/task | — | — | — | — |
| Time to first useful edit | — | — | — | — |
| Redundant file reads | — | — | — | — |
| Recording coverage | n/a | — | — | — |
| Recovery utilisation | n/a | — | n/a | 0 by construction |

Any table in this repository that is filled in without a corresponding run log
under `docs/evidence/` should be treated as fabricated.

---

## 9. What Context Ledger already provides to a harness

Not aspiration — these exist and are tested:

- **Scriptable MCP server** over stdio; `context-ledger serve-info` prints host
  registration for Claude Code and generic `mcpServers` JSON.
- **Deterministic recovery**, so arm B's resume context is reproducible and can
  be diffed across runs (content fingerprint on every call).
- **Machine-readable event log** — `context-ledger events --task <id>` — with a
  session id on every event, which is how recovery utilisation and recording
  coverage are computed without instrumenting the host.
- **`ledger_recover_context` can be withheld** via `--allowedTools`, which is
  exactly how arm D is constructed. Verified in the live smoke test.
- **Offline scenario harness** (`src/experiment/`) with the probe format the
  live grader can reuse for its acceptance checks.

## 10. Known limitations of this design

1. **Cost.** Four arms × 12 tasks × 3 seeds = 144 multi-session agent runs.
   Materially expensive. If only two arms are affordable, run **A and B**; but
   note that without C, a positive result cannot distinguish the tool from the
   nudge, and the write-up must say so.
2. **Task authoring is the weakest link.** Ground truth authored by the same
   people who built the ledger risks measuring the ledger's own ontology. The
   arm-A-first authoring rule mitigates but does not eliminate this.
3. **Transcript-based RDE grading is imperfect.** "Attempted an approach" is a
   judgement call; hence adjudication and reported inter-rater agreement.
4. **One model family.** Results may not transfer. Replication on a second model
   is a follow-up, not part of this registration.
5. **Forced hard resets are not compaction.** Real-world context loss is lossy
   summarisation, which is *partially* informative. Hard resets are the cleaner
   manipulation and the stronger treatment; they likely **overstate** the effect
   relative to compaction, and that direction of bias is stated here rather than
   discovered later.
