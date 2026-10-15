import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { BridgeError } from './errors.js';

const exec = promisify(execFile);

async function git(args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', args, {
      timeout: 30_000,
      maxBuffer: 1_000_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  } catch (error) {
    const stderr = typeof error === 'object' && error && 'stderr' in error ? String((error as { stderr?: string }).stderr) : '';
    throw new BridgeError('GIT', (stderr || 'Git command failed.').trim().slice(0, 400));
  }
}

const repoChains = new Map<string, Promise<void>>();

export function withRepoLock<T>(repo: string, action: () => Promise<T>): Promise<T> {
  const previous = repoChains.get(repo) ?? Promise.resolve();
  let value!: T;
  const next = previous.then(async () => {
    value = await action();
  });
  repoChains.set(repo, next.then(() => undefined, () => undefined));
  return next.then(() => value);
}

export async function assertRepo(repo: string): Promise<void> {
  const top = await realpath((await git(['-C', repo, 'rev-parse', '--show-toplevel'])).trim());
  if (top !== await realpath(repo)) throw new BridgeError('GIT', 'The project path is not the top of a Git repository.');
}

export async function createTaskWorktree(options: { repo: string; worktree: string; branch: string; baseBranch?: string }): Promise<{ baseSha: string }> {
  await assertRepo(options.repo);
  if (!/^bridge\/[0-9a-f-]{36}$/i.test(options.branch)) throw new BridgeError('GIT', 'Refusing to create a branch outside the bridge namespace.');
  const baseSha = options.baseBranch
    ? (await git(['-C', options.repo, 'rev-parse', '--verify', `refs/heads/${options.baseBranch}`])).trim()
    : (await git(['-C', options.repo, 'rev-parse', 'HEAD'])).trim();
  await git(['-C', options.repo, 'worktree', 'add', '-b', options.branch, options.worktree, baseSha]);
  return { baseSha };
}

export async function removeTaskWorktree(options: { repo: string; worktree: string; branch: string; discardChanges: boolean }): Promise<void> {
  await assertRepo(options.repo);
  if (!/^bridge\/[0-9a-f-]{36}$/i.test(options.branch)) throw new BridgeError('GIT', 'Refusing to delete a branch outside the bridge namespace.');
  const listing = await git(['-C', options.repo, 'worktree', 'list', '--porcelain']);
  if (!listing.includes(options.worktree)) throw new BridgeError('NOT_FOUND', 'Worktree is not registered for this repository.');
  const removeArgs = ['-C', options.repo, 'worktree', 'remove'];
  if (options.discardChanges) removeArgs.push('--force');
  removeArgs.push(options.worktree);
  await git(removeArgs);
  await git(['-C', options.repo, 'branch', options.discardChanges ? '-D' : '-d', options.branch]);
}

export async function inspectWorktree(worktree: string, baseSha: string): Promise<{ diffStat: string; files: string[]; commits: Array<{ sha: string; subject: string }> }> {
  const diff = await git(['-C', worktree, 'diff', '--stat', baseSha]).catch(() => '');
  const status = await git(['-C', worktree, 'status', '--porcelain']).catch(() => '');
  const log = await git(['-C', worktree, 'log', '--format=%H%x09%s', `${baseSha}..HEAD`]).catch(() => '');
  const files = status.split('\n').map((line) => line.slice(3).trim()).filter(Boolean).slice(0, 200);
  const commits = log.split('\n').filter(Boolean).slice(0, 50).map((line) => {
    const [sha, subject] = line.split('\t');
    return { sha: sha ?? '', subject: subject ?? '' };
  }).filter((commit) => commit.sha);
  return { diffStat: diff.trim().slice(0, 8000), files, commits };
}
