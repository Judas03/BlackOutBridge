# Development workflow

BlackOutBridge uses a stable integration branch and two role-based implementation branches. The workflow supports parallel development against shared contracts without putting personal instructions, agent files, or private business data in the repository.

## Branches and ownership

| Branch | Responsibility | Primary modules |
| --- | --- | --- |
| `main` | Reviewed, buildable integration baseline | Shared configuration, contracts, and accepted features |
| `feature/ai-checkout` | Model integration and the cashier experience | `src/ai/`, `src/components/`, `src/features/` |
| `feature/offline-recovery` | Durable records, pricing, caching, and backend recovery | `src/domain/`, `src/storage/`, `src/sync/`, `src/pwa/`, `server/` |

The branch names describe responsibilities, not particular people. Coordinate edits to package manifests, shared schemas, application entry files, and deployment configuration before changing them. Source layout directories will be added as the corresponding features are implemented.

## Begin a work session

```sh
git fetch origin
git switch feature/ai-checkout
git merge origin/main
```

Use `feature/offline-recovery` for the other implementation area. A shared branch should use ordinary fast-forward pushes and merge-based updates; do not rewrite a collaborator's published commits. Use separate clones or worktrees for simultaneous work on one machine.

Read [architecture](ARCHITECTURE.md) and [canonical contracts](CONTRACTS.md) before editing integration boundaries. Keep changes focused on one complete behavior. A schema change must include its consumers and relevant tests in the same reviewed change.

## Verify and publish a change

```sh
npm run test:repo
npm run check:sdk
npm run build
npm run check:public
```

Add feature tests appropriate to the behavior changed. A build and import check do not prove browser behavior, actual model inference, offline durability, or native POS correctness.

Stage explicit project paths, inspect the diff, then commit and push the role branch. Install the versioned hooks in each clone and never bypass them or force-add ignored material. Before publication, run:

```sh
git diff --cached --stat
git diff --cached
node scripts/check-public-files.mjs --index
node scripts/check-public-files.mjs --history HEAD
```

Open a pull request into `main`. Include the concrete behavior changed, meaningful verification, and any remaining limitations. Request review from another contributor with repository access. Raw customer data, debug tokens, local task sheets, and agent conversations do not belong in the pull request description or attachments.

## Integrate

1. Run the public-source policy and build workflow on the pull request.
2. Review contract changes and financial or recovery side effects explicitly.
3. Merge after the relevant checks pass and outstanding concerns are resolved.
4. Fetch the updated `main` and merge it into both role branches before the next integration-dependent change.

Branch protection can enforce this process when configured by a repository administrator. This document does not itself enable protection or grant collaborators write access.

## Reporting progress

Use pull request descriptions and concise commit messages for project changes. Distinguish code completion, automated checks, browser/device results, and deployed verification. Keep private assignments, personal coordination, recordings, real data, and agent instructions outside GitHub. Public technical documentation should remain sufficient for a fresh contributor to build the project.
