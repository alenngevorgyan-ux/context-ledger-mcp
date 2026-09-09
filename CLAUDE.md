# CLAUDE.md — persistent context for Context Ledger MCP

Read this first. It is the standing brief for any session working in this
repository.

---

## Purpose

An MCP server that stores the small amount of structured task state a coding
agent must not lose across context compaction and session restarts, and
reconstructs it deterministically and within a character budget on resume.

The value of this project is **product thinking + MCP + agent reliability +
experiment design + requirements quality**. It is *not* visual polish, not a
frontend, and not "add an LLM so it looks AI-powered".

Read [PRODUCT.md](PRODUCT.md) before changing behaviour, and
[ARCHITECTURE.md](ARCHITECTURE.md) before changing structure.

**This repository is independent of AgentDev Lab. Never modify AgentDev Lab.**
`docs/agentdev-experiment.md` describes how this project could *later* be
evaluated by it; that is a specification, not an integration.

---

## Architecture in one screen

```
src/domain/types.ts      canonical record model, statuses, invariant constants
src/storage/db.ts        open + migrate (node:sqlite, WAL)
src/storage/migrations.ts forward-only, append-only migrations (user_version)
src/storage/store.ts     LedgerStore — THE write/read boundary; all invariants
src/redaction/redact.ts  secret detection + redaction (called from store)
src/recovery/select.ts   deterministic bounded selection  <-- the product
src/recovery/render.ts   text rendering of a selection
src/telemetry/metrics.ts derived metrics with declared observability
src/service.ts           LedgerService — used by MCP, CLI, tests, experiment
src/mcp/tools.ts         10 tool registrations (schemas are the agent's prompt)
src/mcp/server.ts        stdio server, resource, prompt, env config
src/cli/index.ts         demo / experiment / inspection commands
src/experiment/          scenario + harness for the session-reset measurement
src/test/                node:test suites (see tests.json)
```

Data model: `tasks`, `records` (one table, discriminated by `type`), `events`.

Everything above SQLite is pure and synchronous. **No network call, no model
call, no background work anywhere in this system.** Keep it that way.

---

## Setup

```bash
npm install          # no native deps; node:sqlite is built in
npm run build        # tsc -> dist/
npm test             # build + node --test (107 tests)

node dist/cli/index.js demo         # 5-minute walkthrough
node dist/cli/index.js experiment   # measured session-reset comparison
node dist/cli/index.js doctor       # environment + schema check
node dist/cli/index.js serve-info   # MCP host registration snippets
```

Requires Node ≥ 22.5. Developed on Node 24.18.

---

## Authoritative tests

`npm test` is the gate. [tests.json](tests.json) maps every suite to the
**claim it defends** and lists what is not covered.

| Suite | n | Defends |
|---|---|---|
| `model.test.ts` | 19 | record validation, supersession invariants, task isolation |
| `persistence.test.ts` | 6 | restart survival, v1→v2 migration, newer-version refusal |
| `redaction.test.ts` | 20 | 12 secret classes, zero prose false positives, every write path |
| `recovery.test.ts` | 17 | determinism, bounding, the protected set |
| `concurrency.test.ts` | 5 | two connections, a second OS process, rollback |
| `mcp.test.ts` | 18 | protocol-level conformance, tool contract, host regressions |
| `telemetry.test.ts` | 12 | one event per change, observability labels, no vanity metrics |
| `experiment.test.ts` | 10 | reproducibility, fair baseline, negative controls |

**Never weaken a test to get green.** If a test fails, either the code is wrong
or the claim was wrong — fix the code, or delete the claim from the docs *and*
from tests.json. A test that is relaxed to pass silently converts a guarantee
into a lie, and every document here cites these guarantees.

---

## Project constraints

These are decisions, not preferences. Changing one is a design change that
belongs in ARCHITECTURE.md, not a refactor.

1. **No LLM call in the server.** A memory layer that hallucinates is worse than
   none, and recovery runs at the top of every resumed session.
2. **No embeddings in the core path.** Deterministic selection; `overlapScore`
   in `select.ts` is the only seam a re-ranker may ever touch, and only for the
   `findings` section.
3. **Recovery is deterministic.** Same ledger state + same request →
   byte-identical output. No clock, no randomness, no id leakage into output.
4. **The protected set is never silently dropped.** Blocking constraints, unmet
   acceptance criteria, rejected approaches, active decisions. If they don't
   fit, declare `BUDGET EXCEEDED`. Never truncate them quietly.
5. **No destructive updates.** Content is immutable; meaning changes via
   `supersedes`. Nothing is deleted, ever.
6. **Redaction stays at the storage boundary** (`LedgerStore.write`,
   `createTask`), never in the transport layer.
7. **Zero native dependencies.** `node:sqlite` only. `npm install` must not need
   a compiler.
8. **Local-first.** No network egress. A ledger is the user's file.
9. **Keep the tool surface small.** Ten tools. Adding an eleventh needs a reason
   in ARCHITECTURE.md. Never add a generic "save note".
10. **No vanity metrics.** Records stored, MCP calls, tokens stored are banned
    and their absence is asserted by a test.

---

## Evidence discipline

This is the rule most likely to be violated by a well-meaning session.

- **Never fabricate user research.** There are no user interviews. Do not write
  one, do not imply one.
- **Never fabricate benchmark results.** Every number in the docs must be
  reproducible by a named command, or tagged as not measured.
- Use the tags: **[MEASURED]** / **[OBSERVED]** / **[HYPOTHESIS]** /
  **[ASSUMPTION]**. Existing documents use them; match that.
- The result tables in `docs/agentdev-experiment.md` are **empty on purpose**.
  Filling them in without a run log under `docs/evidence/` is fabrication.
- Distinguish **context sufficiency** (measured — a property of the resume
  artifact) from **agent behaviour** (not measured). Sufficiency is a necessary
  condition and an upper bound, never evidence of outcome. Several documents say
  this; if you find yourself softening it, stop.

---

## Progress discipline

- [progress.md](progress.md) holds the **exact** current state: what works, what
  is measured, what is not done, what is known-broken. Update it in the same
  commit as the work it describes, not afterwards.
- Commit at stable milestones with a message that says what changed and why.
  Do not leave stable work uncommitted.
- If a measurement changes, regenerate the artifacts under `docs/evidence/`
  and update every document that quotes the number. Numbers appear in README,
  PRODUCT.md, docs/prd-case-study.md and docs/interviewer-brief.md — grep for
  the old value.
- When a design flaw is found by measurement, record that fact rather than
  quietly fixing it. Two examples already in the repository: the protected set
  being corrected by the budget sweep, and the structured-output bug found by
  live agent integration. That provenance is part of the deliverable.

---

## Where to be careful

- `src/recovery/select.ts` — determinism and the protected set both live here.
  Any change needs `recovery.test.ts` and `experiment.test.ts` green, and the
  budget sweep still at 100% critical sufficiency.
- `src/storage/store.ts` — the invariants are enforced here on purpose so no
  caller can bypass them. Do not move validation up into the MCP layer.
- `src/mcp/tools.ts` — the descriptions are the agent's prompt. They are
  behaviour, not documentation. Edit them with the same care as code.
- Tool output must appear in **both** `content` text and `structuredContent`.
  Some hosts discard one. There is a regression test; do not "simplify" it away.
