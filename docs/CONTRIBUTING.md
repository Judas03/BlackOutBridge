# Contribution and publication rules

The public repository contains project source, build configuration, technical documentation, and meaningful source tests. People-specific instructions, agent files, private business exports, recordings, screenshots, submission material, and unrelated files stay local.

## Each clone

From the project root, install the versioned hooks and run their checks:

```sh
node scripts/install-git-hooks.mjs
node --test scripts/check-public-files.test.mjs
node scripts/check-public-files.mjs --worktree
```

The setup changes repository-local hook configuration only. It does not configure a remote or push files. Verify that `git rev-parse --show-toplevel` identifies the BlackOutBridge folder before staging anything.

## Before a commit

Use explicit paths and review the staged diff:

```sh
git add src docs tests
git diff --cached --stat
git diff --cached
node scripts/check-public-files.mjs --index
```

Stage only directories that exist and files intended for publication. Do not use force-add on ignored material or bypass the hooks. `.gitignore` does not remove already tracked files; the index and history checks also reject forbidden paths.

The public file checker uses an explicit path and text-file allowlist, rejects symlinks and submodules, and detects selected high-confidence credential patterns. It prints findings without printing file contents. It is not a comprehensive secret or personal-data detector; review staged content before publishing.

## Before a push

```sh
node scripts/check-public-files.mjs --history HEAD
git status --short
```

The pre-push hook also inspects all reachable commits of the branch or tag being pushed, including files deleted from the latest tree. A forbidden historical file must be removed from unpublished history before publication. If sensitive material has already reached a remote, removing it from the latest commit is insufficient; investigate the exposure and any required credential rotation separately.

Every contributor must install the hooks. Git options can bypass local hooks, so the procedure and human review remain part of the publication boundary. The GitHub workflow is a secondary check after upload; it cannot prevent an initial disclosure.

## File boundary

- Root public files and public source directories are explicitly allowed in `.gitignore` and the checker.
- Agent instruction filenames, local planning folders, person-specific task files, any path containing `demo`, raw recordings, media, archives, databases, and business exports are denied.
- `.env.example` contains placeholders only. Real `.env` files, service-account files, private keys, and App Check debug tokens stay local.
- New source roots, assets, or configuration filenames require a deliberate update to both the ignore policy and the checker, plus a test covering the intended exception.
- Public source tests can contain minimal synthetic inputs; they must not import private recordings, real business exports, or local submission assets.

Private instructions needed by a teammate must be shared separately through an authorized private channel. They are deliberately absent from the clone.
