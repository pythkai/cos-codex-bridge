#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('codex-cli 9.9.9-fake\n');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  process.stdout.write('Logged in using ChatGPT\n');
  process.exit(0);
}

function value(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const cwd = value('-C');
if (!cwd) {
  process.stderr.write('fake codex expected -C\n');
  process.exit(2);
}

const stdin = args.includes('-') ? readFileSync(0, 'utf8') : '';
let common = cwd;
const listed = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
if (listed.status === 0 && listed.stdout.trim()) {
  const gitDir = listed.stdout.trim();
  common = path.dirname(path.isAbsolute(gitDir) ? gitDir : path.resolve(cwd, gitDir));
}
const modeFile = path.join(common, '.fake-codex-mode');
const mode = existsSync(modeFile) ? readFileSync(modeFile, 'utf8').trim() : 'complete';
writeFileSync(path.join(cwd, '.fake-argv.json'), JSON.stringify(args));
writeFileSync(path.join(cwd, '.fake-prompt.txt'), stdin);
const runsPath = path.join(cwd, '.fake-runs');
const runs = existsSync(runsPath) ? Number(readFileSync(runsPath, 'utf8')) : 0;
writeFileSync(runsPath, String(runs + 1));
const threadFile = path.join(cwd, '.fake-thread');
const resumeAt = args.indexOf('resume');
const requested = resumeAt >= 0 ? args[resumeAt + 1] : undefined;
const thread = requested && requested !== '-' ? requested : existsSync(threadFile) ? readFileSync(threadFile, 'utf8').trim() : randomUUID();
writeFileSync(threadFile, thread);

process.on('SIGTERM', () => process.exit(143));
process.on('SIGINT', () => process.exit(130));

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const output = value('-o');
if (mode === 'hang') {
  emit({ type: 'thread.started', thread_id: thread });
  setInterval(() => undefined, 1000);
} else if (mode === 'slow') {
  setTimeout(() => {
    emit({ type: 'thread.started', thread_id: thread });
    emit({ type: 'turn.completed' });
    if (output) writeFileSync(output, 'slow\n');
    process.exit(0);
  }, 1200);
} else if (mode === 'rate_limit') {
  emit({ type: 'thread.started', thread_id: thread });
  emit({ type: 'turn.started' });
  emit({ type: 'error', message: "You've reached your Codex usage limit. Try again later." });
  emit({ type: 'turn.failed', error: { message: 'usage limit exceeded' } });
  process.exit(1);
} else if (mode === 'needs_input') {
  emit({ type: 'thread.started', thread_id: thread });
  emit({ type: 'error', message: 'approval required: waiting for user input' });
  process.exit(2);
} else if (mode === 'fail') {
  emit({ type: 'thread.started', thread_id: thread });
  emit({ type: 'turn.failed', error: { message: 'synthetic failure' } });
  process.exit(1);
} else if (mode === 'leak') {
  emit({ type: 'thread.started', thread_id: thread });
  process.stderr.write('OPENAI_API_KEY=sk-supersecretvalue123456\n');
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'done' } });
  emit({ type: 'turn.completed' });
  if (output) writeFileSync(output, 'done\n');
  process.exit(0);
} else {
  if (mode === 'autofix' && stdin.includes('VERIFICATION FAILED')) writeFileSync(path.join(cwd, 'fixed.txt'), 'ok\n');
  if (stdin.includes('WRITE_FILE')) writeFileSync(path.join(cwd, 'hello.txt'), 'bridge-ok\n');
  emit({ type: 'thread.started', thread_id: thread });
  emit({ type: 'turn.started' });
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Fake Codex completed the turn.' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } });
  if (output) writeFileSync(output, 'Fake Codex completed the turn.\n');
  process.exit(0);
}
