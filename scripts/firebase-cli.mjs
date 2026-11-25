import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = join(root, '.local', 'firebase-config');
mkdirSync(config, { recursive: true });
const result = spawnSync(process.execPath, [join(root, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js'), ...process.argv.slice(2)], {
  cwd: root,
  env: { ...process.env, XDG_CONFIG_HOME: config, NO_UPDATE_NOTIFIER: '1' },
  stdio: 'inherit',
});
if (result.error) {
  console.error('Firebase CLI could not start. Install the pinned dependencies with a supported Node version.');
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
