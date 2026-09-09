# Agent Integration — what was actually run

Everything on this page was executed in this environment on 2026-09-09. No
transcript here is invented. Where something was not run, it says so.

Software under test: `dist/mcp/server.js` (Context Ledger 0.1.0, MCP SDK 1.30.0,
Node v24.18.0, darwin x64).

---

## Claude Code — `2.1.266`

### Registration

Project scope writes `.mcp.json` in the repository:

```
claude mcp add context-ledger --scope project \
  -e CONTEXT_LEDGER_DB=.ledger/ledger.sqlite \
  -e CONTEXT_LEDGER_SECRETS=redact \
  -- node "$PWD/dist/mcp/server.js"
```

`claude mcp list` then reports:

```
context-ledger: node /Users/…/dist/mcp/server.js - ⏸ Pending approval (run `claude` to approve)
```

**Note the friction:** a project-scoped server requires an interactive approval
before first use. For automated verification the headless path below avoids it.

### Session A — a real agent writing to the ledger

```
claude -p "Use the context-ledger MCP tools. Call ledger_init_task with objective
  'Add pagination to the /users endpoint', acceptance_criteria
  ['GET /users?page=2 returns the second page'], and constraints
  [{text:'No new runtime dependencies', severity:'blocking'}]. Then call
  ledger_record_rejected_approach for approach 'offset/limit pagination' with
  reason 'unstable ordering when rows are inserted during traversal'.
  Then report ONLY the task_id you received." \
  --mcp-config /tmp/cl-smoke/mcp.json --strict-mcp-config \
  --allowedTools mcp__context-ledger__ledger_init_task \
                 mcp__context-ledger__ledger_record_rejected_approach \
  --permission-mode acceptEdits
```

Agent output:

```
`task_7a9dea5c31d84945872f`
```

Independent verification against the ledger file:

```
$ context-ledger state --db /tmp/cl-smoke/ledger.sqlite --task task_7a9dea5c31d84945872f
task task_7a9dea5c31d84945872f  [open]
objective: Add pagination to the /users endpoint

rec_9a91ca3f4c104f56bc75  acceptance_criterion [active]
   GET /users?page=2 returns the second page
   by human/smoke_session_a at 2026-09-09T18:40:42.438Z
rec_d359bb1821df401bb391  constraint           [active blocking]
   No new runtime dependencies
   by human/smoke_session_a at 2026-09-09T18:40:42.439Z
rec_67fec654011a440585fa  rejected_approach    [active]
   offset/limit pagination
   why: unstable ordering when rows are inserted during traversal
   by agent/smoke_session_a at 2026-09-09T18:40:45.099Z
```

### Session B — a real resume, and a real bug

A **fresh** `claude -p` process, given only the task id and no other context,
was asked to recover and answer two questions. First attempt:

```
I can't answer either question: `ledger_recover_context` returned only metadata
(fingerprint, 255 used chars) with no records … so I have no recovered content,
and I won't invent it.

(1) Unknown — the ledger returned no rejected-approach record for pagination.
(2) Unknown — the ledger returned no constraint about adding runtime dependencies
```

**This was a genuine defect in Context Ledger, found by live integration and by
nothing else.** The 18 protocol-level tests passed, because they read the tool's
text content. Claude Code does not: when a tool declares an `outputSchema`, the
host surfaces **only `structuredContent`** to the model and discards the text
block. The reconstruction lived solely in the text block, so the agent received
a fingerprint and a character count.

The agent's refusal to guess is worth noting on its own — the failure was loud
rather than silent.

**Fix.** `ledger_recover_context` now returns the reconstruction in
`structuredContent.reconstruction` as well as the text block, and
`src/test/mcp.test.ts` has two regression tests: one asserting the two payloads
agree, one asserting no tool declares an `outputSchema` with a metadata-only
payload.

**Re-run of the identical prompt after the fix:**

```
Offset/limit pagination was already tried and rejected — it gives unstable
ordering when rows are inserted mid-traversal.
No — a blocking constraint forbids new runtime dependencies.
```

Both answers are correct, and both facts came from a session this process never
saw. This is the core product loop, working, with a real agent.

---

## Codex — `codex-cli 0.153.4`

`codex mcp add` writes to the user's global `~/.codex/config.toml`. To avoid
mutating global state, the run used an ephemeral `-c` override instead:

```
codex exec --skip-git-repo-check \
  -c 'mcp_servers.context_ledger={command="node",args=["…/dist/mcp/server.js"],
      env={CONTEXT_LEDGER_DB="/tmp/cl-smoke/ledger.sqlite",CONTEXT_LEDGER_SESSION="smoke_codex"}}' \
  "Call the context_ledger tool ledger_recover_context for task_id
   task_7a9dea5c31d84945872f. Then state in one line which pagination approach
   was already rejected."
```

Transcript:

```
codex
I'll check the context ledger for the rejected pagination approach.

mcp: context_ledger/ledger_recover_context started
mcp: context_ledger/ledger_recover_context (completed)

codex
Offset/limit pagination was already rejected because ordering becomes unstable
when rows are inserted during traversal.

tokens used  4 662
```

Correct, against the **same ledger file** written by Claude Code. Two different
agent products, one ledger, consistent state — which is the portability claim
MCP is supposed to buy, actually exercised.

---

## What this does and does not establish

**Established.**
- The server is protocol-compliant against two independent host implementations.
- Tool descriptions and schemas are usable by real agents without hand-holding.
- Recovery restores task state across a genuine process boundary.
- One ledger is shared correctly between two different agent products.
- A host-compatibility defect existed and is now fixed and regression-tested.

**Not established.**
- That agents call recovery **unprompted**. In all four sessions the prompt told
  the agent it was resuming. Unprompted invocation is untested and is
  PRODUCT.md open question 2.
- That the ledger improves agent *outcomes* on real multi-hour tasks. These are
  smoke tests of the mechanism — four short sessions, one contrived task, no
  control condition. They are not evidence for H1.

---

## Reproducing

```
npm install && npm run build
mkdir -p /tmp/cl-smoke
cat > /tmp/cl-smoke/mcp.json <<EOF
{"mcpServers":{"context-ledger":{"type":"stdio","command":"node",
  "args":["$PWD/dist/mcp/server.js"],
  "env":{"CONTEXT_LEDGER_DB":"/tmp/cl-smoke/ledger.sqlite",
         "CONTEXT_LEDGER_SESSION":"smoke_a"}}}}
EOF
# then the two claude -p invocations above
```

`context-ledger serve-info` prints host registration snippets for both hosts.
