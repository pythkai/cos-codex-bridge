import { chmod, lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { BridgeError } from './errors.js';

const aliasPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/;

const ProjectSchema = z.object({
  path: z.string(),
  testCommand: z.string().min(1).max(400).optional(),
  baseBranch: z.string().regex(branchPattern).optional(),
}).strict();

export const ConfigSchema = z.object({
  version: z.literal(1),
  roots: z.array(z.string()).min(1).max(20),
  writeRoots: z.array(z.string()).max(20).default([]),
  projects: z.record(z.string().regex(aliasPattern), ProjectSchema).default({}),
  codexBinary: z.string().min(1).default('codex'),
  model: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/).optional(),
  maxConcurrentTasks: z.number().int().min(1).max(4).default(2),
  autoFix: z.object({
    maxAttempts: z.number().int().min(1).max(5).default(3),
    maxWallTimeSeconds: z.number().int().min(30).max(7200).default(1200),
  }).strict().default({ maxAttempts: 3, maxWallTimeSeconds: 1200 }),
  attemptTimeoutSeconds: z.number().int().min(15).max(3600).default(600),
  testTimeoutSeconds: z.number().int().min(5).max(1800).default(180),
  approvalToken: z.string().min(8).max(200).optional(),
  stateDir: z.string().optional(),
}).strict();

export interface ProjectConfig {
  alias: string;
  path: string;
  testCommand?: string;
  baseBranch?: string;
}

export interface Config {
  version: 1;
  roots: string[];
  writeRoots: string[];
  projects: Record<string, ProjectConfig>;
  codexBinary: string;
  model?: string;
  maxConcurrentTasks: number;
  autoFix: { maxAttempts: number; maxWallTimeSeconds: number };
  attemptTimeoutSeconds: number;
  testTimeoutSeconds: number;
  approvalToken?: string;
  stateDir: string;
  configPath: string;
}

export function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

async function privateDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new BridgeError('CONFIG', 'State directory must be a real directory, not a symlink.');
  await chmod(dir, 0o700);
  return realpath(dir);
}

export async function loadConfig(file: string): Promise<Config> {
  const configPath = await realpath(file);
  let parsed: z.infer<typeof ConfigSchema>;
  try {
    parsed = ConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('CONFIG', 'Configuration is missing or does not match the expected schema.');
  }
  const roots = await Promise.all(parsed.roots.map((entry) => canonicalizeRoot(entry)));
  const writeRoots: string[] = [];
  for (const entry of parsed.writeRoots) {
    const resolved = await canonicalizeRoot(entry);
    if (!roots.some((root) => inside(root, resolved))) {
      throw new BridgeError('CONFIG', 'Every write root must be inside a configured read root.');
    }
    writeRoots.push(resolved);
  }
  const stateDir = await privateDir(parsed.stateDir ?? path.join(os.homedir(), '.local', 'share', 'grokbot-codex-bridge'));
  if (!path.isAbsolute(stateDir)) throw new BridgeError('CONFIG', 'stateDir must be absolute.');
  if (roots.some((root) => inside(root, stateDir) || inside(stateDir, root) || inside(root, configPath))) {
    throw new BridgeError('CONFIG', 'Keep configuration and state outside allowlisted project roots.');
  }
  const projects: Record<string, ProjectConfig> = {};
  for (const [alias, project] of Object.entries(parsed.projects)) {
    const projectPath = await resolveExisting(project.path);
    if (!roots.some((root) => inside(root, projectPath))) throw new BridgeError('CONFIG', `Project ${alias} is outside the allowlisted roots.`);
    projects[alias] = {
      alias,
      path: projectPath,
      ...(project.testCommand ? { testCommand: project.testCommand } : {}),
      ...(project.baseBranch ? { baseBranch: project.baseBranch } : {}),
    };
  }
  return {
    version: 1,
    roots,
    writeRoots,
    projects,
    codexBinary: parsed.codexBinary,
    ...(parsed.model ? { model: parsed.model } : {}),
    maxConcurrentTasks: parsed.maxConcurrentTasks,
    autoFix: parsed.autoFix,
    attemptTimeoutSeconds: parsed.attemptTimeoutSeconds,
    testTimeoutSeconds: parsed.testTimeoutSeconds,
    ...(parsed.approvalToken ? { approvalToken: parsed.approvalToken } : {}),
    stateDir,
    configPath,
  };
}

async function canonicalizeRoot(input: string): Promise<string> {
  if (!path.isAbsolute(input)) throw new BridgeError('CONFIG', 'Roots must be absolute paths.');
  const resolved = await realpath(input);
  if (resolved === path.parse(resolved).root || resolved === os.homedir()) {
    throw new BridgeError('CONFIG', 'Allow individual project directories, not / or your home directory.');
  }
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new BridgeError('CONFIG', 'A configured root is not a directory.');
  return resolved;
}

export async function resolveExisting(input: string): Promise<string> {
  if (!path.isAbsolute(input)) throw new BridgeError('OUTSIDE_ALLOWLIST', 'Use an absolute path or a configured project alias.');
  try {
    return await realpath(input);
  } catch {
    throw new BridgeError('NOT_FOUND', 'Path does not exist.');
  }
}

export function canWrite(config: Config, directory: string): boolean {
  return config.writeRoots.some((root) => inside(root, directory));
}

export async function resolveProject(config: Config, project: string): Promise<{ alias: string; path: string; testCommand?: string; baseBranch?: string }> {
  const configured = config.projects[project];
  if (configured) return configured;
  const resolved = await resolveExisting(project);
  if (!config.roots.some((root) => inside(root, resolved))) throw new BridgeError('OUTSIDE_ALLOWLIST', 'Path is outside configured workspace roots.');
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new BridgeError('INVALID_PATH', 'Expected a directory.');
  const match = Object.values(config.projects).find((item) => item.path === resolved);
  if (match) return match;
  return { alias: path.basename(resolved), path: resolved };
}
