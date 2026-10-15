import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { canWrite, inside, type Config } from './config.js';
import { buildCodexArgs, signalGroup, startCodex, type CodexResult } from './codex.js';
import { BridgeError } from './errors.js';
import { createTaskWorktree, inspectWorktree, removeTaskWorktree } from './git.js';
import { isNeedsInput, isRateLimited } from './limits.js';
import { autofixPrompt, taskPrompt } from './prompt.js';
import { excerpt, redact } from './redact.js';
import { alive, Store, type AttemptKind, type Task, type TaskStatus } from './store.js';
import { runProjectTests } from './verify.js';

interface Job {
  id: string;
  kind: AttemptKind | 'verify';
}

export interface RecoverySummary {
  interrupted: number;
  detached: number;
  requeued: number;
  rateLimited: number;
}

const TERMINAL = new Set<TaskStatus>(['completed', 'failed', 'cancelled', 'rate_limited', 'interrupted', 'needs_input']);

export class Runner {
  private pending: Job[] = [];
  private active = new Map<string, { kill: (reason: 'cancel' | 'timeout') => void }>();
  private detachedIds = new Set<string>();
  private pumping = false;
  readonly recovery: RecoverySummary = { interrupted: 0, detached: 0, requeued: 0, rateLimited: 0 };

  constructor(private config: Config, private store: Store) {}

  async recover(): Promise<void> {
    for (const task of await this.store.listTasks()) {
      if (task.status === 'queued') {
        this.pending.push({ id: task.id, kind: task.queuedPhase ?? task.pendingKind ?? 'launch' });
        this.recovery.requeued += 1;
        continue;
      }
      if (task.status !== 'running') {
        if (task.status === 'rate_limited') this.recovery.rateLimited += 1;
        continue;
      }
      if (task.pid && alive(task.pid)) {
        await this.store.mutate(task.id, (current) => {
          current.detached = true;
          current.note = 'Bridge restarted while Codex was still running. Output from this process is no longer attached. No new attempt was started.';
        });
        this.detachedIds.add(task.id);
        this.recovery.detached += 1;
        continue;
      }
      const recovered = await this.reconcile(task);
      await this.store.mutate(task.id, (current) => {
        current.status = recovered.status;
        current.detached = false;
        delete current.pid;
        current.finishedAt = new Date().toISOString();
        current.note = recovered.note;
        if (recovered.error) current.error = recovered.error;
      });
      if (recovered.status === 'interrupted') this.recovery.interrupted += 1;
      if (recovered.status === 'rate_limited') this.recovery.rateLimited += 1;
    }
    this.pump();
  }

  async launch(task: Task, prompt: string): Promise<Task> {
    await this.store.putPayload(task.id, { prompt });
    task.queuedPhase = 'launch';
    await this.store.writeNew(task);
    this.enqueue(task.id, 'launch');
    return this.store.get(task.id);
  }

  async followUp(taskId: string, kind: 'resume' | 'redirect', prompt: string, requestId: string): Promise<Task> {
    if (kind === 'redirect') await this.cancel(taskId);
    const current = await this.store.get(taskId);
    if (current.status === 'running' || current.status === 'queued') throw new BridgeError('BUSY', 'Task is still running. Use bridge_redirect to interrupt it, or wait.');
    if (current.cleaned) throw new BridgeError('NOT_FOUND', 'Task worktree was removed.');
    await this.store.putPayload(taskId, { prompt });
    const updated = await this.store.mutate(taskId, (task) => {
      task.requestId = requestId;
      task.pendingKind = kind;
      task.queuedPhase = kind;
      task.status = 'queued';
      task.runAttempts = 0;
      task.cancelRequested = false;
      task.detached = false;
      delete task.pid;
      delete task.finishedAt;
      delete task.error;
      this.armBudget(task);
    });
    this.enqueue(taskId, kind);
    return updated;
  }

