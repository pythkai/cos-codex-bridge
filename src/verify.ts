import { spawn } from 'node:child_process';
import { redact } from './redact.js';
import { signalGroup } from './codex.js';
import type { TestResult } from './store.js';

export async function runProjectTests(options: { command: string; cwd: string; timeoutMs: number; secrets?: readonly string[] }): Promise<TestResult> {
  const started = Date.now();
  const child = spawn('sh', ['-c', options.command], {
    cwd: options.cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  let output = '';
  const capture = (chunk: Buffer) => {
    output += chunk.toString('utf8');
    if (output.length > 32_000) output = output.slice(-32_000);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    const timer = setTimeout(() => {
      if (child.pid) signalGroup(child.pid, 'SIGKILL');
    }, options.timeoutMs);
    child.on('error', () => resolve({ code: null, signal: null }));
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  const clean = redact(output, options.secrets ?? []);
  const truncated = clean.length > 4000;
  return {
    command: options.command,
    ok: outcome.code === 0,
    exitCode: outcome.code,
    signal: outcome.signal,
    excerpt: truncated ? clean.slice(0, 4000) : clean,
    truncated,
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
}
