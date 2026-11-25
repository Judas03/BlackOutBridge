#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');
const maxBytes = 1024 * 1024;
const rootFiles = new Set([
  '.gitignore', '.gitattributes', '.env.example', '.nvmrc',
  'README.md', 'LICENSE', 'package.json', 'package-lock.json',
  'pnpm-lock.yaml', 'index.html', 'firebase.json',
]);
const publicRoots = new Set(['src', 'server', 'public', 'tests', 'docs', 'scripts', '.github', '.githooks']);
const sourceExtensions = /\.(?:[cm]?js|jsx|ts|tsx|json|md|ya?ml|html|css|scss|svg|txt|toml|xml|webmanifest|sh)$/i;
const rootConfigs = /^(?:(?:vite|vitest|playwright|eslint)\.config\.(?:[cm]?js|ts)|tsconfig(?:\.[a-z0-9_-]+)?\.json)$/i;
const privateDirectories = new Set([
  '.local', '.private', 'private', 'local-only', '.agents', '.codex', '.git',
  'recordings', 'screenshots', 'uploads', 'exports', 'backups', 'evidence',
  'tmp', 'temp', 'node_modules', 'dist', 'coverage', 'test-results',
  'playwright-report', '.firebase', '.cache',
]);

export function pathIssue(path) {
  if (!path || path.startsWith('/') || !/^[A-Za-z0-9_./-]+$/.test(path)) return 'invalid public path';
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return 'invalid public path';
  const lower = parts.map(part => part.toLowerCase());
  const name = lower.at(-1);
  if (lower.some(part => privateDirectories.has(part))) return 'private or generated directory';
  if (lower.some(part => part.includes('demo'))) return 'demo material is local-only';
  if (/^(?:agents?|claude|gemini|memory)\.md$/.test(name)) return 'local agent instructions';
  if (/^(?:my-tasks|friend-tasks|team-|roles\.|build-plan|todo\.|video-script)/.test(name)) return 'private team or submission instructions';
  if (name === '.env' || name.startsWith('.env.')) {
    if (path !== '.env.example') return 'environment file';
  }
  if (/service[-_]?account|credentials/i.test(name)) return 'credential-related filename';
  if (rootFiles.has(path)) return null;
  if (parts.length === 1 && rootConfigs.test(path)) return null;
  if (!publicRoots.has(parts[0])) return 'outside the public allowlist';
  if (parts[0] === '.githooks' && ['pre-commit', 'pre-push'].includes(parts[1]) && parts.length === 2) return null;
  if (!sourceExtensions.test(name)) return 'non-source asset or export';
  return null;
}

