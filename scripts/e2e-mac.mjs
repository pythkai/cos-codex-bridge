#!/usr/bin/env node
// Opt-in real Codex CLI test for the owner's Mac. CI must not run this.
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Bridge } from '../dist/bridge.js';
import { loadConfig } from '../dist/config.js';

const exec = promisify(execFile);
if (process.env.GROKBOT_E2E !== '1') {
  console.error('Refusing to start a real Codex session. Read docs/USAGE.md, then run: GROKBOT_E2E=1 npm run e2e:mac -- --root /absolute/parent');
  process.exit(2);
}
const rootFlag = process.argv.indexOf('--root');
const root = rootFlag >= 0 ? process.argv[rootFlag + 1] : undefined;
if (!root || !path.isAbsolute(root)) {
  console.error('Pass --root /absolute/parent. The script creates a disposable repo inside it.');
  process.exit(2);
}

const login = await command('codex', ['login', 'status']);
if (login.code !== 0) {
  console.error('Codex is not logged in. On the Mac, run `codex login` and choose Sign in with ChatGPT.');
  process.exit(2);
}
const auth = /chatgpt/i.test(`${login.stdout}\n${login.stderr}`) ? 'chatgpt' : 'authenticated';

const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
const project = path.join(root, `grokbot-e2e-${stamp}`);
const state = await mkdtemp(path.join(os.tmpdir(), 'grokbot-e2e-state-'));
const token = `e2e-${stamp}-local-only`;
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'GrokBot E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'GrokBot E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' };
await mkdir(project, { recursive: true });
try {
  await exec('git', ['init'], { cwd: project, env: gitEnv });
  await writeFile(path.join(project, 'README.md'), 'e2e\n');
  await exec('git', ['add', 'README.md'], { cwd: project, env: gitEnv });
  await exec('git', ['commit', '-m', 'init'], { cwd: project, env: gitEnv });
  const configPath = path.join(state, 'config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    roots: [root],
    writeRoots: [root],
    projects: { e2e: { path: project, testCommand: 'test -f hello-bridge.txt' } },
    codexBinary: 'codex',
    stateDir: state,
    approvalToken: token,
    maxConcurrentTasks: 1,
    autoFix: { maxAttempts: 1, maxWallTimeSeconds: 600 },
    attemptTimeoutSeconds: 300,
  }));
  const bridge = new Bridge(await loadConfig(configPath));
  await bridge.init();
  const launched = await bridge.execute('bridge_launch', {
    project: 'e2e',
    prompt: 'Create a file named hello-bridge.txt in this worktree. Its only contents must be the exact text bridge-ok followed by a newline. Do not edit any other file. Do not deploy or publish.',
    requestId: `e2e-${stamp}-launch`,
    sandbox: 'workspace-write',
    autoFix: false,
    includeMemory: false,
    runTests: true,
  });
  const done = await poll(bridge, launched.taskId, 8 * 60 * 1000);
  if (done.status === 'rate_limited') {
    console.log('E2E_RESULT=rate_limited');
    console.log('Codex reported a usage limit. No automatic retry was started. Wait for the plan window, then resume manually.');
    process.exit(2);
  }
  if (done.status !== 'completed' || !done.threadId) {
    console.log(`E2E_RESULT=fail`);
    console.log(JSON.stringify({ status: done.status, error: done.error, threadId: done.threadId ?? null }));
    process.exit(1);
  }
  const file = await readFile(path.join(done.worktree, 'hello-bridge.txt'), 'utf8').catch(() => '');
  if (file !== 'bridge-ok\n') {
    console.log('E2E_RESULT=fail');
    console.log('hello-bridge.txt did not contain exactly bridge-ok');
    process.exit(1);
  }
  const resumed = await bridge.execute('bridge_resume', {
    taskId: done.taskId,
    prompt: 'Reply with exactly the single word resumed. Do not edit files.',
    requestId: `e2e-${stamp}-resume`,
  });
  const after = await poll(bridge, resumed.taskId, 8 * 60 * 1000);
  if (after.status !== 'completed' || after.threadId !== done.threadId) {
    console.log('E2E_RESULT=fail');
    console.log(JSON.stringify({ status: after.status, threadId: after.threadId ?? null, expected: done.threadId }));
    process.exit(1);
  }
  console.log('E2E_RESULT=pass');
  console.log(`auth=${auth}`);
  console.log(`task=${done.taskId}`);
  console.log(`thread=${done.threadId}`);
  console.log(`resume_thread=${after.threadId}`);
  console.log('file=bridge-ok');
  console.log(`status=${after.status}`);
  await bridge.execute('bridge_cleanup', { taskId: done.taskId, approvalToken: token, discardChanges: true }).catch(() => undefined);
} finally {
  await rm(project, { recursive: true, force: true }).catch(() => undefined);
  await rm(state, { recursive: true, force: true }).catch(() => undefined);
}

async function poll(bridge, taskId, timeoutMs) {
  const started = Date.now();
  let status = await bridge.execute('bridge_status', { taskId });
  while (!['completed', 'failed', 'cancelled', 'rate_limited', 'needs_input', 'interrupted'].includes(status.status)) {
    if (Date.now() - started > timeoutMs) return status;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    status = await bridge.execute('bridge_status', { taskId });
  }
  return status;
}

function command(binary, cmdArgs) {
  return new Promise((resolve) => {
    execFile(binary, cmdArgs, { timeout: 15000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.status ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}
