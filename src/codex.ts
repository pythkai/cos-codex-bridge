import { spawn } from 'node:child_process';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { collectText, isNeedsInput, isRateLimited } from './limits.js';
import { redact } from './redact.js';
import { BridgeError } from './errors.js';
import type { SandboxMode } from './store.js';

const BANNED = ['dangerously-bypass-approvals-and-sandbox', '--yolo', '--full-auto', 'danger-full-access', '--ignore-rules', '--ephemeral'];

export interface CodexArgs {
  cwd: string;
  sandbox: SandboxMode;
  lastMessagePath: string;
  threadId?: string;
  model?: string;
}

export function buildCodexArgs(options: CodexArgs): string[] {
  const args = ['-a', 'never', 'exec', '--json', '--color', 'never', '--sandbox', options.sandbox, '-C', options.cwd, '-o', options.lastMessagePath];
  if (options.model) args.push('--model', options.model);
  if (options.threadId) args.push('resume', options.threadId);
  args.push('-');
  assertSafeArgs(args);
  return args;
}

export function assertSafeArgs(args: readonly string[]): void {
  const joined = args.join(' ');
  for (const banned of BANNED) {
    if (joined.includes(banned)) throw new BridgeError('POLICY', 'Refusing to launch Codex with a sandbox bypass flag.');
  }
  if (!args.includes('--sandbox') || !args.includes('never')) throw new BridgeError('POLICY', 'Codex must run with an explicit sandbox and without interactive approval escalation.');
}

export interface CodexResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  threadId?: string;
  lastMessage: string;
  rateLimited: boolean;
  needsInput: boolean;
  turnCompleted: boolean;
  turnFailed: boolean;
  errorMessage?: string;
  stopped: 'cancel' | 'timeout' | null;
  spawnFailed: boolean;
}

export interface CodexHandle {
  pid: number;
  result: Promise<CodexResult>;
  kill: (reason: 'cancel' | 'timeout') => void;
}

export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process is already gone.
    }
  }
}

