import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { Bridge } from '../dist/bridge.js';
import { gitEnv, launch, setup, waitFor } from './helpers.mjs';

const exec = promisify(execFile);

test('launches a task, returns its result, and resumes the same Codex thread', async () => {
  const { bridge } = await setup();
  const started = await launch(bridge, { prompt: 'Say hello.' });
  assert.equal(started.status, 'queued');
  const done = await waitFor(bridge, started.taskId, (task) => task.status === 'completed');
  assert.ok(done.threadId);
  assert.equal(done.sandbox, 'read-only');
  assert.match(done.branch, /^bridge\//);
  const log = await bridge.execute('bridge_log', { taskId: started.taskId, limitBytes: 200 });
  assert.match(log.events.join('\n'), /thread\.started/);
  assert.equal(log.done, false);
  const rest = await bridge.execute('bridge_log', { taskId: started.taskId, cursor: log.nextCursor, limitBytes: 64000 });
  assert.equal(rest.done, true);
  const argv = JSON.parse(await readFile(path.join(done.worktree, '.fake-argv.json'), 'utf8'));
  assert.ok(argv.includes('--sandbox') && argv.includes('read-only'));
  assert.equal(argv.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  const followed = await bridge.execute('bridge_resume', { taskId: started.taskId, prompt: 'Continue the same thread.', requestId: 'resume-same-thread' });
  const after = await waitFor(bridge, followed.taskId, (task) => task.status === 'completed' && task.attempts.some((attempt) => attempt.kind === 'resume'));
  assert.equal(after.threadId, done.threadId);
  const resumeArgv = JSON.parse(await readFile(path.join(after.worktree, '.fake-argv.json'), 'utf8'));
  assert.deepEqual(resumeArgv.slice(resumeArgv.indexOf('resume'), resumeArgv.indexOf('resume') + 2), ['resume', done.threadId]);
});

test('auto-fix retries a failing test and stops at the attempt cap', async () => {
  const { bridge, project } = await setup({ mode: 'autofix', testCommand: 'test -f fixed.txt', maxAttempts: 3 });
  const started = await launch(bridge, { prompt: 'Make the test pass.', autoFix: true, requestId: 'autofix-pass-01' });
  const done = await waitFor(bridge, started.taskId, (task) => task.status === 'completed', 10000);
  assert.equal(done.attempts.length, 2);
  assert.equal(done.tests[0].ok, false);
  assert.equal(done.tests.at(-1).ok, true);
  assert.equal(await readFile(path.join(done.worktree, 'fixed.txt'), 'utf8'), 'ok\n');
  const prompt = await readFile(path.join(done.worktree, '.fake-prompt.txt'), 'utf8');
  assert.match(prompt, /VERIFICATION FAILED/);
  assert.equal(await readFile(path.join(project, 'fixed.txt'), 'utf8').then(() => true, () => false), false);

  const capped = await setup({ mode: 'autofix', testCommand: 'false', maxAttempts: 2 });
  const limited = await launch(capped.bridge, { prompt: 'This test cannot pass.', autoFix: true, requestId: 'autofix-cap-0001' });
  const stopped = await waitFor(capped.bridge, limited.taskId, (task) => task.status === 'failed', 10000);
  assert.equal(stopped.attempts.length, 2);
  assert.equal(stopped.error.code, 'TEST_FAILED');
  assert.equal(await readFile(path.join(stopped.worktree, '.fake-runs'), 'utf8'), '2');
});

test('usage limits become rate_limited and are not retried', async () => {
  const { bridge } = await setup({ mode: 'rate_limit', testCommand: 'false' });
  const started = await launch(bridge, { prompt: 'Try the work.', autoFix: true, requestId: 'rate-limit-0001' });
  const done = await waitFor(bridge, started.taskId, (task) => task.status === 'rate_limited');
  assert.equal(done.error.code, 'RATE_LIMITED');
  assert.equal(done.attempts.length, 1);
  assert.equal(await readFile(path.join(done.worktree, '.fake-runs'), 'utf8'), '1');
  await assert.rejects(bridge.execute('bridge_autofix', { taskId: done.taskId }), (error) => error.code === 'RATE_LIMITED');
  assert.equal(await readFile(path.join(done.worktree, '.fake-runs'), 'utf8'), '1');
});

test('needs_input stops without an automatic follow-up', async () => {
  const { bridge } = await setup({ mode: 'needs_input', testCommand: 'false' });
  const started = await launch(bridge, { prompt: 'Ask if needed.', autoFix: true, requestId: 'needs-input-001' });
  const done = await waitFor(bridge, started.taskId, (task) => task.status === 'needs_input');
  assert.equal(done.error.code, 'NEEDS_INPUT');
  assert.equal(done.attempts.length, 1);
});

test('cancel interrupts a running task and a second task stays isolated', async () => {
  const { bridge } = await setup({ mode: 'hang', maxConcurrentTasks: 1 });
  const first = await launch(bridge, { prompt: 'WRITE_FILE stay busy', requestId: 'cancel-first-01' });
  await waitFor(bridge, first.taskId, (task) => task.status === 'running');
  const second = await launch(bridge, { prompt: 'WRITE_FILE other task', requestId: 'cancel-second1' });
  const queued = await bridge.execute('bridge_status', { taskId: second.taskId });
  assert.equal(queued.status, 'queued');
  assert.notEqual(queued.worktree, first.worktree);
  const cancelled = await bridge.execute('bridge_cancel', { taskId: first.taskId });
  assert.equal(cancelled.status, 'cancelled');
  const started = await waitFor(bridge, second.taskId, (task) => task.status === 'running');
  assert.notEqual(started.worktree, first.worktree);
  await bridge.execute('bridge_cancel', { taskId: second.taskId });
});

test('workspace-write is default-deny and cleanup requires the approval token', async () => {
  const denied = await setup();
  await assert.rejects(launch(denied.bridge, { sandbox: 'workspace-write', requestId: 'write-denied-01' }), (error) => error.code === 'WRITE_NOT_ALLOWLISTED');
  const token = 'super-secret-token-value';
  const { bridge } = await setup({ write: true, token, mode: 'complete' });
  const doctor = await bridge.execute('bridge_doctor', {});
  assert.equal(doctor.codex.auth.mode, 'chatgpt');
  assert.equal(doctor.bypassSandbox, false);
  assert.equal(doctor.publishDisabled, true);
  assert.equal(JSON.stringify(doctor).includes(token), false);
  const started = await launch(bridge, { sandbox: 'workspace-write', prompt: 'WRITE_FILE', requestId: 'write-allowed-1' });
  const done = await waitFor(bridge, started.taskId, (task) => task.status === 'completed');
  assert.equal(done.sandbox, 'workspace-write');
  assert.equal(await readFile(path.join(done.worktree, 'hello.txt'), 'utf8'), 'bridge-ok\n');
  await assert.rejects(bridge.execute('bridge_cleanup', { taskId: done.taskId, approvalToken: 'wrong-token-value', discardChanges: true }), (error) => error.code === 'APPROVAL_REQUIRED');
  const cleaned = await bridge.execute('bridge_cleanup', { taskId: done.taskId, approvalToken: token, discardChanges: true });
  assert.equal(cleaned.cleaned, true);
  await assert.rejects(readFile(path.join(done.worktree, 'hello.txt')), (error) => error.code === 'ENOENT');
});

test('report lists a commit and redacts leaked credentials from the log', async () => {
  const { bridge } = await setup({ mode: 'leak' });
  const started = await launch(bridge, { prompt: 'Do not print secrets.', requestId: 'report-leak-001' });
  const done = await waitFor(bridge, started.taskId, (task) => task.status === 'completed');
  const log = await bridge.execute('bridge_log', { taskId: done.taskId, limitBytes: 64000 });
  const text = log.events.join('\n');
  assert.match(text, /\[REDACTED\]/);
  assert.equal(text.includes('sk-supersecretvalue123456'), false);
  await execFileCommit(done.worktree);
  const report = await bridge.execute('bridge_report', { taskId: done.taskId });
  assert.equal(report.commits?.length, undefined);
  assert.equal(report.git.commits.length, 1);
  assert.equal(report.git.commits[0].subject, 'note the work');
  assert.equal(report.status, 'completed');
});

async function execFileCommit(worktree) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(worktree, 'note.txt'), 'note\n');
  await exec('git', ['add', 'note.txt'], { cwd: worktree, env: gitEnv });
  await exec('git', ['commit', '-m', 'note the work'], { cwd: worktree, env: gitEnv });
}

