/**
 * Secret hygiene.
 *
 * Threat: a coding agent reads a .env file, learns something useful, and writes
 * a finding that embeds a live credential. The ledger is a persistent,
 * inspectable, long-lived SQLite file. It must not casually become a
 * credential store.
 *
 * Position in the system: this runs at the STORAGE boundary (LedgerStore.write),
 * not in the MCP layer, so no write path can bypass it. See failure-model.md.
 *
 * Honest limitations (also documented in docs/failure-model.md):
 *  - This is pattern-based. It catches shaped secrets (prefixed tokens, key
 *    blocks, assignments, high-entropy blobs). It cannot catch an unshaped
 *    secret such as a password that looks like an English phrase.
 *  - It is deliberately biased toward false positives over false negatives.
 *  - Redaction is not a substitute for not pasting secrets.
 */

export type SecretKind =
  | 'private_key_block'
  | 'aws_access_key_id'
  | 'aws_secret_access_key'
  | 'github_token'
  | 'openai_key'
  | 'anthropic_key'
  | 'slack_token'
  | 'google_api_key'
  | 'stripe_key'
  | 'jwt'
  | 'bearer_token'
  | 'url_userinfo'
  | 'env_assignment'
  | 'high_entropy_blob';

export interface Detection {
  kind: SecretKind;
  /** Index into the ORIGINAL string. */
  start: number;
  end: number;
}

export interface RedactionResult {
  text: string;
  detections: Detection[];
  count: number;
}

interface Rule {
  kind: SecretKind;
  re: RegExp;
  /** Which capture group holds the secret itself; 0 = whole match. */
  group?: number;
}

/**
 * Ordered most-specific-first. Overlapping matches resolve to the earliest
 * start, then the longest span, then the earlier rule — a total order, so
 * redaction is deterministic.
 */
const RULES: Rule[] = [
  {
    kind: 'private_key_block',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  { kind: 'aws_access_key_id', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  {
    kind: 'aws_secret_access_key',
    re: /\baws_secret_access_key\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi,
    group: 1,
  },
  { kind: 'github_token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/g },
  { kind: 'github_token', re: /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g },
  { kind: 'openai_key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'slack_token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'stripe_key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    kind: 'bearer_token',
    re: /\b(?:Bearer|Authorization:\s*Bearer)\s+([A-Za-z0-9._~+/=-]{20,})/g,
    group: 1,
  },
  {
    kind: 'url_userinfo',
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:([^\s/@]{3,})@/gi,
    group: 1,
  },
  {
    // KEY=value / KEY: value where the key name looks credential-ish.
    kind: 'env_assignment',
    re: /\b([A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|CLIENT_SECRET|DSN|CONNECTION_STRING)[A-Z0-9_]*)\s*[=:]\s*["']?([^\s"'\n]{6,})["']?/g,
    group: 2,
  },
];

/** Words that look high-entropy to a naive check but are not secrets. */
const ENTROPY_ALLOWLIST = /^(?:[0-9a-f]{7,40}|[A-Za-z]+)$/; // git SHAs, plain words

function shannonEntropyBits(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * High-entropy blob detector, applied only to assignment right-hand-sides and
 * quoted strings, to keep false positives away from prose.
 */
function detectHighEntropy(text: string): Detection[] {
  const out: Detection[] = [];
  const re = /(?:[=:]\s*|["'`])([A-Za-z0-9+/_=-]{32,})(?=["'`\s,;)]|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const val = m[1]!;
    if (ENTROPY_ALLOWLIST.test(val)) continue;
    if (shannonEntropyBits(val) < 3.6) continue;
    const start = m.index + m[0].length - val.length;
    out.push({ kind: 'high_entropy_blob', start, end: start + val.length });
  }
  return out;
}

export function detectSecrets(text: string): Detection[] {
  const found: Detection[] = [];
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const g = rule.group ?? 0;
      const captured = m[g];
      if (captured === undefined) continue;
      const start = g === 0 ? m.index : m.index + m[0].indexOf(captured);
      found.push({ kind: rule.kind, start, end: start + captured.length });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  found.push(...detectHighEntropy(text));

  // Deterministic total order, then drop spans contained in an earlier span.
  found.sort((a, b) => a.start - b.start || b.end - a.end || a.kind.localeCompare(b.kind));
  const merged: Detection[] = [];
  for (const d of found) {
    const prev = merged[merged.length - 1];
    if (prev && d.start < prev.end) continue; // overlapped by a kept span
    merged.push(d);
  }
  return merged;
}

export function redact(text: string): RedactionResult {
  const detections = detectSecrets(text);
  if (detections.length === 0) return { text, detections, count: 0 };
  let out = '';
  let cursor = 0;
  for (const d of detections) {
    out += text.slice(cursor, d.start) + `[REDACTED:${d.kind}]`;
    cursor = d.end;
  }
  out += text.slice(cursor);
  return { text: out, detections, count: detections.length };
}

export type RedactionMode = 'redact' | 'reject' | 'off';

export interface RedactionPolicy {
  mode: RedactionMode;
}

export const DEFAULT_REDACTION_POLICY: RedactionPolicy = { mode: 'redact' };
