import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { setup, waitFor } from './helpers.mjs';

const cli = path.resolve('dist/cli.js');

test('stdio MCP handshake exposes the Codex bridge tools and can launch a task', async () => {
  const fixture = await setup();
  const client = new Client({ name: 'protocol-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--config', fixture.configPath, 'mcp'], stderr: 'pipe' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 13);
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'bridge_autofix', 'bridge_cancel', 'bridge_cleanup', 'bridge_doctor', 'bridge_launch', 'bridge_log',
      'bridge_memory', 'bridge_projects', 'bridge_redirect', 'bridge_report', 'bridge_resume', 'bridge_status', 'bridge_test',
    ]);
    for (const tool of listed.tools) {
      assert.ok((tool.description ?? '').length > 20, tool.name);
      assert.equal(tool.inputSchema.additionalProperties, false);
      for (const [name, property] of Object.entries(tool.inputSchema.properties ?? {})) {
        assert.equal(typeof property.description, 'string', `${tool.name}.${name}`);
        assert.ok(property.description.trim().length > 0, `${tool.name}.${name}`);
      }
    }
    const launchSchema = listed.tools.find((tool) => tool.name === 'bridge_launch')?.inputSchema;
    assert.equal(launchSchema.properties.sandbox.default, 'read-only');
    assert.deepEqual(launchSchema.required, ['project', 'prompt', 'requestId']);
    const invalid = await client.callTool({ name: 'bridge_launch', arguments: { project: 'app', prompt: 'hello', requestId: 'short' } });
    assert.equal(invalid.isError, true);
    const doctor = await client.callTool({ name: 'bridge_doctor', arguments: {} });
    assert.equal(doctor.isError, undefined);
    assert.equal(doctor.structuredContent.driver, 'codex-exec');
    assert.equal(doctor.structuredContent.codex.auth.mode, 'chatgpt');
    assert.equal(doctor.structuredContent.bypassSandbox, false);
    const launched = await client.callTool({ name: 'bridge_launch', arguments: { project: 'app', prompt: 'Protocol launch.', requestId: 'mcp-launch-0001', includeMemory: false } });
    assert.equal(launched.isError, undefined);
    const done = await waitFor(fixture.bridge, launched.structuredContent.taskId, (task) => task.status === 'completed');
    assert.ok(done.threadId);
    const report = await client.callTool({ name: 'bridge_report', arguments: { taskId: done.taskId } });
    assert.equal(report.structuredContent.status, 'completed');
    assert.equal(report.structuredContent.threadId, done.threadId);
  } finally {
    await client.close();
  }
});
