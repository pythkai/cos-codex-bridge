import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canWrite, resolveProject, type Config } from './config.js';
import { BridgeError } from './errors.js';
import { createTaskWorktree, withRepoLock } from './git.js';
import { redact } from './redact.js';
import { assertUtf8 } from './redact.js';
import { fingerprint, newTaskId, prepareBudget, Runner, writeAllowed } from './runner.js';
import { schemas, type ToolName } from './schemas.js';
import { Store, type SandboxMode, type Task } from './store.js';
import { runProjectTests } from './verify.js';
import { PRODUCT, VERSION } from './version.js';

const READ_ONLY = new Set(['bridge_doctor', 'bridge_projects', 'bridge_status', 'bridge_log', 'bridge_report']);

export class Bridge {
  readonly store: Store;
  readonly runner: Runner;

  constructor(public config: Config) {
    this.store = new Store(config);
    this.runner = new Runner(config, this.store);
  }

  async init(): Promise<void> {
    await this.store.init();
    await this.runner.recover();
  }

  async execute(name: string, input: unknown): Promise<Record<string, unknown>> {
    if (!Object.hasOwn(schemas, name)) throw new BridgeError('UNKNOWN_TOOL', 'Unknown bridge tool.');
    let args: unknown;
    try {
      args = schemas[name as ToolName].parse(input);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new BridgeError('INVALID_ARGUMENT', error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ').slice(0, 500));
      }
      throw error;
    }
    switch (name) {
      case 'bridge_doctor': return this.doctor();
      case 'bridge_projects': return this.projects(args as z.infer<typeof schemas.bridge_projects>);
      case 'bridge_launch': return this.launch(args as z.infer<typeof schemas.bridge_launch>);
      case 'bridge_resume': return this.follow('resume', args as z.infer<typeof schemas.bridge_resume>);
      case 'bridge_redirect': return this.follow('redirect', args as z.infer<typeof schemas.bridge_redirect>);
      case 'bridge_status': return this.status(args as z.infer<typeof schemas.bridge_status>);
      case 'bridge_log': return this.log(args as z.infer<typeof schemas.bridge_log>);
      case 'bridge_cancel': return publicTask(await this.runner.cancel((args as z.infer<typeof schemas.bridge_cancel>).taskId));
      case 'bridge_autofix': return this.autofix(args as z.infer<typeof schemas.bridge_autofix>);
      case 'bridge_test': return this.test((args as z.infer<typeof schemas.bridge_test>).taskId);
      case 'bridge_memory': return this.memory(args as z.infer<typeof schemas.bridge_memory>);
      case 'bridge_report': return this.runner.report((args as z.infer<typeof schemas.bridge_report>).taskId);
      case 'bridge_cleanup': return this.cleanup(args as z.infer<typeof schemas.bridge_cleanup>);
      default: throw new BridgeError('UNKNOWN_TOOL', 'Unknown bridge tool.');
    }
  }

  private async launch(args: z.infer<typeof schemas.bridge_launch>): Promise<Record<string, unknown>> {
    assertUtf8(args.prompt, 256 * 1024, 'prompt');
    const project = await resolveProject(this.config, args.project);
    const sandbox = args.sandbox as SandboxMode;
    writeAllowed(this.config, project.path, sandbox);
    const limits = prepareBudget(this.config, { ...(args.maxAttempts ? { maxAttempts: args.maxAttempts } : {}), ...(args.maxWallTimeSeconds ? { maxWallTimeSeconds: args.maxWallTimeSeconds } : {}) });
    const body = {
      tool: 'bridge_launch',
      project: project.path,
      prompt: args.prompt,
      sandbox,
      model: args.model ?? this.config.model ?? null,
      autoFix: args.autoFix,
      limits,
      runTests: args.runTests ?? Boolean(project.testCommand),
      includeMemory: args.includeMemory,
      scope: args.scope,
    };
    const digest = fingerprint(body);
    const prior = await this.store.peekRequest(args.requestId);
    if (prior) {
      if (prior.fingerprint !== digest) throw new BridgeError('CONFLICT', 'requestId was already used with different content.');
      return publicTask(await this.store.get(prior.taskId));
    }
    const id = newTaskId();
    const now = new Date();
    const created = await withRepoLock(project.path, async () => createTaskWorktree({
      repo: project.path,
      worktree: this.store.worktreePath(id),
      branch: `bridge/${id}`,
      ...(project.baseBranch ? { baseBranch: project.baseBranch } : {}),
    }));
    const task: Task = {
      id,
      requestId: args.requestId,
      project: project.alias,
      projectRoot: project.path,
      worktree: this.store.worktreePath(id),
      branch: `bridge/${id}`,
      baseSha: created.baseSha,
      sandbox,
      ...(args.model || this.config.model ? { model: args.model ?? this.config.model } : {}),
      status: 'queued',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      runStartedAt: now.toISOString(),
      deadlineAt: new Date(now.getTime() + limits.maxWallTimeSeconds * 1000).toISOString(),
      promptSha256: createHash('sha256').update(args.prompt).digest('hex'),
      attempts: [],
      runAttempts: 0,
      autoFix: { enabled: args.autoFix, maxAttempts: limits.maxAttempts, maxWallTimeSeconds: limits.maxWallTimeSeconds, scope: 'worktree' },
      runTests: args.runTests ?? Boolean(project.testCommand),
      ...(project.testCommand ? { testCommand: project.testCommand } : {}),
      tests: [],
      includeMemory: args.includeMemory,
      queuedPhase: 'launch',
    };
    try {
      const remembered = await this.store.rememberRequest(args.requestId, digest, id);
      if (remembered.duplicate) {
        const { removeTaskWorktree } = await import('./git.js');
        await removeTaskWorktree({ repo: project.path, worktree: task.worktree, branch: task.branch, discardChanges: false }).catch(() => undefined);
        return publicTask(await this.store.get(remembered.taskId));
      }
    } catch (error) {
      const { removeTaskWorktree } = await import('./git.js');
      await removeTaskWorktree({ repo: project.path, worktree: task.worktree, branch: task.branch, discardChanges: true }).catch(() => undefined);
      throw error;
    }
    await this.runner.launch(task, args.prompt);
    return publicTask(await this.store.get(id));
  }