export function startCodex(options: {
  binary: string;
  args: string[];
  prompt: string;
  lastMessagePath: string;
  stdoutPath: string;
  stderrPath: string;
  timeoutMs: number;
  secrets?: readonly string[];
  log: (stream: 'event' | 'stderr' | 'meta', data: string) => Promise<void> | void;
  onThread?: (threadId: string) => void;
}): CodexHandle {
  assertSafeArgs(options.args);
  const stdoutFd = openSync(options.stdoutPath, 'a', 0o600);
  const stderrFd = openSync(options.stderrPath, 'a', 0o600);
  const child = spawn(options.binary, options.args, {
    detached: true,
    stdio: ['pipe', stdoutFd, stderrFd],
    env: process.env,
  });
  closeSync(stdoutFd);
  closeSync(stderrFd);
  const pid = child.pid;
  if (!pid) throw new BridgeError('CODEX_UNAVAILABLE', 'Codex did not start.');

  let stdoutBuf = '';
  let threadId: string | undefined;
  let lastAgent = '';
  let rateLimited = false;
  let needsInput = false;
  let turnCompleted = false;
  let turnFailed = false;
  let errorMessage: string | undefined;
  let stopped: 'cancel' | 'timeout' | null = null;
  let settled = false;
  let spawnFailed = false;
  const secrets = options.secrets ?? [];

  const killTimer = { current: undefined as NodeJS.Timeout | undefined };
  const kill = (reason: 'cancel' | 'timeout') => {
    if (stopped) return;
    stopped = reason;
    signalGroup(pid, 'SIGTERM');
    killTimer.current = setTimeout(() => signalGroup(pid, 'SIGKILL'), 2000);
    killTimer.current.unref();
  };

  const note = (text: string) => {
    if (isRateLimited(text)) rateLimited = true;
    if (isNeedsInput(text)) needsInput = true;
  };

  const pendingLogs: Promise<unknown>[] = [];
  const handleLine = (line: string) => {
    const safe = redact(line, secrets).slice(0, 8000);
    pendingLogs.push(Promise.resolve(options.log('event', safe)));
    note(safe);
    let parsed: unknown;
    try {
      parsed = JSON.parse(safe);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const record = parsed as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : '';
    const body = collectText(parsed);
    note(body);
    if (type === 'thread.started') {
      const id = typeof record.thread_id === 'string' ? record.thread_id : typeof record.threadId === 'string' ? record.threadId : undefined;
      if (id && id.length <= 200 && !id.includes('\n')) {
        threadId = id;
        options.onThread?.(id);
      }
    }
    if (type === 'turn.completed') turnCompleted = true;
    if (type === 'turn.failed') turnFailed = true;
    if (type === 'error' || type === 'turn.failed') {
      const message = body.replace(/\s+/g, ' ').trim();
      if (message) errorMessage = message.slice(0, 500);
    }
    const item = record.item;
    if (item && typeof item === 'object') {
      const typed = item as Record<string, unknown>;
      if (typeof typed.type === 'string' && /user_input|request_user_input/.test(typed.type)) needsInput = true;
      if (typed.type === 'agent_message' && typeof typed.text === 'string') lastAgent = typed.text;
    }
  };

  const result = new Promise<CodexResult>((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (killTimer.current) clearTimeout(killTimer.current);
      void (async () => {
        await drain();
        if (stdoutBuf.trim()) handleLine(stdoutBuf.trim());
        stdoutBuf = '';
        await Promise.all(pendingLogs);
        await scrub(options.stdoutPath, secrets);
        await scrub(options.stderrPath, secrets);
        let fileText = '';
        try {
          fileText = await readFile(options.lastMessagePath, 'utf8');
        } catch {
          fileText = '';
        }
        const lastMessage = redact(fileText || lastAgent, secrets).slice(0, 32_000);
        note(lastMessage);
        resolve({
          exitCode: code,
          signal,
          ...(threadId ? { threadId } : {}),
          lastMessage,
          rateLimited,
          needsInput,
          turnCompleted,
          turnFailed,
          ...(errorMessage ? { errorMessage: redact(errorMessage, secrets).slice(0, 500) } : {}),
          stopped,
          spawnFailed,
        });
      })();
    };

    let stdoutOffset = 0;
    let stderrOffset = 0;
    let draining: Promise<void> = Promise.resolve();
    const drain = () => {
      draining = draining.then(async () => {
        const out = readAppended(options.stdoutPath, stdoutOffset);
        stdoutOffset = out.offset;
        stdoutBuf += out.text;
        if (stdoutBuf.length > 8_000_000) {
          errorMessage = 'Codex output exceeded the bridge capture limit.';
          kill('timeout');
          return;
        }
        let index = stdoutBuf.indexOf('\n');
        while (index >= 0) {
          const line = stdoutBuf.slice(0, index).replace(/\r$/, '');
          stdoutBuf = stdoutBuf.slice(index + 1);
          if (line.trim()) handleLine(line);
          index = stdoutBuf.indexOf('\n');
        }
        const err = readAppended(options.stderrPath, stderrOffset);
        stderrOffset = err.offset;
        if (err.text) {
          const text = redact(err.text, secrets).slice(0, 4000);
          pendingLogs.push(Promise.resolve(options.log('stderr', text)));
          note(text);
        }
      });
      return draining;
    };
    const poll = setInterval(() => { void drain(); }, 40);
    child.on('error', (error) => {
      spawnFailed = true;
      errorMessage = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'Cannot start Codex. Install the Codex CLI and check codexBinary.'
        : 'Codex process failed to start.';
      finish(null, null);
    });
    child.on('exit', (code, signal) => {
      finish(code, signal);
    });
    const timer = setTimeout(() => kill('timeout'), options.timeoutMs);
    const stdin = child.stdin;
    if (!stdin) throw new BridgeError('CODEX_UNAVAILABLE', 'Codex input pipe was not created.');
    stdin.on('error', () => undefined);
    stdin.write(options.prompt, (error) => {
      if (!error) stdin.end();
    });
  });

  return { pid, result, kill };
}

function readAppended(file: string, offset: number): { text: string; offset: number } {
  try {
    const size = statSync(file).size;
    if (size <= offset) return { text: '', offset };
    const fd = openSync(file, 'r');
    const buffer = Buffer.alloc(size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    closeSync(fd);
    return { text: buffer.toString('utf8'), offset: size };
  } catch {
    return { text: '', offset };
  }
}

async function scrub(file: string, secrets: readonly string[]): Promise<void> {
  try {
    const raw = await readFile(file, 'utf8');
    await writeFile(file, redact(raw, secrets), { mode: 0o600 });
    await chmod(file, 0o600);
  } catch {
    // The capture file may not exist when Codex fails to start.
  }
}
