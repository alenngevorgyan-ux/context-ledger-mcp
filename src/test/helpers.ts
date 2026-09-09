import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerService } from '../service.js';

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ctxledger-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Deterministic clock + ids, so tests can assert byte-identical output. */
export function deterministicService(
  path: string,
  opts: { startIso?: string; idPrefix?: string } = {},
): LedgerService {
  let t = Date.parse(opts.startIso ?? '2026-01-01T00:00:00.000Z');
  let n = 0;
  const idPrefix = opts.idPrefix ?? '';
  return new LedgerService({
    path,
    now: () => new Date((t += 1000)),
    newId: (p) => `${p}_${idPrefix}${String(++n).padStart(6, '0')}`,
  });
}

export function seedTask(svc: LedgerService, session = 'sessA') {
  const task = svc.store.createTask({
    objective: 'Add rate limiting to the public REST API',
    repo: 'example/api',
    session_id: session,
  });
  const ac = svc.store.write({
    task_id: task.id,
    type: 'acceptance_criterion',
    content: 'Requests over 100/min per API key receive HTTP 429',
    session_id: session,
    source: 'human',
  });
  const c = svc.store.write({
    task_id: task.id,
    type: 'constraint',
    content: 'No new runtime dependencies',
    severity: 'blocking',
    session_id: session,
    source: 'human',
    evidence: 'CONTRIBUTING.md',
  });
  return { task, ac, c };
}
