import { appendFile, chmod, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError } from './errors.js';
import type { Config } from './config.js';

export type TaskStatus = 'queued' | 'running' | 'needs_input' | 'completed' | 'failed' | 'cancelled' | 'rate_limited' | 'interrupted';
export type SandboxMode = 'read-only' | 'workspace-write';
export type AttemptKind = 'launch' | 'resume' | 'redirect' | 'autofix';

export interface Attempt {
  n: number;
  kind: AttemptKind;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  status?: TaskStatus;
}

export interface TestResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  excerpt: string;
  truncated: boolean;
  ranAt: string;
  durationMs: number;
}

export interface Task {
  id: string;
  requestId: string;
  project: string;
  projectRoot: string;
  worktree: string;
  branch: string;
  baseSha: string;
  sandbox: SandboxMode;
  model?: string;
  threadId?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  runStartedAt?: string;
  finishedAt?: string;
  deadlineAt?: string;
  pid?: number;
  ownerPid?: number;
  detached?: boolean;
  cancelRequested?: boolean;
  pendingKind?: AttemptKind;
  queuedPhase?: AttemptKind | 'verify';
  promptSha256: string;
  responseExcerpt?: string;
  responseTruncated?: boolean;
  error?: { code: string; message: string };
  attempts: Attempt[];
  runAttempts: number;
  autoFix: { enabled: boolean; maxAttempts: number; maxWallTimeSeconds: number; scope: 'worktree' };
  runTests: boolean;
  testCommand?: string;
  tests: TestResult[];
  includeMemory: boolean;
  logTruncated?: boolean;
  note?: string;
  cleaned?: boolean;
}

interface RequestEntry {
  taskId: string;
  fingerprint: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class Store {
  private writes = new Map<string, Promise<void>>();
  private logs = new Map<string, Promise<void>>();
  private requestChain: Promise<void> = Promise.resolve();

  constructor(public config: Config) {}

  async init(): Promise<void> {
    for (const name of ['receipts', 'payloads', 'logs', 'memory', 'worktrees', 'locks']) {
      const dir = path.join(this.config.stateDir, name);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const info = await lstat(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new BridgeError('CONFIG', 'State subdirectories must be real directories.');
      await chmod(dir, 0o700);
    }
  }

  receiptPath(id: string): string {
    this.assertId(id);
    return path.join(this.config.stateDir, 'receipts', `${id}.json`);
  }

  payloadPath(id: string): string {
    this.assertId(id);
    return path.join(this.config.stateDir, 'payloads', `${id}.json`);
  }

  logPath(id: string): string {
    this.assertId(id);
    return path.join(this.config.stateDir, 'logs', `${id}.jsonl`);
  }

  lastMessagePath(id: string): string {
    this.assertId(id);
    return path.join(this.config.stateDir, 'logs', `${id}.last.txt`);
  }

  rawStdoutPath(id: string): string {
    this.assertId(id);
    return path.join(this.config.stateDir, 'logs', `${id}.stdout`);
  }

  rawStderrPath(id: string): string {
    this.assertId(id);
    return path.join(this.config.stateDir, 'logs', `${id}.stderr`);
  }

  worktreePath(id: string): string {
    this.assertId(id);
    return path.join(this.config.stateDir, 'worktrees', id);
  }

  memoryPath(alias: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(alias)) throw new BridgeError('INVALID_ARGUMENT', 'Project alias is not valid.');
    return path.join(this.config.stateDir, 'memory', `${alias}.md`);
  }

  assertId(id: string): void {
    if (!UUID.test(id)) throw new BridgeError('INVALID_ID', 'Invalid task identifier.');
  }

  async writeNew(task: Task): Promise<void> {
    this.assertId(task.id);
    task.updatedAt = new Date().toISOString();
    const file = this.receiptPath(task.id);
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(task, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  }

  async mutate(id: string, change: (task: Task) => void): Promise<Task> {
    const previous = this.writes.get(id) ?? Promise.resolve();
    let saved!: Task;
    const next = previous.then(async () => {
      const task = await this.get(id);
      change(task);
      task.updatedAt = new Date().toISOString();
      await this.atomic(this.receiptPath(id), task);
      saved = task;
    });
    this.writes.set(id, next.then(() => undefined, () => undefined));
    await next;
    return saved;
  }

  async get(id: string): Promise<Task> {
    try {
      return JSON.parse(await readFile(this.receiptPath(id), 'utf8')) as Task;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('NOT_FOUND', 'Task not found.');
    }
  }

  async listTasks(): Promise<Task[]> {
    const files = await readdir(path.join(this.config.stateDir, 'receipts'));
    const tasks: Task[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        tasks.push(await this.get(file.slice(0, -5)));
      } catch {
        // Skip a corrupt receipt rather than hiding every other task.
      }
    }
    tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    return tasks;
  }

  async putPayload(id: string, value: unknown): Promise<void> {
    await this.atomic(this.payloadPath(id), value);
  }

  async getPayload(id: string): Promise<{ prompt?: string; fingerprint?: string }> {
    try {
      return JSON.parse(await readFile(this.payloadPath(id), 'utf8')) as { prompt?: string };
    } catch {
      throw new BridgeError('NOT_FOUND', 'Task payload not found.');
    }
  }

  async peekRequest(requestId: string): Promise<RequestEntry | undefined> {
    try {
      const map = JSON.parse(await readFile(path.join(this.config.stateDir, 'requests.json'), 'utf8')) as Record<string, RequestEntry>;
      return map[requestId];
    } catch {
      return undefined;
    }
  }

  async rememberRequest(requestId: string, fingerprint: string, taskId: string): Promise<{ taskId: string; duplicate: boolean }> {
    let outcome!: { taskId: string; duplicate: boolean };
    const next = this.requestChain.then(async () => {
      const file = path.join(this.config.stateDir, 'requests.json');
      let map: Record<string, RequestEntry> = {};
      try {
        map = JSON.parse(await readFile(file, 'utf8')) as Record<string, RequestEntry>;
      } catch {
        map = {};
      }
      const existing = map[requestId];
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new BridgeError('CONFLICT', 'requestId was already used with different content.');
        outcome = { taskId: existing.taskId, duplicate: true };
        return;
      }
      map[requestId] = { taskId, fingerprint };
      await this.atomic(file, map);
      outcome = { taskId, duplicate: false };
    });
    this.requestChain = next.then(() => undefined, () => undefined);
    await next;
    return outcome;
  }