  private async follow(kind: 'resume' | 'redirect', args: { taskId: string; prompt: string; requestId: string }): Promise<Record<string, unknown>> {
    assertUtf8(args.prompt, 256 * 1024, 'prompt');
    const digest = fingerprint({ tool: kind, taskId: args.taskId, prompt: args.prompt });
    const prior = await this.store.peekRequest(args.requestId);
    if (prior) {
      if (prior.fingerprint !== digest) throw new BridgeError('CONFLICT', 'requestId was already used with different content.');
      return publicTask(await this.store.get(prior.taskId));
    }
    const task = await this.runner.followUp(args.taskId, kind, args.prompt, args.requestId);
    await this.store.rememberRequest(args.requestId, digest, task.id);
    return publicTask(await this.store.get(task.id));
  }

  private async autofix(args: z.infer<typeof schemas.bridge_autofix>): Promise<Record<string, unknown>> {
    const limits = prepareBudget(this.config, { ...(args.maxAttempts ? { maxAttempts: args.maxAttempts } : {}), ...(args.maxWallTimeSeconds ? { maxWallTimeSeconds: args.maxWallTimeSeconds } : {}) });
    return publicTask(await this.runner.autofix(args.taskId, limits));
  }

  private async test(taskId: string): Promise<Record<string, unknown>> {
    const task = await this.store.get(taskId);
    if (task.status === 'running' || task.status === 'queued') throw new BridgeError('BUSY', 'Wait until the task is idle before running tests.');
    if (!task.testCommand) throw new BridgeError('NO_TEST', 'This project has no testCommand in the bridge config.');
    const result = await runProjectTests({ command: task.testCommand, cwd: task.worktree, timeoutMs: this.config.testTimeoutSeconds * 1000, secrets: this.runner.secrets() });
    const updated = await this.store.mutate(taskId, (current) => {
      current.tests.push(result);
    });
    return { taskId, status: updated.status, test: result };
  }

  private async memory(args: z.infer<typeof schemas.bridge_memory>): Promise<Record<string, unknown>> {
    const project = await resolveProject(this.config, args.project);
    if (args.action === 'read') return { project: project.alias, text: await this.store.readMemory(project.alias) };
    if (!args.text) throw new BridgeError('INVALID_ARGUMENT', 'write and append require text.');
    assertUtf8(args.text, 64 * 1024, 'memory');
    const text = await this.store.writeMemory(project.alias, args.text, args.action === 'append');
    return { project: project.alias, bytes: Buffer.byteLength(text) };
  }

  private async projects(args: z.infer<typeof schemas.bridge_projects>): Promise<Record<string, unknown>> {
    if (args.action === 'inspect') {
      if (!args.project) throw new BridgeError('INVALID_ARGUMENT', 'inspect requires project.');
      const project = await resolveProject(this.config, args.project);
      return { project: project.alias, path: project.path, writeAllowed: canWrite(this.config, project.path), testCommand: project.testCommand ? redact(project.testCommand, this.runner.secrets()) : null, baseBranch: project.baseBranch ?? null };
    }
    const projects = Object.values(this.config.projects).map((project) => ({
      alias: project.alias,
      path: project.path,
      writeAllowed: canWrite(this.config, project.path),
      hasTestCommand: Boolean(project.testCommand),
    }));
    return { roots: this.config.roots, writeRoots: this.config.writeRoots, projects };
  }

