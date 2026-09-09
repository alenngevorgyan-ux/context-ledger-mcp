/**
 * Rendering of a RecoverySelection into text intended for reinjection into a
 * coding agent's context.
 *
 * Deliberate choices:
 *  - Plain uppercase section headers, no markdown decoration. This block is
 *    read by a model, and heavier formatting spends budget without adding
 *    information.
 *  - Empty sections are printed as "(none recorded)" rather than omitted.
 *    Absence is information: "no constraints recorded" and "constraints were
 *    dropped" must not look the same to the reader.
 *  - Truncation is stated inline. A silently partial reconstruction is the one
 *    failure mode that would make this tool actively harmful.
 */
import type { RecoverySelection } from './select.js';

export function renderRecovery(sel: RecoverySelection): string {
  const out: string[] = [];
  out.push('=== CONTEXT LEDGER — TASK STATE RECONSTRUCTION ===');
  out.push(`task: ${sel.task.id}${sel.task.repo ? `  repo: ${sel.task.repo}` : ''}`);
  out.push('');

  for (const s of sel.sections) {
    out.push(`${s.title}:`);
    if (s.key === 'objective') {
      out.push(`  ${sel.task.objective}`);
    } else if (s.items.length === 0) {
      out.push('  (none recorded)');
    } else {
      for (const item of s.items) out.push(`  - ${item.line}`);
    }
    if (s.omitted > 0) {
      out.push(`  ... ${s.omitted} more not shown (budget); query the ledger directly if needed`);
    }
    out.push('');
  }

  const notes: string[] = [];
  if (sel.budget_exceeded) {
    notes.push(
      'BUDGET EXCEEDED: critical state (blocking constraints, unmet acceptance criteria, ' +
        'rejected approaches) is never dropped, so this block is over its character budget.',
    );
  }
  if (sel.total_omitted > 0) {
    notes.push(`${sel.total_omitted} record(s) omitted. This reconstruction is partial.`);
  }
  notes.push(
    'This is recorded task state, not ground truth. If it contradicts the repository, ' +
      'trust the repository and record a correction.',
  );
  out.push('NOTES:');
  for (const n of notes) out.push(`  - ${n}`);
  out.push('');
  out.push(
    `[budget ${sel.used_chars}/${sel.budget_chars} chars; fingerprint ${sel.fingerprint}]`,
  );
  return out.join('\n');
}