  async autofix(taskId: string, limits?: { maxAttempts?: number; maxWallTimeSeconds?: number }): Promise<Task> {
    const current = await this.store.get(taskId);
    if (current.status === 'running' || current.status === 'queued') throw new BridgeError('BUSY', 'Task is still running.');
    if (current.status === 'rate_limited') {
      throw new BridgeError('RATE_LIMITED', 'Codex reported a usage limit. Automatic retries stay off. Wait, then call bridge_resume if you want another turn.');
    }
    if (current.cleaned) throw new BridgeError('NOT_FOUND', 'Task worktree was removed.');
    const updated = await this.store.mutate(taskId, (task) => {
      task.autoFix.enabled = true;
      task.autoFix.maxAttempts = Math.min(limits?.maxAttempts ?? this.config.autoFix.maxAttempts, this.config.autoFix.maxAttempts);
      task.autoFix.maxWallTimeSeconds = Math.min(limits?.maxWallTimeSeconds ?? this.config.autoFix.maxWallTimeSeconds, this.config.autoFix.maxWallTimeSeconds);
      task.runTests = Boolean(task.testCommand);
      task.pendingKind = 'autofix';
      task.queuedPhase = 'verify';
      task.status = 'queued';
      task.runAttempts = 0;
      task.cancelRequested = false;
      delete task.finishedAt;
      delete task.error;
      this.armBudget(task);
    });
    this.enqueue(taskId, 'verify');
    return updated;
  }

  async cancel(taskId: string): Promise<Task> {
    const task = await this.store.get(taskId);
    if (TERMINAL.has(task.status)) return task;
    await this.store.mutate(taskId, (current) => {
      current.cancelRequested = true;
    });
    this.pending = this.pending.filter((job) => job.id !== taskId);
    const active = this.active.get(taskId);
    if (active) {
      active.kill('cancel');
      await this.waitUntil(taskId, (status) => status !== 'running' && status !== 'queued', 8_000);
      return this.store.get(taskId);
    }
    const fresh = await this.store.get(taskId);
    if (fresh.pid && alive(fresh.pid)) {
      signalGroup(fresh.pid, 'SIGTERM');
      await sleep(400);
      if (alive(fresh.pid)) signalGroup(fresh.pid, 'SIGKILL');
    }
    this.releaseDetached(taskId);
    return this.store.mutate(taskId, (current) => {
      if (current.status === 'running' || current.status === 'queued') {
        current.status = 'cancelled';
        current.error = { code: 'CANCELLED', message: 'Cancellation was requested. No further attempt will start.' };
        current.finishedAt = new Date().toISOString();
        current.detached = false;
        delete current.pid;
      }
    });
  }

