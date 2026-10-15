import { z } from 'zod';

const projectRef = z.string().min(1).max(4096).describe('Configured project alias, or an absolute Git repository inside an allowlisted root.');
const requestKey = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/).describe('Caller-chosen idempotency key, 8–80 letters, digits, underscores or hyphens. Reuse it only for the identical request.');
const taskId = z.string().uuid().describe('Task id returned by bridge_launch, bridge_resume, bridge_redirect or bridge_autofix.');
const sandbox = z.enum(['read-only', 'workspace-write']).describe('Codex sandbox. read-only is the default. workspace-write is accepted only when the project is inside a configured write root. Sandbox bypass is not available.');
const attempts = z.number().int().min(1).max(5).optional().describe('Auto-fix attempt cap for this task, including the first Codex turn. Cannot exceed the configured cap (default 3).');
const wall = z.number().int().min(30).max(7200).optional().describe('Wall-time budget in seconds for this user-initiated run. Cannot exceed the configured cap (default 1200).');

export const schemas = {
  bridge_doctor: z.object({}).strict().describe('Report Codex availability, redacted auth mode, Node, roots and limits.'),
  bridge_projects: z.object({
    action: z.enum(['list', 'inspect']).default('list').describe('list returns aliases and roots. inspect checks one project.'),
    project: projectRef.optional().describe('Required for inspect. Alias or absolute allowlisted directory.'),
  }).strict(),
  bridge_launch: z.object({
    project: projectRef,
    prompt: z.string().min(1).describe('Complete UTF-8 instruction. It is sent to Codex on stdin, never as a shell argument.'),
    requestId: requestKey,
    sandbox: sandbox.default('read-only'),
    model: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/).optional().describe('Optional Codex model id. Omit to use the CLI default or the configured model.'),
    autoFix: z.boolean().default(false).describe('When true, a failed turn or failing test command asks Codex to fix the worktree within the attempt and wall-time caps. Usage limits are never retried.'),
    maxAttempts: attempts,
    maxWallTimeSeconds: wall,
    runTests: z.boolean().optional().describe('Run the project testCommand after Codex. Defaults to true when a test command is configured.'),
    includeMemory: z.boolean().default(true).describe('Include saved project notes in the prompt as untrusted reference text.'),
    scope: z.literal('worktree').default('worktree').describe('Isolation scope. Only the task worktree is supported.'),
  }).strict(),
  bridge_resume: z.object({
    taskId,
    prompt: z.string().min(1).describe('Follow-up instruction for the same Codex thread and worktree.'),
    requestId: requestKey,
  }).strict(),
  bridge_redirect: z.object({
    taskId,
    prompt: z.string().min(1).describe('New instruction. A running Codex process is interrupted first, then the same thread continues when its id is known.'),
    requestId: requestKey,
  }).strict(),
  bridge_status: z.object({
    taskId: taskId.optional().describe('Omit to list recent tasks.'),
    limit: z.number().int().min(1).max(100).default(20).describe('Page size when listing tasks.'),
    cursor: z.string().max(300).optional().describe('Opaque cursor from the previous list page.'),
  }).strict(),
  bridge_log: z.object({
    taskId,
    cursor: z.number().int().min(0).default(0).describe('Line offset from the previous page. Start at 0.'),
    limitBytes: z.number().int().min(200).max(64_000).default(16_000).describe('Maximum UTF-8 bytes of log lines to return.'),
  }).strict(),
  bridge_cancel: z.object({
    taskId,
  }).strict(),
  bridge_autofix: z.object({
    taskId,
    maxAttempts: attempts,
    maxWallTimeSeconds: wall,
  }).strict(),
  bridge_test: z.object({
    taskId,
  }).strict(),
  bridge_memory: z.object({
    project: projectRef,
    action: z.enum(['read', 'write', 'append']).describe('read returns notes. write replaces them. append adds to them. Notes are local plaintext.'),
    text: z.string().max(64_000).optional().describe('UTF-8 note text for write or append. Codex receives an excerpt on later launches.'),
  }).strict(),
  bridge_report: z.object({
    taskId,
  }).strict(),
  bridge_cleanup: z.object({
    taskId,
    approvalToken: z.string().min(8).max(200).describe('Exact approval token from the private local config. Required for worktree and branch removal. It is never a deploy or publish grant.'),
    discardChanges: z.boolean().default(false).describe('When true, and the token matches, uncommitted worktree changes and an unmerged task branch may be deleted. This never resets the main checkout and never pushes.'),
  }).strict(),
};

export type ToolName = keyof typeof schemas;

export const TOOL_NAMES = Object.keys(schemas) as ToolName[];
