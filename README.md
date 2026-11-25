# BlackOutBridge

An independent emergency checkout for restaurants whose normal POS is unavailable. Prepare a menu on a supported laptop, keep recording new orders offline, then reconcile those sales with the original POS after service returns.

Status: architecture, pinned dependencies, and an SDK readiness scaffold are prepared. Restaurant checkout, offline caching, and the POS connector are not implemented yet. No real on-device or cloud inference result has been verified.

## First release

- One restaurant and one prepared desktop Chrome device.
- Ordinary menu buttons and AI-assisted English shorthand order entry.
- Cached catalog, deterministic totals, confirmed cash records, and a durable local queue.
- Explicit local and cloud inference through Firebase AI Logic with App Check.
- One authorized POS connector, import preview, duplicate prevention, and visible exceptions.

The first release does not collect card credentials or provide universal POS integration. Existing POS support depends on an implemented connector. A charged, previously prepared device is required during an outage.

## Documentation

- [Setup checklist](docs/SETUP-CHECKLIST.md)
- [Role-based development workflow](docs/DEVELOPMENT-WORKFLOW.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Shared data and API contracts](docs/CONTRACTS.md)
- [Verification requirements](docs/VERIFICATION.md)
- [Contribution and publication rules](docs/CONTRIBUTING.md)
- [Official development resources](docs/RESOURCES.md)

## Development branches

`main` is the integration baseline. `feature/ai-checkout` covers model integration and cashier interaction. `feature/offline-recovery` covers persistence, deterministic pricing, offline loading, and POS synchronization. Use pull requests into `main` and coordinate shared contract changes. See the development workflow for module ownership and integration steps.

## Repository setup

Use Node.js 24.12 or newer, as required by the installed Firebase packages. From this repository root, run:

```sh
node scripts/install-git-hooks.mjs
node --test scripts/check-public-files.test.mjs
node scripts/check-public-files.mjs --worktree
```

Install and run the SDK readiness scaffold:

```sh
npm ci --ignore-scripts
npm run check:sdk
npm run build
npm run dev
```

Copy `.env.example` to `.env.local` and provide configuration from an authorized Firebase web app to enable actual inference checks. Enable Firebase AI Logic for that project and configure App Check first. The readiness screen does not call a model automatically. Browser availability alone is not proof of inference. Cloud checks use the configured account's quota.

`npm run firebase -- --version` invokes the pinned local Firebase CLI. Its configuration stays in the ignored local folder rather than changing a global CLI login. No Firebase project is selected by this scaffold. Live Firebase setup and judge instructions must be completed before submission; the public application must not depend on private planning documents or recordings.

## Publication policy

Only project source, technical documentation, build configuration, and meaningful source tests belong here. People-specific instructions, agent files, recordings, screenshots, real catalog exports, submission assets, secrets, and unrelated files stay outside Git tracking. The allowlist in `.gitignore`, repository checks, and installed Git hooks enforce the normal contribution workflow. Each contributor must install the hooks after cloning.

## License

New code in this repository is licensed under [MIT](LICENSE). Any pre-existing POS code incorporated later must have its ownership, license, and hackathon disclosure reviewed separately.