  async cleanup(taskId: string, approvalToken: string, discardChanges: boolean): Promise<Task> {
    this.assertApproval(approvalToken);
    const task = await this.store.get(taskId);
    if (task.status === 'running' || task.status === 'queued') throw new BridgeError('BUSY', 'Cancel the task and wait until it stops before removing its worktree.');
    const root = pathJoinWorktrees(this.store.config.stateDir);
    if (!inside(root, task.worktree)) throw new BridgeError('POLICY', 'Refusing to delete a worktree outside the bridge state directory.');
    try {
      await removeTaskWorktree({ repo: task.projectRoot, worktree: task.worktree, branch: task.branch, discardChanges });
    } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== 'NOT_FOUND') throw error;
    }
    return this.store.mutate(taskId, (current) => {
      current.cleaned = true;
      current.note = 'Worktree removal was approved by the caller. The receipt is kept.';
    });
  }

  assertApproval(approvalToken: string): void {
    const expected = this.config.approvalToken;
    if (!expected) throw new BridgeError('APPROVAL_REQUIRED', 'Destructive cleanup is disabled until approvalToken is set in the private config.');
    const left = Buffer.from(expected);
    const right = Buffer.from(approvalToken);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new BridgeError('APPROVAL_REQUIRED', 'The approval token does not match the private config.');
    }
  }

  async report(taskId: string): Promise<Record<string, unknown>> {
    const task = await this.refresh(taskId);
    let git: { diffStat: string; files: string[]; commits: Array<{ sha: string; subject: string }> } | { unavailable: string };
    try {
      git = task.cleaned ? { unavailable: 'Worktree was removed.' } : await inspectWorktree(task.worktree, task.baseSha);
    } catch (error) {
      git = { unavailable: error instanceof BridgeError ? error.message : 'Git inspection failed.' };
    }
    return {
      taskId: task.id,
      project: task.project,
      status: task.status,
      threadId: task.threadId ?? null,
      branch: task.branch,
      baseSha: task.baseSha,
      worktree: task.worktree,
      sandbox: task.sandbox,
      attempts: task.attempts,
      runAttempts: task.runAttempts,
      autoFix: task.autoFix,
      tests: task.tests,
      error: task.error ?? null,
      note: task.note ?? null,
      responseExcerpt: task.responseExcerpt ?? '',
      git,
    };
  }

  async refresh(taskId: string): Promise<Task> {
    const task = await this.store.get(taskId);
    if (task.status === 'running' && task.detached && task.pid && !alive(task.pid)) {
      this.releaseDetached(taskId);
      const recovered = await this.reconcile(task);
      return this.store.mutate(taskId, (current) => {
        current.status = recovered.status;
        current.note = recovered.note;
        current.detached = false;
        delete current.pid;
        current.finishedAt = new Date().toISOString();
        if (recovered.error) current.error = recovered.error;
      });
    }
    return task;
  }

  secrets(): string[] {
    return this.config.approvalToken ? [this.config.approvalToken] : [];
  }

  private releaseDetached(id: string): void {
    if (this.detachedIds.delete(id)) this.pump();
  }

  private enqueue(id: string, kind: Job['kind']): void {
    if (this.pending.some((job) => job.id === id) || this.active.has(id)) return;
    this.pending.push({ id, kind });
    this.pump();
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.active.size + this.detachedIds.size < this.config.maxConcurrentTasks && this.pending.length > 0) {
        const job = this.pending.shift();
        if (!job) break;
        void this.execute(job.id, job.kind);
      }
    } finally {
      this.pumping = false;
    }
  }

  private execute(taskId: string, kind: Job['kind']): Promise<void> {
    if (this.active.has(taskId)) return Promise.resolve();
    let kill: (reason: 'cancel' | 'timeout') => void = () => undefined;
    this.active.set(taskId, { kill: (reason) => kill(reason) });
    return this.runLoop(taskId, kind, (next) => {
      kill = next;
    }).finally(() => {
      this.active.delete(taskId);
      this.pump();
    });
  }

  private async runLoop(taskId: string, kind: Job['kind'], bindKill: (kill: (reason: 'cancel' | 'timeout') => void) => void): Promise<void> {
    let phase = kind;
    try {
      while (true) {
        const snapshot = await this.store.get(taskId);
        if (snapshot.cancelRequested) {
          await this.finish(taskId, 'cancelled', { code: 'CANCELLED', message: 'Cancelled before the next attempt.' });
          return;
        }
        if (snapshot.deadlineAt && Date.now() > Date.parse(snapshot.deadlineAt)) {
          await this.finish(taskId, 'failed', { code: 'WALL_TIME', message: 'Stopped because the task wall-time limit was reached. No further attempt was started.' });
          return;
        }
        if (phase === 'verify') {
          const verified = await this.verify(taskId);
          if (verified === 'passed' || verified === 'missing') {
            await this.finish(taskId, verified === 'passed' ? 'completed' : 'failed', verified === 'missing' ? { code: 'NO_TEST', message: 'Auto-fix needs a testCommand configured for this project.' } : undefined);
            return;
          }
          phase = 'autofix';
          continue;
        }
        if (phase === 'autofix' && !this.canAutofix(await this.store.get(taskId))) {
          await this.finish(taskId, 'failed', { code: 'ATTEMPT_LIMIT', message: 'Stopped because the auto-fix attempt limit was reached.' });
          return;
        }
        const kind: AttemptKind = phase;
        const prepared = await this.store.mutate(taskId, (task) => {
          task.status = 'running';
          task.detached = false;
          task.ownerPid = process.pid;
          delete task.pendingKind;
          task.runAttempts += 1;
          task.attempts.push({ n: task.attempts.length + 1, kind, startedAt: new Date().toISOString() });
        });
        const prompt = await this.promptFor(prepared, kind);
        const args = buildCodexArgs({
          cwd: prepared.worktree,
          sandbox: prepared.sandbox,
          lastMessagePath: this.store.lastMessagePath(prepared.id),
          ...(prepared.threadId ? { threadId: prepared.threadId } : {}),
          ...(prepared.model ? { model: prepared.model } : {}),
        });
        let truncated = false;
        const handle = startCodex({
          binary: this.config.codexBinary,
          args,
          prompt,
          lastMessagePath: this.store.lastMessagePath(prepared.id),
          stdoutPath: this.store.rawStdoutPath(prepared.id),
          stderrPath: this.store.rawStderrPath(prepared.id),
          timeoutMs: this.config.attemptTimeoutSeconds * 1000,
          secrets: this.secrets(),
          log: async (stream, data) => {
            if (truncated) return;
            const result = await this.store.appendLog(taskId, stream, data);
            if (result.truncated) truncated = true;
          },
          onThread: (threadId) => {
            void this.store.mutate(taskId, (task) => {
              task.threadId = threadId;
            });
          },
        });
        bindKill(handle.kill);
        await this.store.mutate(taskId, (task) => {
          task.pid = handle.pid;
          if (truncated) task.logTruncated = true;
        });
        const result = await handle.result;
        const outcome = this.classify(result);
        await this.store.mutate(taskId, (task) => {
          if (result.threadId) task.threadId = result.threadId;
          delete task.pid;
          const response = excerpt(result.lastMessage, 4000);
          task.responseExcerpt = response.text;
          task.responseTruncated = response.truncated;
          if (truncated) task.logTruncated = true;
          const attempt = task.attempts[task.attempts.length - 1];
          if (attempt) {
            attempt.finishedAt = new Date().toISOString();
            attempt.exitCode = result.exitCode;
            attempt.status = outcome.status;
          }
          if (outcome.error) task.error = outcome.error;
        });
        if (outcome.status === 'cancelled' || outcome.status === 'rate_limited' || outcome.status === 'needs_input') {
          await this.finish(taskId, outcome.status, outcome.error);
          return;
        }
        if (outcome.status === 'failed') {
          const latest = await this.store.get(taskId);
          if (!result.spawnFailed && this.canAutofix(latest)) {
            phase = 'autofix';
            continue;
          }
          await this.finish(taskId, 'failed', outcome.error);
          return;
        }
        const tested = await this.verify(taskId);
        if (tested === 'failed') {
          const latest = await this.store.get(taskId);
          if (this.canAutofix(latest)) {
            phase = 'autofix';
            continue;
          }
          await this.finish(taskId, 'failed', { code: 'TEST_FAILED', message: 'Verification failed. The auto-fix limit was reached, so no further attempt was started.' });
          return;
        }
        await this.finish(taskId, 'completed');
        return;
      }
    } catch (error) {
      const message = error instanceof BridgeError ? error.message : 'Task runner failed.';
      const code = error instanceof BridgeError ? error.code : 'INTERNAL';
      await this.finish(taskId, 'failed', { code, message: redact(message, this.secrets()) }).catch(() => undefined);
    }
  }

  private classify(result: CodexResult): { status: TaskStatus; error?: { code: string; message: string } } {
    if (result.stopped === 'cancel') return { status: 'cancelled', error: { code: 'CANCELLED', message: 'Codex was interrupted.' } };
    if (result.rateLimited) {
      return { status: 'rate_limited', error: { code: 'RATE_LIMITED', message: result.errorMessage || 'Codex reported a usage or rate limit. No further attempts will start automatically.' } };
    }
    if (result.needsInput) {
      return { status: 'needs_input', error: { code: 'NEEDS_INPUT', message: result.errorMessage || 'Codex is waiting for input. The bridge will not approve permissions or invent an answer.' } };
    }
    if (result.stopped === 'timeout') return { status: 'failed', error: { code: 'TIMEOUT', message: 'The Codex attempt exceeded its time limit.' } };
    if (result.spawnFailed) return { status: 'failed', error: { code: 'CODEX_UNAVAILABLE', message: result.errorMessage || 'Codex is not available.' } };
    if (result.turnFailed || result.exitCode !== 0) {
      return { status: 'failed', error: { code: 'CODEX_FAILED', message: result.errorMessage || `Codex exited with code ${String(result.exitCode)}.` } };
    }
    return { status: 'completed' };
  }

  private async verify(taskId: string): Promise<'passed' | 'failed' | 'missing' | 'skipped'> {
    const task = await this.store.get(taskId);
    if (!task.runTests) return 'skipped';
    if (!task.testCommand) return 'missing';
    const result = await runProjectTests({
      command: task.testCommand,
      cwd: task.worktree,
      timeoutMs: this.config.testTimeoutSeconds * 1000,
      secrets: this.secrets(),
    });
    await this.store.mutate(taskId, (current) => {
      current.tests.push(result);
    });
    return result.ok ? 'passed' : 'failed';
  }

  private canAutofix(task: Task): boolean {
    if (!task.autoFix.enabled || task.cancelRequested) return false;
    if (task.runAttempts >= task.autoFix.maxAttempts) return false;
    if (task.deadlineAt && Date.now() > Date.parse(task.deadlineAt)) return false;
    return true;
  }

  private async promptFor(task: Task, kind: AttemptKind | 'verify'): Promise<string> {
    if (kind === 'autofix') return autofixPrompt(task);
    const payload = await this.store.getPayload(task.id);
    const prompt = payload.prompt ?? '';
    const memory = task.includeMemory ? await this.store.readMemory(task.project) : '';
    return taskPrompt(prompt, memory);
  }

  private armBudget(task: Task): void {
    const now = Date.now();
    task.runStartedAt = new Date(now).toISOString();
    task.deadlineAt = new Date(now + task.autoFix.maxWallTimeSeconds * 1000).toISOString();
  }

  private async finish(taskId: string, status: TaskStatus, error?: { code: string; message: string }): Promise<void> {
    await this.store.mutate(taskId, (task) => {
      task.status = status;
      task.finishedAt = new Date().toISOString();
      task.detached = false;
      delete task.pid;
      delete task.pendingKind;
      if (error) task.error = { code: error.code, message: redact(error.message, this.secrets()).slice(0, 500) };
      else if (status === 'completed') delete task.error;
    });
  }

  private async reconcile(task: Task): Promise<{ status: TaskStatus; note: string; error?: { code: string; message: string } }> {
    const text = (await this.store.readLogLines(task.id)).join('\n');
    if (isRateLimited(text)) {
      return {
        status: 'rate_limited',
        note: 'Recovered from the saved log after a bridge restart. No retry was started.',
        error: { code: 'RATE_LIMITED', message: 'Codex reported a usage or rate limit before the bridge restarted.' },
      };
    }
    if (isNeedsInput(text)) {
      return {
        status: 'needs_input',
        note: 'Recovered from the saved log. The bridge will not answer or approve anything automatically.',
        error: { code: 'NEEDS_INPUT', message: 'Codex was waiting for input when the bridge restarted.' },
      };
    }
    if (text.includes('"turn.failed"')) {
      return {
        status: 'failed',
        note: 'Recovered from a turn.failed event in the saved log.',
        error: { code: 'CODEX_FAILED', message: 'Codex reported a failed turn before the bridge restarted.' },
      };
    }
    if (text.includes('"turn.completed"')) {
      if (task.runTests && task.testCommand && task.tests.length === 0) {
        return {
          status: 'interrupted',
          note: 'Codex completed a turn in the log, but verification did not finish.',
          error: { code: 'BRIDGE_RESTART', message: 'Verification did not finish before the bridge restarted. No automatic retry was started.' },
        };
      }
      return { status: 'completed', note: 'Recovered as completed from a turn.completed event. The bridge did not observe the process exit itself.' };
    }
    return {
      status: 'interrupted',
      note: 'Inspect the worktree before resuming. No automatic retry was started.',
      error: { code: 'BRIDGE_RESTART', message: 'The bridge restarted while this task was in flight and the Codex process is gone. The outcome is unknown.' },
    };
  }

  private async waitUntil(taskId: string, predicate: (status: TaskStatus) => boolean, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const task = await this.store.get(taskId);
      if (predicate(task.status)) return;
      await sleep(50);
    }
  }
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function newTaskId(): string {
  return randomUUID();
}

export function prepareBudget(config: Config, requested?: { maxAttempts?: number; maxWallTimeSeconds?: number }): { maxAttempts: number; maxWallTimeSeconds: number } {
  const maxAttempts = requested?.maxAttempts ?? config.autoFix.maxAttempts;
  const maxWallTimeSeconds = requested?.maxWallTimeSeconds ?? config.autoFix.maxWallTimeSeconds;
  if (maxAttempts > config.autoFix.maxAttempts || maxWallTimeSeconds > config.autoFix.maxWallTimeSeconds) {
    throw new BridgeError('LIMIT', `auto-fix limits cannot exceed the configured cap of ${config.autoFix.maxAttempts} attempts and ${config.autoFix.maxWallTimeSeconds} seconds.`);
  }
  return { maxAttempts, maxWallTimeSeconds };
}

export function writeAllowed(config: Config, directory: string, sandbox: Task['sandbox']): void {
  if (sandbox === 'read-only') return;
  if (!canWrite(config, directory)) throw new BridgeError('WRITE_NOT_ALLOWLISTED', 'workspace-write is refused unless the project is inside a configured write root. The default is read-only.');
}

function pathJoinWorktrees(stateDir: string): string {
  return path.join(stateDir, 'worktrees');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
