import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Bridge } from '../dist/bridge.js';
import { loadConfig } from '../dist/config.js';

const exec = promisify(execFile);
export const fakeCodex = path.resolve('test/fixtures/fake-codex.mjs');
export const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Bridge Test',
  GIT_AUTHOR_EMAIL: 'bridge@example.com',
  GIT_COMMITTER_NAME: 'Bridge Test',
  GIT_COMMITTER_EMAIL: 'bridge@example.com',
};

export async function setup(options = {}) {
  await chmod(fakeCodex, 0o755);
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'grokbot-bridge-')));
  const root = path.join(base, 'projects');
  const project = path.join(root, 'app');
  const state = path.join(base, 'state');
  await mkdir(project, { recursive: true });
  await exec('git', ['init'], { cwd: project, env: gitEnv });
  await writeFile(path.join(project, 'README.md'), 'test\n');
  await exec('git', ['add', 'README.md'], { cwd: project, env: gitEnv });
  await exec('git', ['commit', '-m', 'init'], { cwd: project, env: gitEnv });
  if (options.mode) await writeFile(path.join(project, '.fake-codex-mode'), `${options.mode}\n`);
  const config = {
    version: 1,
    roots: [root],
    writeRoots: options.write ? [root] : [],
    projects: { app: { path: project, ...(options.testCommand ? { testCommand: options.testCommand } : {}) } },
    codexBinary: fakeCodex,
    stateDir: state,
    maxConcurrentTasks: options.maxConcurrentTasks ?? 2,
    autoFix: { maxAttempts: options.maxAttempts ?? 3, maxWallTimeSeconds: options.maxWallTimeSeconds ?? 120 },
    attemptTimeoutSeconds: options.attemptTimeoutSeconds ?? 20,
    testTimeoutSeconds: options.testTimeoutSeconds ?? 15,
    ...(options.token ? { approvalToken: options.token } : {}),
  };
  const configPath = path.join(base, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  const loaded = await loadConfig(configPath);
  const bridge = new Bridge(loaded);
  await bridge.init();
  return { base, root, project, state, configPath, bridge, loaded };
}

export async function launch(bridge, extra = {}) {
  return bridge.execute('bridge_launch', {
    project: 'app',
    prompt: extra.prompt ?? 'Inspect the repository and stop.',
    requestId: extra.requestId ?? `req-${randomUUID().slice(0, 8)}`,
    sandbox: extra.sandbox ?? 'read-only',
    autoFix: extra.autoFix ?? false,
    includeMemory: extra.includeMemory ?? false,
    ...(extra.runTests === undefined ? {} : { runTests: extra.runTests }),
    ...(extra.maxAttempts ? { maxAttempts: extra.maxAttempts } : {}),
    ...(extra.maxWallTimeSeconds ? { maxWallTimeSeconds: extra.maxWallTimeSeconds } : {}),
  });
}

export async function waitFor(bridge, taskId, predicate, timeout = 8000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await bridge.execute('bridge_status', { taskId });
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${taskId}: ${JSON.stringify(last)}`);
}
