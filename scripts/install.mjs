#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../dist/config.js';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const roots = [];
const writeRoots = [];
const projects = {};
let prefix = path.join(os.homedir(), '.local', 'share', 'grokbot-codex-bridge');
let codex = 'codex';
let approvalToken;

for (let index = 0; index < args.length; index += 1) {
  const flag = args[index];
  const value = args[index + 1];
  if (flag === '--root') roots.push(value);
  else if (flag === '--write-root') writeRoots.push(value);
  else if (flag === '--prefix') prefix = value;
  else if (flag === '--codex') codex = value;
  else if (flag === '--approval-token') approvalToken = value;
  else if (flag === '--project') {
    const split = value?.split('=');
    if (!split || split.length !== 2 || !split[0] || !split[1]) {
      console.error('--project expects alias=/absolute/repo');
      process.exit(1);
    }
    projects[split[0]] = { path: split[1] };
  } else if (flag === '--test') {
    const split = value?.split('=');
    if (!split || split.length !== 2 || !projects[split[0]]) {
      console.error('--test expects an existing alias=command');
      process.exit(1);
    }
    projects[split[0]].testCommand = split[1];
  } else {
    console.error(`Unknown argument ${flag ?? ''}`);
    process.exit(1);
  }
  index += 1;
}

if (roots.length === 0) {
  console.error('Pass at least one --root /absolute/project-parent. Do not pass your home directory.');
  process.exit(1);
}

const configPath = path.join(prefix, 'config.json');
try {
  await readFile(configPath);
  console.error('Refusing to overwrite an existing config. Choose another --prefix or remove the old config first.');
  process.exit(1);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

await mkdir(prefix, { recursive: true, mode: 0o700 });
const config = {
  version: 1,
  roots,
  writeRoots,
  projects,
  codexBinary: codex,
  stateDir: prefix,
  ...(approvalToken ? { approvalToken } : {}),
};
await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
try {
  await loadConfig(configPath);
} catch (error) {
  const { unlink } = await import('node:fs/promises');
  await unlink(configPath).catch(() => undefined);
  console.error(error instanceof Error ? error.message : 'Invalid configuration.');
  process.exit(1);
}
const cli = path.join(sourceRoot, 'dist', 'cli.js');
const launcher = path.join(prefix, 'grokbot-codex-bridge');
await writeFile(launcher, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} --config ${shellQuote(configPath)} "$@"\n`, { mode: 0o700 });
await chmod(launcher, 0o700);
const mcpPath = path.join(prefix, 'mcp-client.json');
const mcp = {
  mcpServers: {
    'grokbot-codex-bridge': {
      command: process.execPath,
      args: [cli, '--config', configPath, 'mcp'],
      env: {},
    },
  },
};
await writeFile(mcpPath, JSON.stringify(mcp, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ prefix, configPath, launcher, mcp: mcpPath }, null, 2));

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
