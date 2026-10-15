#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Bridge } from './bridge.js';
import { loadConfig } from './config.js';
import { BridgeError, failure } from './errors.js';
import { schemas, TOOL_NAMES, type ToolName } from './schemas.js';
import { PRODUCT, VERSION } from './version.js';

const descriptions: Record<ToolName, string> = {
  bridge_doctor: 'Report whether Codex is installed, its version, ChatGPT or API auth state without secrets, Node, allowlisted roots, write roots, and the conservative task limits. Does not start work or change login.',
  bridge_projects: 'List configured project aliases or inspect one allowlisted Git repository. Does not create folders, register a desktop app, or grant write access.',
  bridge_launch: 'Queue a Codex task in a new git worktree and branch. Returns immediately with a task id; poll bridge_status. Default sandbox is read-only. Usage-limit failures become rate_limited and are not retried.',
  bridge_resume: 'Send a follow-up to the same Codex thread and task worktree. Refuses while the task is running.',
  bridge_redirect: 'Interrupt a running Codex process, then continue the same thread with a new instruction. Does not bypass the sandbox.',
  bridge_status: 'Read one task or a page of recent tasks. Status values include queued, running, needs_input, completed, failed, cancelled, rate_limited and interrupted.',
  bridge_log: 'Read a bounded, paginated slice of redacted Codex events and stderr for one task.',
  bridge_cancel: 'Interrupt a bridge-owned Codex process. Does not delete the worktree or undo edits.',
  bridge_autofix: 'Run the project test command and, on failure, ask Codex to fix the task worktree within the configured attempt and wall-time caps. Refuses to loop after rate_limited.',
  bridge_test: 'Run the configured project test command in the task worktree and store the pass or fail excerpt. Does not ask Codex to fix anything.',
  bridge_memory: 'Read or update local project notes. Later launches can include them in the Codex prompt. Notes are plaintext in the private state directory.',
  bridge_report: 'Summarize files changed, commits, tests, attempts, errors and the Codex thread id for one task. Completion is not a deploy or publish.',
  bridge_cleanup: 'Remove this task worktree and its bridge branch. Requires the private approval token. Never pushes, publishes, or resets the main checkout.',
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.length === 0) {
    console.log(`${PRODUCT} ${VERSION}\nUsage: grokbot-codex-bridge --config /absolute/config.json mcp\n       grokbot-codex-bridge --config /absolute/config.json doctor\n       grokbot-codex-bridge --config /absolute/config.json call <tool> [--input /path/args.json]`);
    return;
  }
  const index = argv.indexOf('--config');
  const file = index >= 0 ? argv[index + 1] : process.env.GROKBOT_CODEX_BRIDGE_CONFIG;
  if (!file) throw new BridgeError('CONFIG', 'Supply --config /absolute/config.json.');
  if (index >= 0) argv.splice(index, 2);
  const config = await loadConfig(file);
  const bridge = new Bridge(config);
  await bridge.init();
  if (argv[0] === 'doctor') {
    console.log(JSON.stringify(await bridge.execute('bridge_doctor', {}), null, 2));
    return;
  }
  if (argv[0] === 'call') {
    const inputIndex = argv.indexOf('--input');
    let raw = '';
    if (inputIndex >= 0) {
      const inputPath = argv[inputIndex + 1];
      if (!inputPath) throw new BridgeError('INVALID_ARGUMENT', 'Missing --input path.');
      if ((await stat(inputPath)).size > 2 * 1024 * 1024) throw new BridgeError('SIZE_LIMIT', 'JSON input exceeds 2 MiB.');
      raw = await readFile(inputPath, 'utf8');
    } else {
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 2 * 1024 * 1024) throw new BridgeError('SIZE_LIMIT', 'JSON input exceeds 2 MiB.');
        chunks.push(buffer);
      }
      raw = Buffer.concat(chunks).toString('utf8');
    }
    const tool = argv[1] ?? '';
    console.log(JSON.stringify(await bridge.execute(tool, JSON.parse(raw || '{}')), null, 2));
    return;
  }
  if (argv[0] !== 'mcp') throw new BridgeError('USAGE', 'Unknown command. Use --help.');
  const server = new McpServer({ name: PRODUCT, version: VERSION }, {
    instructions: 'Local Codex CLI bridge for Grok Bot. Launch a task, poll bridge_status, read bridge_log, and use bridge_resume for the same thread. Default sandbox is read-only. workspace-write requires a configured write root. If status is rate_limited, wait and do not call bridge_autofix. The bridge never deploys or publishes. A completed receipt is not proof that the result was reviewed.',
  });
  for (const name of TOOL_NAMES) {
    const tool = name;
    server.registerTool(tool, {
      description: descriptions[tool],
      inputSchema: schemas[tool],
      annotations: {
        readOnlyHint: READ_ONLY_TOOLS.has(tool),
        destructiveHint: tool === 'bridge_cleanup' || tool === 'bridge_cancel' || tool === 'bridge_redirect',
        openWorldHint: false,
      },
    }, async (args: unknown) => {
      try {
        const result = await bridge.execute(tool, args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        const result = failure(error);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result, isError: true };
      }
    });
  }
  await server.connect(new StdioServerTransport());
}

const READ_ONLY_TOOLS = new Set<ToolName>(['bridge_doctor', 'bridge_projects', 'bridge_status', 'bridge_log', 'bridge_report']);

main().catch((error) => {
  console.error(JSON.stringify(failure(error)));
  process.exitCode = 1;
});
