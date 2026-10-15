import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fakeCodex } from './helpers.mjs';

test('installer writes a launcher and refuses to overwrite it', async () => {
  await chmod(fakeCodex, 0o755);
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'grokbot-install-')));
  const root = path.join(base, 'projects');
  const prefix = path.join(base, 'prefix');
  await mkdir(root);
  const args = ['scripts/install.mjs', '--root', root, '--prefix', prefix, '--codex', fakeCodex];
  const installed = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stderr);
  const doctor = spawnSync(path.join(prefix, 'grokbot-codex-bridge'), ['doctor'], { encoding: 'utf8' });
  assert.equal(doctor.status, 0, doctor.stderr);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.driver, 'codex-exec');
  assert.equal(report.codex.auth.mode, 'chatgpt');
  assert.equal(report.bypassSandbox, false);
  assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 1);
});
