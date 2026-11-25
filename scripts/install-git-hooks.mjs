#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chmodSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const actual = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (realpathSync(actual) !== realpathSync(root)) throw new Error('Refusing to change a parent repository. Initialize the isolated project repository first.');
  for (const name of ['pre-commit', 'pre-push']) chmodSync(join(root, '.githooks', name), 0o755);
  execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  console.log('BlackOutBridge hooks installed in this repository only. No remote was configured and nothing was pushed.');
} catch (error) {
  console.error(error instanceof Error && !('status' in error) ? error.message : 'Hook setup failed; inspect repository-local Git permissions.');
  process.exitCode = 1;
}
