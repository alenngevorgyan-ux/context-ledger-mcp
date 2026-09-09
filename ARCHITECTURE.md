# Architecture

```
                 agent host (Claude Code / Codex)
                              │  MCP stdio, JSON-RPC
                              ▼
        ┌──────────────────────────────────────────┐
        │  src/mcp/            10 tools            │
        │    server.ts         1 resource          │  schemas + host contract
        │    tools.ts          1 prompt            │
        └───────────────┬──────────────────────────┘
                        │
        ┌───────────────▼──────────────────────────┐
        │  src/service.ts                          │  the only thing the CLI,
        │  LedgerService                           │  the tests and the
        └───┬──────────────┬───────────────┬───────┘  experiment also use
            │              │               │
   ┌────────▼───────┐ ┌────▼──────────┐ ┌──▼─────────────┐
   │ recovery/      │ │ storage/      │ │ telemetry/     │
   │  select.ts     │ │  store.ts     │ │  metrics.ts    │
   │  render.ts     │ │  migrations   │ │                │
   │                │ │  db.ts        │ │                │
   │ deterministic  │ │       │       │ │ derived, with  │
   │ bounded        │ │  redaction/   │ │ observability  │
   │ selection      │ │   redact.ts   │ │ declared       │
   └────────────────┘ └───────┬───────┘ └────────────────┘
                              ▼
                      node:sqlite (WAL)
                    tasks · records · events
```

Everything above the database is pure and synchronous. There is no network
call, no model call, and no background work anywhere in the system.

---

## The five decisions that matter

### 1. One record table, not a knowledge graph

`records` is a single table with a discriminated `type` and shared provenance
columns. Rejected: a node/edge model with typed relationships.

*Why.* The product question is "what must an agent know to continue this task
correctly?" — which is a **bounded list**, not a traversal. A graph buys
multi-hop queries that recovery never issues, and it costs a schema that every
future record type has to negotiate with. One table also makes the ordering
guarantee trivial: a single monotonic `ordinal` column is a total order over all
state, which is what makes recovery deterministic.

