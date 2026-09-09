import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectSecrets, redact } from '../redaction/redact.js';
import { deterministicService, seedTask } from './helpers.js';
import { LedgerService } from '../service.js';

const SAMPLES: [string, string][] = [
  ['aws_access_key_id', 'creds are AKIAIOSFODNN7EXAMPLE in the config'],
  ['github_token', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['openai_key', 'OPENAI key sk-proj-abcdefghijklmnopqrstuvwxyz012345'],
  ['anthropic_key', 'use sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345'],
  ['slack_token', 'xoxb-123456789012-abcdefghijklmnop'],
  ['google_api_key', 'AIzaSyA1234567890abcdefghijklmnopqrstuv'],
  ['stripe_key', 'sk_live_abcdefghijklmnopqrstuvwx'],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'],
  ['bearer_token', 'Authorization: Bearer abcdef1234567890abcdef1234567890'],
  ['url_userinfo', 'postgres://admin:hunter2pass@db.internal:5432/app'],
  ['env_assignment', 'DATABASE_PASSWORD=s3cr3t-value-here'],
  ['private_key_block', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----'],
];

describe('secret detection', () => {
  for (const [kind, text] of SAMPLES) {
    test(`detects ${kind}`, () => {
      const dets = detectSecrets(text);
      assert.ok(dets.length > 0, `no detection in: ${text}`);
      const out = redact(text).text;
      assert.ok(out.includes('[REDACTED:'), `not redacted: ${out}`);
    });
  }

  test('leaves ordinary engineering prose untouched', () => {
    const prose = [
      'The auth middleware is registered in src/app.ts:41 and runs before the router.',
      'Benchmark showed 1200 req/s at p99 latency of 45ms on commit a1b2c3d4e5f6.',
      'Use the sliding-window algorithm; fixed-window allows a 2x burst at the boundary.',
      'See https://example.com/docs/rate-limiting#algorithms for the comparison table.',
    ].join('\n');
    const r = redact(prose);
    assert.equal(r.count, 0, `false positives: ${JSON.stringify(r.detections)}`);
    assert.equal(r.text, prose);
  });

  test('redaction is deterministic and idempotent-safe', () => {
    const text = 'key AKIAIOSFODNN7EXAMPLE and token ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const a = redact(text);
    const b = redact(text);
    assert.equal(a.text, b.text);
    assert.equal(redact(a.text).count, 0, 'redacted output must contain no further secrets');
  });

  test('overlapping detections do not corrupt the output', () => {
    const text = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEYABCD';
    const r = redact(text);
    assert.ok(r.count >= 1);
    assert.ok(!r.text.includes('wJalrXUtnFEMIK7MDENG'));
  });
});

describe('secret hygiene at the storage boundary', () => {
  test('default policy redacts on write and records the count', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    const rec = svc.store.write({
      task_id: task.id,
      type: 'finding',
      content: 'The staging API key is AKIAIOSFODNN7EXAMPLE, found in .env',
      session_id: 's',
    });
    assert.ok(!rec.content.includes('AKIAIOSFODNN7EXAMPLE'));
    assert.ok(rec.content.includes('[REDACTED:aws_access_key_id]'));
    assert.equal(rec.redactions, 1);
    svc.close();
  });

  test('rationale and evidence are also scrubbed', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    const rec = svc.store.write({
      task_id: task.id,
      type: 'decision',
      content: 'Authenticate to the metrics backend directly',
      rationale: 'we already hold ghp_abcdefghijklmnopqrstuvwxyz0123456789 for it',
      evidence: 'DATABASE_PASSWORD=s3cr3t-value-here',
      session_id: 's',
    });
    assert.ok(!rec.rationale!.includes('ghp_'));
    assert.ok(!rec.evidence!.includes('s3cr3t-value-here'));
    assert.equal(rec.redactions, 2);
    svc.close();
  });

  test('the task objective is scrubbed too', () => {
    const svc = deterministicService(':memory:');
    const t = svc.store.createTask({
      objective: 'Rotate the key AKIAIOSFODNN7EXAMPLE across all services',
      session_id: 's',
    });
    assert.ok(!t.objective.includes('AKIAIOSFODNN7EXAMPLE'));
    svc.close();
  });

  test('reject mode refuses the write instead of storing it', () => {
    const svc = new LedgerService({ path: ':memory:', redaction: { mode: 'reject' } });
    const t = svc.store.createTask({ objective: 'x', session_id: 's' });
    assert.throws(
      () =>
        svc.store.write({
          task_id: t.id, type: 'finding', content: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
          session_id: 's',
        }),
      /refusing to store content containing likely secrets/,
    );
    assert.equal(svc.store.listRecords(t.id).length, 0, 'nothing persisted on rejection');
    svc.close();
  });

  test('secrets never reach recovery output', () => {
    const svc = deterministicService(':memory:');
    const { task } = seedTask(svc);
    svc.store.write({
      task_id: task.id, type: 'finding',
      content: 'prod db is postgres://admin:hunter2pass@db.internal:5432/app',
      session_id: 's',
    });
    const { text } = svc.recover({ task_id: task.id, session_id: 's' });
    assert.ok(!text.includes('hunter2pass'));
    svc.close();
  });
});
