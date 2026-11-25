import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { contentIssue, pathIssue } from './check-public-files.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const checkerSource = join(here, 'check-public-files.mjs');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'blackoutbridge-guard-'));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '--quiet', '--initial-branch=main']);
  git(['config', '--local', 'user.name', 'Guard test']);
  git(['config', '--local', 'user.email', 'guard@example.invalid']);
  git(['config', '--local', 'commit.gpgsign', 'false']);
  git(['config', '--local', 'core.hooksPath', '.test-hooks-not-installed']);
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'src'));
  copyFileSync(checkerSource, join(root, 'scripts', 'check-public-files.mjs'));
  writeFileSync(join(root, 'README.md'), '# Test project\n');
  const run = (args, input = '') => spawnSync(process.execPath, [join(root, 'scripts', 'check-public-files.mjs'), ...args], {
    cwd: root, encoding: 'utf8', input,
  });
  return { root, git, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('allows intentional source and configuration paths', () => {
  for (const path of ['README.md', 'LICENSE', '.env.example', 'src/ai/parse.ts', 'docs/ARCHITECTURE.md', '.githooks/pre-push', '.github/workflows/public-files.yml', 'tsconfig.app.json']) {
    assert.equal(pathIssue(path), null, path);
  }
});

test('rejects local instructions regardless of case or nesting', () => {
  for (const path of ['AGENTS.md', 'agent.md', 'docs/AgEnTs.MD', '.local/MY-TASKS.md', 'docs/friend-tasks.md', 'docs/team-plan.md', 'docs/roles.md', 'src/private/data.json']) {
    assert.ok(pathIssue(path), path);
  }
});

test('rejects media, exports, secrets, unrelated roots, and path escapes', () => {
  for (const path of ['src/demo.ts', 'public/DEMO/example.svg', 'docs/order-export.csv', 'public/recording.mp4', 'docs/photo.png', '.env.local', 'server/service-account.json', 'notes.md', 'unrelated/file.ts', '../README.md', 'src/../README.md']) {
    assert.ok(pathIssue(path), path);
  }
});

test('detects credential patterns without requiring real credentials', () => {
  const privateKey = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  const token = ['gh', 'p_', 'x'.repeat(36)].join('');
  const serviceAccount = JSON.stringify({ ['private' + '_key']: 'synthetic test value' });
  for (const value of [privateKey, token, serviceAccount]) assert.ok(contentIssue(Buffer.from(value)));
});

test('accepts placeholder configuration and normal UTF-8 source', () => {
  assert.equal(contentIssue(Buffer.from('VITE_FIREBASE_API_KEY=REPLACE_WITH_LOCAL_CONFIG\n')), null);
  assert.equal(contentIssue(Buffer.from('export const label = "ကော်ဖီ";\n')), null);
});

test('rejects binary and oversized source', () => {
  assert.ok(contentIssue(Buffer.from([65, 0, 66])));
  assert.ok(contentIssue(Buffer.alloc(1024 * 1024 + 1, 65)));
});

test('blocks a forced private file in the index', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, '.local'));
    writeFileSync(join(f.root, '.local', 'notes.md'), 'Private planning content\n');
    f.git(['add', '.local/notes.md']);
    const result = f.run(['--index']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /private or generated directory/);
    assert.ok(!result.stderr.includes('Private planning content'));
  } finally { f.cleanup(); }
});

test('blocks a symlink instead of reading its target', () => {
  const f = fixture();
  try {
    symlinkSync('../README.md', join(f.root, 'src', 'link.md'));
    f.git(['add', 'src/link.md']);
    const result = f.run(['--index']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /symlinks/);
  } finally { f.cleanup(); }
});