  private async status(args: z.infer<typeof schemas.bridge_status>): Promise<Record<string, unknown>> {
    if (args.taskId) return publicTask(await this.runner.refresh(args.taskId));
    const tasks = await this.store.listTasks();
    const cursor = decodeCursor(args.cursor);
    const filtered = tasks.filter((task) => !cursor || task.updatedAt < cursor.updatedAt || (task.updatedAt === cursor.updatedAt && task.id < cursor.id));
    const page = filtered.slice(0, args.limit);
    const last = page[page.length - 1];
    return {
      tasks: page.map(summary),
      nextCursor: filtered.length > args.limit && last ? encodeCursor(last) : null,
    };
  }

  private async log(args: z.infer<typeof schemas.bridge_log>): Promise<Record<string, unknown>> {
    await this.store.get(args.taskId);
    const lines = await this.store.readLogLines(args.taskId);
    const page: string[] = [];
    let bytes = 0;
    let index = args.cursor;
    for (; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined) break;
      if (bytes + line.length > args.limitBytes && page.length > 0) break;
      page.push(line);
      bytes += line.length;
      if (bytes >= args.limitBytes) {
        index += 1;
        break;
      }
    }
    return { taskId: args.taskId, events: page, nextCursor: index, done: index >= lines.length };
  }

  private async cleanup(args: z.infer<typeof schemas.bridge_cleanup>): Promise<Record<string, unknown>> {
    const task = await this.runner.cleanup(args.taskId, args.approvalToken, args.discardChanges);
    return { taskId: task.id, cleaned: true, status: task.status, branch: task.branch };
  }

  private async doctor(): Promise<Record<string, unknown>> {
    const version = await command(this.config.codexBinary, ['--version']);
    const login = await command(this.config.codexBinary, ['login', 'status']);
    const detail = redact(`${login.stdout}\n${login.stderr}`, this.runner.secrets()).replace(/\s+/g, ' ').trim().slice(0, 180);
    const mode = login.code === 0 && /chatgpt/i.test(detail) ? 'chatgpt' : login.code === 0 && /api/i.test(detail) ? 'api' : login.code === 0 ? 'unknown' : 'logged_out';
    return {
      ok: true,
      name: PRODUCT,
      version: VERSION,
      driver: 'codex-exec',
      driverReason: 'codex exec --json is the documented non-interactive interface. The bridge resumes the printed thread id with codex exec resume. It does not use app-server and it never passes a sandbox bypass flag.',
      node: process.versions.node,
      mode: 'local-stdio',
      codex: {
        binary: this.config.codexBinary,
        available: version.code === 0,
        version: version.code === 0 ? redact(version.stdout, this.runner.secrets()).trim().split('\n')[0]?.slice(0, 120) ?? null : null,
        auth: { state: login.code === 0 ? 'authenticated' : 'logged_out', mode, detail: detail || null },
      },
      authPrimary: 'chatgpt-subscription',
      roots: this.config.roots,
      writeRoots: this.config.writeRoots,
      limits: {
        maxConcurrentTasks: this.config.maxConcurrentTasks,
        autoFixMaxAttempts: this.config.autoFix.maxAttempts,
        autoFixMaxWallTimeSeconds: this.config.autoFix.maxWallTimeSeconds,
        attemptTimeoutSeconds: this.config.attemptTimeoutSeconds,
        testTimeoutSeconds: this.config.testTimeoutSeconds,
      },
      stateDir: this.config.stateDir,
      publishDisabled: true,
      bypassSandbox: false,
      recovered: this.runner.recovery,
    };
  }

}

function publicTask(task: Task): Record<string, unknown> {
  return {
    taskId: task.id,
    project: task.project,
    status: task.status,
    threadId: task.threadId ?? null,
    sandbox: task.sandbox,
    branch: task.branch,
    worktree: task.worktree,
    baseSha: task.baseSha,
    attempts: task.attempts,
    runAttempts: task.runAttempts,
    autoFix: task.autoFix,
    tests: task.tests,
    error: task.error ?? null,
    note: task.note ?? null,
    responseExcerpt: task.responseExcerpt ?? '',
    responseTruncated: task.responseTruncated ?? false,
    detached: task.detached ?? false,
    cleaned: task.cleaned ?? false,
    logTruncated: task.logTruncated ?? false,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    deadlineAt: task.deadlineAt ?? null,
    promptSha256: task.promptSha256,
  };
}

function summary(task: Task): Record<string, unknown> {
  return { taskId: task.id, project: task.project, status: task.status, threadId: task.threadId ?? null, updatedAt: task.updatedAt, branch: task.branch };
}

function encodeCursor(task: Task): string {
  return Buffer.from(`${task.updatedAt}\n${task.id}`).toString('base64url');
}

function decodeCursor(cursor?: string): { updatedAt: string; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const [updatedAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('\n');
    if (!updatedAt || !id) throw new Error('bad');
    return { updatedAt, id };
  } catch {
    throw new BridgeError('INVALID_ARGUMENT', 'The status cursor is not valid.');
  }
}

function command(binary: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 8_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 2_000) stdout = stdout.slice(0, 2_000);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 2_000) stderr = stderr.slice(0, 2_000);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, stdout: '', stderr: '' });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export { READ_ONLY, publicTask };
