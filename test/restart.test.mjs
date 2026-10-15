import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Bridge } from '../dist/bridge.js';
import { alive } from '../dist/store.js';
import { launch, setup, waitFor } from './helpers.mjs';

const cli = path.resolve('dist/cli.js');

test('bridge restart keeps a live Codex process detached and can still cancel it', async () => {
  const fixture = await setup({ mode: 'hang', maxConcurrentTasks: 1 });
  const client = new Client({ name: 'restart-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--config', fixture.configPath, 'mcp'], stderr: 'pipe' });
  let codexPid;
  try {
    await client.connect(transport);
    const launched = await client.callTool({ name: 'bridge_launch', arguments: { project: 'app', prompt: 'Stay busy.', requestId: 'restart-live-01', includeMemory: false } });
    assert.equal(launched.isError, undefined);
    const taskId = launched.structuredContent.taskId;
    const second = await client.callTool({ name: 'bridge_launch', arguments: { project: 'app', prompt: 'Wait your turn.', requestId: 'restart-wait-01', includeMemory: false } });
    const secondId = second.structuredContent.taskId;
    await waitFor(fixture.bridge, taskId, asyncTaskRunning, 8000);
    codexPid = await waitPid(fixture.state, taskId);
    assert.equal(alive(codexPid), true);
    const queued = JSON.parse(await readFile(path.join(fixture.state, 'receipts', `${secondId}.json`), 'utf8'));
    assert.equal(queued.status, 'queued');
    process.kill(transport.pid, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const restarted = new Bridge(fixture.loaded);
    await restarted.init();
    const detached = await restarted.execute('bridge_status', { taskId });
    assert.equal(detached.status, 'running');
    assert.equal(detached.detached, true);
    assert.match(detached.note, /No new attempt was started/);
    assert.equal(alive(codexPid), true);
    const stillQueued = await restarted.execute('bridge_status', { taskId: secondId });
    assert.equal(stillQueued.status, 'queued');
    assert.notEqual(stillQueued.worktree, detached.worktree);
    const cancelled = await restarted.execute('bridge_cancel', { taskId });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(alive(codexPid), false);
    const moved = await waitFor(restarted, secondId, (task) => task.status === 'running');
    assert.notEqual(moved.worktree, detached.worktree);
    await restarted.execute('bridge_cancel', { taskId: secondId });
    codexPid = undefined;
  } finally {
    if (codexPid && alive(codexPid)) process.kill(codexPid, 'SIGKILL');
    await Promise.race([client.close().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 300))]);
  }
});

function asyncTaskRunning(task) {
  return task.status === 'running';
}

async function waitPid(state, taskId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const receipt = JSON.parse(await readFile(path.join(state, 'receipts', `${taskId}.json`), 'utf8'));
    if (receipt.pid) return receipt.pid;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('Codex pid was not recorded.');
}

test('a dead in-flight process is recovered as interrupted, while a logged completion is kept', async () => {
  const fixture = await setup();
  const interruptedId = randomUUID();
  const completedId = randomUUID();
  const now = new Date().toISOString();
  const base = {
    project: 'app',
    projectRoot: fixture.project,
    worktree: fixture.project,
    baseSha: 'c'.repeat(40),
    sandbox: 'read-only',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    promptSha256: 'd'.repeat(64),
    attempts: [],
    runAttempts: 1,
    autoFix: { enabled: false, maxAttempts: 3, maxWallTimeSeconds: 120, scope: 'worktree' },
    runTests: false,
    tests: [],
    includeMemory: false,
    pid: 2_147_000_000,
  };
  await fixture.bridge.store.writeNew({ ...base, id: interruptedId, requestId: 'recover-dead-001', branch: `bridge/${interruptedId}` });
  await fixture.bridge.store.writeNew({ ...base, id: completedId, requestId: 'recover-done-001', branch: `bridge/${completedId}` });
  await fixture.bridge.store.appendLog(completedId, 'event', { type: 'turn.completed' });
  const restarted = new Bridge(fixture.loaded);
  await restarted.init();
  const interrupted = await restarted.execute('bridge_status', { taskId: interruptedId });
  const completed = await restarted.execute('bridge_status', { taskId: completedId });
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.error.code, 'BRIDGE_RESTART');
  assert.match(interrupted.note, /No automatic retry/);
  assert.equal(completed.status, 'completed');
  assert.match(completed.note, /turn\.completed/);
});