test('memory is injected as notes and identical request ids do not start a second task', async () => {
  const { bridge } = await setup();
  await bridge.execute('bridge_memory', { project: 'app', action: 'write', text: 'Prefer small patches.' });
  const first = await launch(bridge, { includeMemory: true, prompt: 'Read the notes.', requestId: 'same-request-01' });
  const duplicate = await launch(bridge, { includeMemory: true, prompt: 'Read the notes.', requestId: 'same-request-01' });
  assert.equal(duplicate.taskId, first.taskId);
  await assert.rejects(launch(bridge, { includeMemory: true, prompt: 'Different work.', requestId: 'same-request-01' }), (error) => error.code === 'CONFLICT');
  const done = await waitFor(bridge, first.taskId, (task) => task.status === 'completed');
  const prompt = await readFile(path.join(done.worktree, '.fake-prompt.txt'), 'utf8');
  assert.match(prompt, /Prefer small patches/);
  assert.match(prompt, /Do not deploy/);
});

test('a past wall-time deadline stops a recovered task without calling Codex', async () => {
  const fixture = await setup();
  const id = randomUUID();
  const now = new Date().toISOString();
  await fixture.bridge.store.writeNew({
    id,
    requestId: 'wall-clock-0001',
    project: 'app',
    projectRoot: fixture.project,
    worktree: fixture.project,
    branch: `bridge/${id}`,
    baseSha: 'a'.repeat(40),
    sandbox: 'read-only',
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    deadlineAt: new Date(Date.now() - 1000).toISOString(),
    promptSha256: 'b'.repeat(64),
    attempts: [],
    runAttempts: 0,
    autoFix: { enabled: true, maxAttempts: 3, maxWallTimeSeconds: 120, scope: 'worktree' },
    runTests: false,
    tests: [],
    includeMemory: false,
    queuedPhase: 'launch',
  });
  await fixture.bridge.store.putPayload(id, { prompt: 'too late' });
  const restarted = new Bridge(fixture.loaded);
  await restarted.init();
  const status = await waitFor(restarted, id, (task) => task.status === 'failed');
  assert.equal(status.error.code, 'WALL_TIME');
  assert.equal(status.attempts.length, 0);
});
