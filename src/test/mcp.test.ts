/**
 * Protocol-level tests: a real MCP Client talks to a real McpServer over the
 * SDK's in-memory transport pair. These exercise JSON-RPC framing, schema
 * validation and the tool contract — not just the internal service API.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, SERVER_NAME } from '../mcp/server.js';
import { TOOL_NAMES } from '../mcp/tools.js';
import { tempDir } from './helpers.js';
import type { LedgerService } from '../service.js';

let client: Client;
let service: LedgerService;
let cleanup: () => void;

function textOf(res: unknown): string {
  const r = res as { content: { type: string; text?: string }[] };
  return r.content.map((c) => c.text ?? '').join('\n');
}
function structOf(res: unknown): Record<string, any> {
  return (res as { structuredContent?: Record<string, any> }).structuredContent ?? {};
}
async function call(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

before(async () => {
  const d = tempDir();
  cleanup = d.cleanup;
  const built = buildServer({ dbPath: join(d.dir, 'mcp.sqlite'), sessionId: 'sess_mcp_test' });
  service = built.service;
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-harness', version: '0.0.0' });
  await Promise.all([built.server.connect(serverT), client.connect(clientT)]);
});

after(async () => {
  await client.close();
  service.close();
  cleanup();
});

describe('MCP protocol surface', () => {
  test('server identifies itself and advertises tools, resources and prompts', () => {
    const v = client.getServerVersion();
    assert.equal(v?.name, SERVER_NAME);
    const caps = client.getServerCapabilities();
    assert.ok(caps?.tools, 'tools capability missing');
    assert.ok(caps?.resources, 'resources capability missing');
    assert.ok(caps?.prompts, 'prompts capability missing');
  });

  test('server instructions tell the agent when to call recovery', () => {
    const instructions = client.getInstructions() ?? '';
    assert.match(instructions, /ledger_recover_context BEFORE reading files/);
  });

  test('exactly the intended tools are exposed, each with a description and schema', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...TOOL_NAMES].sort());
    for (const t of tools) {
      assert.ok(t.description && t.description.length > 40, `${t.name}: thin description`);
      assert.ok(t.inputSchema, `${t.name}: no input schema`);
      assert.equal(t.inputSchema.type, 'object');
    }
  });

  test('read-only tools are annotated as such', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    assert.equal(byName.get('ledger_recover_context')?.annotations?.readOnlyHint, true);
    assert.equal(byName.get('ledger_get_task_state')?.annotations?.readOnlyHint, true);
    assert.equal(byName.get('ledger_record_decision')?.annotations?.readOnlyHint, false);
  });
});

let taskIdForRegression: string;

describe('MCP tool behaviour end to end', () => {
  let taskId: string;

  test('ledger_init_task bootstraps objective, criteria and constraints', async () => {
    const res = await call('ledger_init_task', {
      objective: 'Add per-API-key rate limiting to the public REST API',
      repo: 'example/api',
      acceptance_criteria: ['Requests over 100/min per API key receive HTTP 429'],
      constraints: [
        { text: 'No new runtime dependencies', severity: 'blocking', source: 'CONTRIBUTING.md' },
        { text: 'Must not add more than 5ms p99 latency', severity: 'important' },
      ],
    });
    const s = structOf(res);
    assert.equal(s['ok'], true);
    taskId = s['task_id'] as string;
    taskIdForRegression = taskId;
    assert.match(taskId, /^task_/);
    assert.equal(s['constraints'], 2);
  });

  test('an invalid argument is rejected by the schema layer, before any write', async () => {
    const before = service.store.listRecords(taskId).length;
    // `rationale` is required by the tool's input schema. The SDK validates
    // against it and never reaches our handler.
    const res = await call('ledger_record_decision', { task_id: taskId, decision: 'x' });
    assert.equal((res as any).isError, true, 'schema violation must be an error result');
    assert.match(textOf(res), /rationale/i);
    assert.equal(service.store.listRecords(taskId).length, before, 'nothing may be written');
  });

  test('domain errors come back as tool errors with a machine-readable code', async () => {
    const res = await call('ledger_record_finding', { task_id: 'task_does_not_exist', finding: 'x' });
    assert.equal((res as any).isError, true);
    assert.equal(structOf(res)['code'], 'not_found');
    assert.match(textOf(res), /ledger error \[not_found\]/);
  });

  test('recording a decision, a rejected approach, findings and todos', async () => {
    const dec = await call('ledger_record_decision', {
      task_id: taskId,
      decision: 'Implement a sliding-window log limiter in-process',
      rationale: 'Fixed-window allows a 2x burst at the boundary; Redis would break the no-dependency constraint',
      alternatives_considered: ['fixed window', 'Redis token bucket'],
      confidence: 0.8,
    });
    assert.equal(structOf(dec)['ok'], true);

    const rej = await call('ledger_record_rejected_approach', {
      task_id: taskId,
      approach: 'Enforce the limit in nginx with limit_req',
      reason: 'nginx cannot read the API key, only the source IP, so per-key limits are impossible',
      evidence: 'the Authorization header is not available at that stage',
    });
    assert.equal(structOf(rej)['ok'], true);

    await call('ledger_record_finding', {
      task_id: taskId,
      finding: 'The API key is resolved by auth middleware in src/app.ts:41',
      evidence: 'src/app.ts:41',
      confidence: 0.95,
    });
    const todo = await call('ledger_update_todo', {
      task_id: taskId, op: 'add', text: 'Wire the limiter into the router',
    });
    assert.equal(structOf(todo)['ok'], true);
  });

  test('ledger_recover_context returns a bounded, deterministic reconstruction', async () => {
    const a = await call('ledger_recover_context', { task_id: taskId, budget_chars: 3000 });
    const b = await call('ledger_recover_context', { task_id: taskId, budget_chars: 3000 });
    assert.equal(textOf(a), textOf(b));
    assert.equal(structOf(a)['fingerprint'], structOf(b)['fingerprint']);
    const text = textOf(a);
    assert.match(text, /ORIGINAL OBJECTIVE/);
    assert.match(text, /No new runtime dependencies/);
    assert.match(text, /nginx/);
    assert.ok(structOf(a)['used_chars'] as number <= 3000);
  });

  test('a superseding decision replaces the old one in recovery output', async () => {
    const state = await call('ledger_get_task_state', { task_id: taskId });
    const records = structOf(state)['records'] as any[];
    const decision = records.find((r) => r.type === 'decision');
    await call('ledger_record_decision', {
      task_id: taskId,
      decision: 'Implement a fixed-window counter after all',
      rationale: 'Measured burst risk is acceptable and the sliding log doubled memory per key',
      supersedes: decision.id,
    });
    const text = textOf(await call('ledger_recover_context', { task_id: taskId }));
    assert.ok(text.includes('fixed-window counter after all'));
    assert.ok(!text.includes('sliding-window log limiter in-process'));
  });

  test('verification advances the acceptance criterion it claims to satisfy', async () => {
    const state = await call('ledger_get_task_state', { task_id: taskId });
    const ac = (structOf(state)['records'] as any[]).find((r) => r.type === 'acceptance_criterion');
    await call('ledger_record_verification', {
      task_id: taskId,
      command: 'npm test -- rate-limit',
      passed: true,
      summary: '429 returned after 100 requests in a rolling minute',
      acceptance_criteria_met: [ac.id],
    });
    const text = textOf(await call('ledger_recover_context', { task_id: taskId }));
    assert.match(text, /\[MET\] Requests over 100\/min/);
    assert.match(text, /\[PASS\].*npm test -- rate-limit/);
  });

  test('secrets pushed through the MCP layer are redacted before storage', async () => {
    await call('ledger_record_finding', {
      task_id: taskId,
      finding: 'the staging key is AKIAIOSFODNN7EXAMPLE',
    });
    const text = textOf(await call('ledger_recover_context', { task_id: taskId, focus: 'staging key' }));
    assert.ok(!text.includes('AKIAIOSFODNN7EXAMPLE'));
    assert.match(text, /REDACTED:aws_access_key_id/);
  });

  test('open questions can be asked and resolved', async () => {
    const asked = await call('ledger_open_question', {
      task_id: taskId, op: 'ask', question: 'Should internal service tokens be exempt?',
    });
    const qid = structOf(asked)['record'].id as string;
    let text = textOf(await call('ledger_recover_context', { task_id: taskId }));
    assert.match(text, /Should internal service tokens be exempt\?/);

    await call('ledger_open_question', {
      task_id: taskId, op: 'resolve', question_id: qid, answer: 'Yes, tokens with the internal scope are exempt',
    });
    text = textOf(await call('ledger_recover_context', { task_id: taskId, focus: 'internal service tokens' }));
    assert.ok(!text.includes('OPEN QUESTIONS:\n  - Should internal service tokens'));
    assert.match(text, /internal scope are exempt/);
  });

  test('the recovery resource returns the same reconstruction as the tool', async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    assert.ok(resourceTemplates.some((r) => r.uriTemplate.includes('ledger://task/')));
    const res = await client.readResource({ uri: `ledger://task/${taskId}/recovery` });
    const viaResource = (res.contents[0] as { text: string }).text;
    const viaTool = textOf(await call('ledger_recover_context', { task_id: taskId }));
    assert.equal(viaResource, viaTool);
  });

  test('the resume_task prompt wraps the reconstruction with resume instructions', async () => {
    const { prompts } = await client.listPrompts();
    assert.ok(prompts.some((p) => p.name === 'resume_task'));
    const p = await client.getPrompt({ name: 'resume_task', arguments: { task_id: taskId } });
    const body = (p.messages[0]!.content as { text: string }).text;
    assert.match(body, /Do not repeat any approach listed as failed/);
    assert.match(body, /CONTEXT LEDGER — TASK STATE RECONSTRUCTION/);
  });

  test('ledger_get_task_state hides superseded records unless asked', async () => {
    const lean = structOf(await call('ledger_get_task_state', { task_id: taskId }))['records'] as any[];
    const full = structOf(
      await call('ledger_get_task_state', { task_id: taskId, include_superseded: true }),
    )['records'] as any[];
    assert.ok(full.length > lean.length);
    assert.ok(lean.every((r) => r.status !== 'superseded'));
  });
});

/**
 * Regression tests for defects found by live agent integration, not by design.
 * See docs/agent-integration.md for the smoke-test transcript.
 */
describe('host-compatibility regressions', () => {
  test('the reconstruction is present in structuredContent, not only in the text block', async () => {
    // A host that declares support for structured output may surface ONLY
    // structuredContent to the model. Claude Code did exactly this, and the
    // agent received metadata with no state and (correctly) refused to answer.
    const res = await call('ledger_recover_context', { task_id: taskIdForRegression });
    const s = structOf(res);
    assert.equal(typeof s['reconstruction'], 'string');
    assert.match(s['reconstruction'] as string, /ORIGINAL OBJECTIVE/);
    assert.equal(s['reconstruction'], textOf(res), 'text and structured payload must agree');
  });

  test('every tool that returns a payload puts it in structuredContent', async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      if (!t.outputSchema) continue;
      const props = (t.outputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      assert.ok(
        Object.keys(props).length > 1,
        `${t.name}: declares an outputSchema with no useful payload`,
      );
    }
  });
});