export function contentIssue(buffer) {
  if (buffer.length > maxBytes) return 'file exceeds the 1 MiB public-source limit';
  if (buffer.includes(0)) return 'binary file';
  let value;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { return 'invalid UTF-8 source'; }
  const patterns = [
    ['private key material', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
    ['service account private key field', /["']private_key["']\s*:\s*["']/],
    ['GitHub token pattern', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
    ['provider API key pattern', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
    ['Google API key value', /\bAIza[A-Za-z0-9_-]{35}\b/],
    ['App Check debug token value', /FIREBASE_APPCHECK_DEBUG_TOKEN\s*(?:=|:)\s*["']?[a-f0-9-]{32,}/i],
  ];
  for (const [label, pattern] of patterns) if (pattern.test(value)) return label;
  return null;
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024, ...options,
  });
}

function assertRepositoryBoundary() {
  const actual = git(['rev-parse', '--show-toplevel']).trim();
  if (realpathSync(actual) !== realpathSync(projectRoot)) {
    throw new Error('Refusing to inspect a parent repository. Initialize or enter the isolated BlackOutBridge repository.');
  }
}

function nulList(value) { return value.split('\0').filter(Boolean); }

function indexEntries() {
  return nulList(git(['ls-files', '--stage', '-z'])).map(entry => {
    const tab = entry.indexOf('\t');
    const [mode, object, stage] = entry.slice(0, tab).split(' ');
    return { path: entry.slice(tab + 1), mode, object, stage };
  });
}

function treeEntries(commit) {
  return nulList(git(['ls-tree', '-r', '-z', commit])).map(entry => {
    const tab = entry.indexOf('\t');
    const [mode, , object] = entry.slice(0, tab).split(' ');
    return { path: entry.slice(tab + 1), mode, object, stage: '0' };
  });
}

function scanEntries(entries, label, failures, seenObjects) {
  for (const entry of entries) {
    const problem = pathIssue(entry.path);
    if (problem) { failures.add(`${label}: ${JSON.stringify(entry.path)}: ${problem}`); continue; }
    if (!['100644', '100755'].includes(entry.mode)) {
      failures.add(`${label}: ${JSON.stringify(entry.path)}: symlinks, submodules, or unsupported modes are forbidden`);
      continue;
    }
    if (entry.stage !== '0') {
      failures.add(`${label}: ${JSON.stringify(entry.path)}: unresolved merge entry`);
      continue;
    }
    let contentProblem = seenObjects.get(entry.object);
    if (!seenObjects.has(entry.object)) {
      contentProblem = contentIssue(git(['cat-file', 'blob', entry.object], { encoding: 'buffer' }));
      seenObjects.set(entry.object, contentProblem);
    }
    if (contentProblem) failures.add(`${label}: ${JSON.stringify(entry.path)}: ${contentProblem}`);
  }
}

function scanWorktree(failures) {
  const paths = nulList(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']));
  for (const path of new Set(paths)) {
    const problem = pathIssue(path);
    if (problem) { failures.add(`worktree: ${JSON.stringify(path)}: ${problem}`); continue; }
    const absolute = resolve(projectRoot, path);
    let stat;
    try { stat = lstatSync(absolute); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      failures.add(`worktree: ${JSON.stringify(path)}: only regular source files are allowed`);
      continue;
    }
    if (stat.size > maxBytes) {
      failures.add(`worktree: ${JSON.stringify(path)}: file exceeds the 1 MiB public-source limit`);
      continue;
    }
    const contentProblem = contentIssue(readFileSync(absolute));
    if (contentProblem) failures.add(`worktree: ${JSON.stringify(path)}: ${contentProblem}`);
  }
}

function scanHistory(ref, failures, seenObjects, seenCommits) {
  if (!ref || ref.startsWith('-') || /[\s\0]/.test(ref)) throw new Error('Invalid history reference.');
  const commit = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
  const commits = git(['rev-list', commit]).trim().split('\n').filter(Boolean);
  if (commits.length > 5000) throw new Error('History exceeds the small-project scan limit; review the publication policy before pushing.');
  for (const sha of commits) {
    if (seenCommits.has(sha)) continue;
    seenCommits.add(sha);
    scanEntries(treeEntries(sha), `commit ${sha.slice(0, 12)}`, failures, seenObjects);
  }
}

function run() {
  assertRepositoryBoundary();
  const args = process.argv.slice(2);
  const mode = args[0] ?? '--index';
  if (!['--index', '--worktree', '--history', '--push'].includes(mode)) {
    throw new Error('Usage: check-public-files.mjs [--index | --worktree | --history REF | --push]');
  }
  if ((mode === '--history' && args.length !== 2) || (mode !== '--history' && args.length > 1)) {
    throw new Error('Unexpected arguments.');
  }
  const failures = new Set();
  const seenObjects = new Map();
  const seenCommits = new Set();
  if (mode === '--index' || mode === '--worktree') {
    scanEntries(indexEntries(), 'index', failures, seenObjects);
    if (mode === '--worktree') scanWorktree(failures);
  } else if (mode === '--history') {
    scanHistory(args[1], failures, seenObjects, seenCommits);
  } else {
    for (const line of readFileSync(0, 'utf8').trim().split('\n').filter(Boolean)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length !== 4) throw new Error('Invalid pre-push input.');
      const localSha = fields[1];
      if (/^0+$/.test(localSha)) continue;
      if (!/^[a-f0-9]{40,64}$/i.test(localSha)) throw new Error('Invalid outgoing commit identifier.');
      scanHistory(localSha, failures, seenObjects, seenCommits);
    }
  }
  if (failures.size) {
    console.error('Publication blocked. Private contents are not printed.');
    for (const failure of [...failures].slice(0, 40)) console.error(`- ${failure}`);
    if (failures.size > 40) console.error(`- ${failures.size - 40} additional findings`);
    process.exitCode = 1;
  } else {
    console.log(`Public-file check passed (${mode}; ${seenCommits.size} historical commits inspected).`);
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(scriptPath)) {
  try { run(); }
  catch (error) {
    // Git stderr and file contents may contain private values; keep errors bounded.
    console.error(error instanceof Error && !('status' in error) ? error.message : 'Public-file check failed; inspect the local repository setup.');
    process.exitCode = 1;
  }
}
