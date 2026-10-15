#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Bridge } from '../dist/bridge.js';
import { loadConfig } from '../dist/config.js';

const exec = promisify(execFile);
const fake = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test/fixtures/fake-codex.mjs');
await chmod(fake, 0o755);
const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'grokbot-demo-')));
const root = path.join(base, 'projects');
const project = path.join(root, 'app');
const state = path.join(base, 'state');
await mkdir(project, { recursive: true });
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Bridge Demo', GIT_AUTHOR_EMAIL: 'bridge@example.com', GIT_COMMITTER_NAME: 'Bridge Demo', GIT_COMMITTER_EMAIL: 'bridge@example.com' };
await exec('git', ['init'], { cwd: project, env: gitEnv });
await writeFile(path.join(project, 'README.md'), 'demo\n');
await exec('git', ['add', 'README.md'], { cwd: project, env: gitEnv });
await exec('git', ['commit', '-m', 'init'], { cwd: project, env: gitEnv });
const configPath = path.join(base, 'config.json');
await writeFile(configPath, JSON.stringify({
  version: 1,
  roots: [root],
  writeRoots: [],
  projects: { app: { path: project } },
  codexBinary: fake,
  stateDir: state,
}));
const bridge = new Bridge(await loadConfig(configPath));
await bridge.init();
const launched = await bridge.execute('bridge_launch', { project: 'app', prompt: 'Summarize this repository.', requestId: 'demo-request-01', includeMemory: false });
const started = Date.now();
let status = launched;
while (status.status !== 'completed' && Date.now() - started < 8000) {
  await new Promise((resolve) => setTimeout(resolve, 40));
  status = await bridge.execute('bridge_status', { taskId: launched.taskId });
}
if (status.status !== 'completed' || !status.threadId) {
  console.error(JSON.stringify(status, null, 2));
  process.exit(1);
}
const report = await bridge.execute('bridge_report', { taskId: launched.taskId });
console.log(JSON.stringify({ demo: true, codex: 'fake', taskId: status.taskId, status: status.status, threadId: status.threadId, promptSha256: status.promptSha256, sandbox: status.sandbox, reportStatus: report.status }, null, 2));