  async appendLog(id: string, stream: 'event' | 'stderr' | 'meta', data: unknown): Promise<{ truncated: boolean }> {
    const file = this.logPath(id);
    const line = `${JSON.stringify({ at: new Date().toISOString(), stream, data })}\n`;
    const previous = this.logs.get(id) ?? Promise.resolve();
    let truncated = false;
    const next = previous.then(async () => {
      const info = await lstat(file).catch(() => undefined);
      if (info && info.size > 2_000_000) {
        truncated = true;
        return;
      }
      await appendFile(file, line, { mode: 0o600 });
      await chmod(file, 0o600).catch(() => undefined);
    });
    this.logs.set(id, next.then(() => undefined, () => undefined));
    await next;
    return { truncated };
  }

  async readLogLines(id: string): Promise<string[]> {
    try {
      const raw = await readFile(this.logPath(id), 'utf8');
      return raw.split('\n').filter((line) => line.length > 0);
    } catch {
      return [];
    }
  }

  async readMemory(alias: string): Promise<string> {
    try {
      return await readFile(this.memoryPath(alias), 'utf8');
    } catch {
      return '';
    }
  }

  async writeMemory(alias: string, text: string, append: boolean): Promise<string> {
    const file = this.memoryPath(alias);
    const next = append ? `${await this.readMemory(alias)}${text}` : text;
    if (Buffer.byteLength(next) > 64 * 1024) throw new BridgeError('SIZE_LIMIT', 'Project memory is limited to 64 KiB.');
    await writeFile(file, next, { mode: 0o600 });
    return next;
  }

  private async atomic(file: string, value: unknown): Promise<void> {
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  }
}

export function alive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