*What this forecloses.* Genuine relationship queries ("which decisions depend on
this finding?"). If that becomes a real need, it is a migration, not a rewrite —
`supersedes` already demonstrates the shape a typed edge would take.

### 2. Supersession instead of mutation

Content is immutable. Changing what a record *says* requires writing a new
record that `supersedes` the old one; the old one is retained with status
`superseded`. Only lifecycle status may change in place (todo → done,
question → resolved), and that transition is itself an event.

Enforced invariants, all in `src/storage/store.ts` so no caller can bypass them:

- **I2** a record may be superseded at most once — a partial unique index in the
  schema, not application logic. Without it, chains fork and "the current
  decision" stops being a well-defined thing.
- **I3** supersession cannot cross tasks.
- **I4** an inactive record cannot be superseded again; supersede its successor.
- **I5** status must be legal for the type (`ALLOWED_STATUSES`).
- **I6** nothing is ever deleted.
- **I7** every write emits its telemetry event in the same transaction, so the
  event log cannot disagree with the state it describes.

*Why it matters to the product.* "Why did this change?" is one of the named
failure modes. A mutable store answers it with silence.

### 3. Deterministic selection, no embeddings

Recovery ranks candidates by severity, status, and lexical coverage of a query
built from the objective, the open todos and an optional `focus`. Ties break on
`(score, ordinal, id)` — a total order, so there is no tie left to chance.

*Why no embeddings.* Three reasons, in order of weight:

1. **The candidate set is tens of records, not thousands.** Semantic ranking
   solves a recall problem that does not exist at this scale. Type structure
   already does most of the filtering: a blocking constraint is relevant whether
   or not it shares vocabulary with the current step.
2. **Determinism is a product property, not a nicety.** An agent that gets a
   different reconstruction on each call cannot be debugged, and neither can we.
   Byte-identical output is testable; "semantically similar output" is not.
3. **A model in the read path** adds latency and cost to the one call that runs
   at the top of every resumed session, and introduces a hallucination surface
   into the component whose entire job is to be trustworthy.

*Where an optional layer would go.* `overlapScore` in `src/recovery/select.ts`
is the single ranking seam. A re-ranker would replace that function for the
`findings` section only — never for constraints, criteria, rejected approaches
or decisions, which are selected structurally. It is not implemented, and
`docs/agentdev-experiment.md` states the evidence that would justify it.

### 4. The protected set

Bounding is the core of the product, so what happens *at* the boundary is the
core design question. The rule is not "keep the important ones". It is:

> Never drop state whose loss causes **silent incorrectness** and which the
> agent **cannot re-derive from the repository**.

That is: blocking constraints, unmet acceptance criteria, rejected approaches,
and active decisions. Findings are explicitly *not* protected — a finding is by
definition something re-derivable by reading code. Todos are not protected —
they are re-derivable from the acceptance criteria.

If the protected set does not fit the budget, recovery **goes over budget and
says so**, rather than truncating quietly. A silently partial reconstruction is
the one failure mode that would make this tool actively worse than nothing.

*This rule was corrected by measurement.* The first version protected advisory
constraints but not decisions; the budget sweep in `src/experiment` showed the
Postgres-vs-Redis decision being dropped at a 1 500-char budget while a spelling
preference survived. The sweep is now a regression test.

### 5. Redaction at the storage boundary

`LedgerStore.write` scrubs `content`, `rationale` and `evidence`, and
`createTask` scrubs the objective. Not the MCP layer — the storage layer — so
the CLI, the experiment harness and any future transport are all covered by
construction, and there is no path to a stored secret that skips the filter.

---

## Tool surface

Ten tools. The tempting alternative is one `ledger_write(type, content)`.

*Why ten.* The tool name and its **required** arguments are the most reliable
prompt in the system — an agent reads them on every call, long after it has
stopped attending to a system prompt. `ledger_record_decision` with a required
`rationale` changes behaviour in a way `ledger_write` cannot: it makes recording
a decision without a reason *impossible* rather than *discouraged*.

*Why not more.* The other failure is verb×type explosion (add/update/complete/
cancel × 8 types ≈ 32 tools) — the "ten variations of save note" problem.
Lifecycle changes go through one `op` enum on the owning tool instead.

MCP surface beyond tools:

- **Resource** `ledger://task/{task_id}/recovery` — lets a host show the
  reconstruction to a human without spending an agent turn.
- **Prompt** `resume_task` — wraps the reconstruction in resume instructions.
- **Server instructions** — tell the agent *when* to call recovery, which is the
  behaviour the product depends on and which no individual tool description can
  convey.

### One host-compatibility lesson, learned the hard way

A tool that declares an `outputSchema` may have its **text block discarded** by
the host; only `structuredContent` reaches the model. Claude Code does this. The
first live smoke test therefore handed the agent nothing but a fingerprint and a
character count, and it correctly refused to answer. The reconstruction now
appears in both, with a regression test in `src/test/mcp.test.ts`.

---

## Storage

`node:sqlite` (Node ≥ 22.5). Chosen over `better-sqlite3` for **zero native
dependencies** — a clean `npm install` cannot fail on a missing compiler, which
matters for a tool whose whole pitch is "install it and it just persists".

- WAL journal, `busy_timeout = 5000`, `foreign_keys = ON`.
- Writes use `BEGIN IMMEDIATE`, so two processes serialise rather than racing.
- `PRAGMA user_version` drives forward-only migrations; a file written by a
  newer schema is **refused**, not best-effort parsed.
- `ordinal` is a monotonic sequence, because ISO timestamps collide at
  millisecond resolution and a collision would make recovery non-deterministic.

Verified by test: two connections, a second OS process, forty interleaved
writes, and a rollback that leaves neither record nor event behind.

---

## What is deliberately absent

| Absent | Why |
|---|---|
| Any LLM call | See decision 3. A memory layer that hallucinates is worse than none. |
| Vector store / embeddings | Candidate sets are tens of records. |
| A web UI | The CLI answers every inspection question; a UI would be the largest component and the least evidence. |
| Auth / multi-tenancy | A ledger is a local file with the user's own file permissions. |
| Cross-task knowledge base | Task isolation is a tested invariant, not an oversight. See PRODUCT.md open question 3. |
| Automatic extraction from transcripts | H3: an asserted record is a commitment; an extracted one is a guess wearing a record's clothes. |
