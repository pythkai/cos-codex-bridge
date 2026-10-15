import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSafeArgs, buildCodexArgs } from '../dist/codex.js';
import { isNeedsInput, isRateLimited } from '../dist/limits.js';
import { redact } from '../dist/redact.js';

test('rate and usage limits are distinct from ordinary failures', () => {
  assert.equal(isRateLimited("You've reached your Codex usage limit. Try again later."), true);
  assert.equal(isRateLimited('HTTP 429 too many requests'), true);
  assert.equal(isRateLimited('quota exceeded for this plan'), true);
  assert.equal(isRateLimited('the function returned a limit of 10'), false);
  assert.equal(isNeedsInput('approval required: waiting for user input'), true);
  assert.equal(isNeedsInput("You've reached your Codex usage limit"), false);
});

test('secrets are redacted and sandbox bypass flags are refused', () => {
  assert.equal(redact('token sk-supersecretvalue123456 and OPENAI_API_KEY=abc123'), 'token [REDACTED] and [REDACTED]');
  assert.equal(redact('approval super-secret-token-value', ['super-secret-token-value']), 'approval [REDACTED]');
  const args = buildCodexArgs({ cwd: '/work/tree', sandbox: 'read-only', lastMessagePath: '/state/last.txt', threadId: 'thr_123', model: 'gpt-5.4' });
  assert.deepEqual(args.slice(0, 4), ['-a', 'never', 'exec', '--json']);
  assert.ok(args.includes('--sandbox') && args.includes('read-only'));
  assert.deepEqual(args.slice(-3), ['resume', 'thr_123', '-']);
  assert.equal(args.some((arg) => /danger|yolo|full-auto|bypass/i.test(arg)), false);
  assert.throws(() => assertSafeArgs(['exec', '--dangerously-bypass-approvals-and-sandbox']), /sandbox bypass/i);
  assert.throws(() => buildCodexArgs({ cwd: '/work', sandbox: 'danger-full-access', lastMessagePath: '/tmp/last' }), /sandbox bypass/i);
});
