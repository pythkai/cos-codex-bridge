import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../dist/config.js';

async function base() {
  return realpath(await mkdtemp(path.join(os.tmpdir(), 'grokbot-config-')));
}

test('rejects home, root, relative paths and write roots outside the allowlist', async () => {
  const dir = await base();
  const root = path.join(dir, 'projects');
  const state = path.join(dir, 'state');
  await mkdir(root);
  const write = async (name, value) => {
    const file = path.join(dir, name);
    await writeFile(file, JSON.stringify(value));
    return file;
  };
  await assert.rejects(loadConfig(await write('home.json', { version: 1, roots: [os.homedir()], stateDir: state })), (error) => error.code === 'CONFIG');
  await assert.rejects(loadConfig(await write('slash.json', { version: 1, roots: ['/'], stateDir: state })), (error) => error.code === 'CONFIG');
  await assert.rejects(loadConfig(await write('rel.json', { version: 1, roots: ['projects'], stateDir: state })), (error) => error.code === 'CONFIG');
  await assert.rejects(loadConfig(await write('write.json', { version: 1, roots: [root], writeRoots: [dir], stateDir: state })), (error) => error.code === 'CONFIG');
  await assert.rejects(loadConfig(await write('inside.json', { version: 1, roots: [root], stateDir: path.join(root, 'state') })), (error) => error.code === 'CONFIG');
});

test('accepts a private state directory outside the allowlist', async () => {
  const dir = await base();
  const root = path.join(dir, 'projects');
  const state = path.join(dir, 'state');
  await mkdir(root);
  const file = path.join(dir, 'config.json');
  await writeFile(file, JSON.stringify({ version: 1, roots: [root], stateDir: state }));
  const config = await loadConfig(file);
  assert.equal(config.maxConcurrentTasks, 2);
  assert.equal(config.autoFix.maxAttempts, 3);
  assert.equal(config.autoFix.maxWallTimeSeconds, 1200);
  assert.deepEqual(config.writeRoots, []);
  assert.equal(config.approvalToken, undefined);
});
