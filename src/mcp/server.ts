#!/usr/bin/env node
/**
 * Context Ledger MCP server (stdio).
 *
 * Configuration is environment-only, because MCP stdio servers are launched by
 * a host that passes no CLI flags:
 *   CONTEXT_LEDGER_DB       path to the SQLite file  (default ./.ledger/ledger.sqlite)
 *   CONTEXT_LEDGER_SESSION  session id stamped as provenance (default: generated)
 *   CONTEXT_LEDGER_SECRETS  redact | reject | off    (default redact)
 *
 * stdout is reserved for the JSON-RPC stream. All diagnostics go to stderr.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LedgerService } from '../service.js';
import { registerTools } from './tools.js';
import type { RedactionMode } from '../redaction/redact.js';

export const SERVER_NAME = 'context-ledger';
export const SERVER_VERSION = '0.1.0';

export interface BuildOptions {
  dbPath: string;
  sessionId?: string;
  secrets?: RedactionMode;
}

export function buildServer(opts: BuildOptions): { server: McpServer; service: LedgerService } {
  const sessionId = opts.sessionId ?? `sess_${randomUUID().slice(0, 8)}`;
  const service = new LedgerService({
    path: opts.dbPath,
    redaction: { mode: opts.secrets ?? 'redact' },
  });

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Context Ledger stores the small amount of task state that must survive context ' +
        'compaction and session restarts: the objective, constraints, acceptance criteria, ' +
        'decisions with rationale, approaches already rejected, open questions, remaining todos ' +
        'and the last verification result.\n\n' +
        'Use it like this:\n' +
        '1. At the start of NEW work: ledger_init_task.\n' +
        '2. At the start of RESUMED work, or right after context is compacted: ' +
        'ledger_recover_context BEFORE reading files.\n' +
        '3. During work, record only durable state — a decision and why, an approach that ' +
        'failed and its error, a hard-won fact about the code, a requirement you discovered.\n' +
        '4. Do NOT record narration, progress commentary, or anything you could re-derive from ' +
        'the repository in seconds. Over-recording degrades recovery quality for everyone.\n' +
        '5. Never paste credentials, .env contents or tokens into a record. The server redacts ' +
        'secret-shaped text by default, but it cannot catch everything.',
    },
  );

  registerTools(server, { service, sessionId });

  // A resource, not just tools: hosts that support resources can surface the
  // reconstruction directly to the user without an agent turn.
  server.registerResource(
    'task-recovery',
    new ResourceTemplate('ledger://task/{task_id}/recovery', { list: undefined }),
    {
      title: 'Task state reconstruction',
      description: 'Bounded, deterministic reconstruction of a task’s recorded state.',
      mimeType: 'text/plain',
    },
    async (uri, vars) => {
      const taskId = String(vars['task_id']);
      const { text } = service.recover({ task_id: taskId, session_id: sessionId });
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text }] };
    },
  );

  server.registerPrompt(
    'resume_task',
    {
      title: 'Resume a task from the Context Ledger',
      description:
        'Produces a resume prompt containing the reconstructed task state. Use after a session ' +
        'restart or context compaction.',
      argsSchema: { task_id: z.string() },
    },
    ({ task_id }) => {
      const { text } = service.recover({ task_id, session_id: sessionId });
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text:
                'You are resuming an in-progress software task after losing your context. ' +
                'The block below is recorded state from the Context Ledger. Read it before ' +
                'touching the repository. Do not repeat any approach listed as failed, and do ' +
                'not contradict a recorded decision without explicitly superseding it.\n\n' +
                text,
            },
          },
        ],
      };
    },
  );

  return { server, service };
}

async function main(): Promise<void> {
  const dbPath = process.env['CONTEXT_LEDGER_DB'] ?? '.ledger/ledger.sqlite';
  const secrets = (process.env['CONTEXT_LEDGER_SECRETS'] as RedactionMode) ?? 'redact';
  const { server } = buildServer({
    dbPath,
    sessionId: process.env['CONTEXT_LEDGER_SESSION'] ?? undefined,
    secrets,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[context-ledger] stdio server ready (db=${dbPath}, secrets=${secrets})\n`);
}

const isEntry =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  main().catch((err) => {
    process.stderr.write(`[context-ledger] fatal: ${err instanceof Error ? err.stack : err}\n`);
    process.exit(1);
  });
}