test('inspects staged content even if the working file has been cleaned', () => {
  const f = fixture();
  try {
    const token = ['gh', 'p_', 'x'.repeat(36)].join('');
    writeFileSync(join(f.root, 'src', 'config.ts'), `export const value = '${token}';\n`);
    f.git(['add', 'src/config.ts']);
    writeFileSync(join(f.root, 'src', 'config.ts'), 'export const value = "placeholder";\n');
    const result = f.run(['--index']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /GitHub token pattern/);
    assert.ok(!result.stderr.includes(token));
  } finally { f.cleanup(); }
});

test('history scan catches a private file deleted from HEAD and pre-push blocks it', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, '.local'));
    writeFileSync(join(f.root, '.local', 'notes.md'), 'Private planning content\n');
    f.git(['add', 'README.md', 'scripts/check-public-files.mjs', '.local/notes.md']);
    f.git(['commit', '--quiet', '-m', 'fixture with forbidden history']);
    f.git(['rm', '--quiet', '.local/notes.md']);
    f.git(['commit', '--quiet', '-m', 'remove fixture from latest tree']);
    assert.equal(f.run(['--index']).status, 0);
    assert.equal(f.run(['--history', 'HEAD']).status, 1);
    const sha = f.git(['rev-parse', 'HEAD']).trim();
    const input = `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`;
    assert.equal(f.run(['--push'], input).status, 1);
    const hook = spawnSync('sh', [join(here, '..', '.githooks', 'pre-push')], { cwd: f.root, encoding: 'utf8', input });
    assert.equal(hook.status, 1);
  } finally { f.cleanup(); }
});

test('CLI checks still execute through a symlinked directory', () => {
  const f = fixture();
  const alias = `${f.root}-alias`;
  try {
    symlinkSync(f.root, alias, 'dir');
    mkdirSync(join(f.root, '.local'));
    writeFileSync(join(f.root, '.local', 'notes.md'), 'Private planning content\n');
    f.git(['add', '.local/notes.md']);
    const result = spawnSync(process.execPath, [join(alias, 'scripts', 'check-public-files.mjs'), '--index'], { cwd: alias, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /private or generated directory/);
  } finally { try { unlinkSync(alias); } finally { f.cleanup(); } }
});

test('refuses to treat a parent repository as the project repository', () => {
  const f = fixture();
  try {
    const nested = join(f.root, 'nested-project', 'scripts');
    mkdirSync(nested, { recursive: true });
    copyFileSync(checkerSource, join(nested, 'check-public-files.mjs'));
    const result = spawnSync(process.execPath, [join(nested, 'check-public-files.mjs'), '--worktree'], { cwd: f.root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /parent repository/);
  } finally { f.cleanup(); }
});

test('installed pre-commit hook blocks a private file before creating a commit', () => {
  const f = fixture();
  try {
    copyFileSync(join(here, 'install-git-hooks.mjs'), join(f.root, 'scripts', 'install-git-hooks.mjs'));
    mkdirSync(join(f.root, '.githooks'));
    for (const name of ['pre-commit', 'pre-push']) copyFileSync(join(here, '..', '.githooks', name), join(f.root, '.githooks', name));
    const install = spawnSync(process.execPath, [join(f.root, 'scripts', 'install-git-hooks.mjs')], { cwd: f.root, encoding: 'utf8' });
    assert.equal(install.status, 0);
    mkdirSync(join(f.root, '.local'));
    writeFileSync(join(f.root, '.local', 'notes.md'), 'Private planning content\n');
    f.git(['add', '.local/notes.md']);
    const result = spawnSync('git', ['commit', '--quiet', '-m', 'must be blocked'], { cwd: f.root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Publication blocked/);
    const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: f.root, encoding: 'utf8' });
    assert.notEqual(head.status, 0);
  } finally { f.cleanup(); }
});

test('clean source passes a full history scan', () => {
  const f = fixture();
  try {
    f.git(['add', 'README.md', 'scripts/check-public-files.mjs']);
    f.git(['commit', '--quiet', '-m', 'clean source fixture']);
    assert.equal(f.run(['--history', 'HEAD']).status, 0);
    assert.equal(f.run(['--worktree']).status, 0);
  } finally { f.cleanup(); }
});
