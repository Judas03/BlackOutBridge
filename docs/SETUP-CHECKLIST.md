# Setup checklist

This checklist prepares a fresh clone of BlackOutBridge. The current runnable application is an SDK readiness screen. Restaurant checkout, offline application caching, and the POS recovery connector are still under development.

## Prerequisites

- [ ] Install Node.js 24.12 or newer and npm. The `.nvmrc` file selects the Node 24 line for compatible version managers.
- [ ] Install Git and use a supported desktop Chrome configuration for local inference.
- [ ] Obtain access to an authorized Firebase project before attempting real AI requests. No Firebase project or credentials are bundled with this repository.

## Clone and install

```sh
git clone https://github.com/Judas03/BlackOutBridge.git
cd BlackOutBridge
node scripts/install-git-hooks.mjs
npm ci --ignore-scripts
npm run test:repo
npm run check:sdk
npm run build
npm run dev
```

- [ ] Confirm that `git rev-parse --show-toplevel` points to this clone.
- [ ] Confirm the repository checks, SDK import check, and build pass.
- [ ] Open the local URL printed by Vite. The default is http://127.0.0.1:5173/.
- [ ] Confirm the SDK readiness screen loads. This does not establish that inference or offline checkout works.

The installation disables dependency lifecycle scripts. The prepared dependency set has been built locally with that setting. If a different platform requires additional native-package preparation, inspect the specific package's official instructions before enabling scripts.

## Select a development branch

Use the branch matching the implementation area. Do not use both long-lived branches as independent copies of shared contracts.

```sh
# AI integration and cashier interface
git switch --track origin/feature/ai-checkout
```

```sh
# Local persistence, offline loading, and POS recovery
git switch --track origin/feature/offline-recovery
```

If the branch already exists locally, use `git switch` with its name. See [development workflow](DEVELOPMENT-WORKFLOW.md) for integration and pull request rules. Contributors without write access can use a fork and submit a pull request.

## Configure Firebase locally

```sh
cp .env.example .env.local
npm run firebase -- --version
```

- [ ] Replace the placeholder web configuration in `.env.local` using the intended Firebase web app.
- [ ] Keep `.env.local`, service credentials, private tokens, and App Check debug tokens outside Git.
- [ ] Use the Gemini Developer API/no-cost path where eligible. Review quotas before making requests; no billing setup is required merely to build the readiness screen.

The pinned CLI wrapper stores its local configuration under an ignored directory. Authenticate and select the intended project before provisioning:

```sh
npm run firebase -- login
npm run firebase -- use --add
npm run firebase -- init ailogic
```

- [ ] Verify the selected project before running initialization commands.
- [ ] Complete AI Logic provisioning and any required console steps. Installing the SDK alone does not enable the remote service.
- [ ] Register the Web app with App Check and configure its reCAPTCHA Enterprise site key in `.env.local`.
- [ ] Keep App Check enforcement enabled for AI Logic.

For local development only, `VITE_USE_APPCHECK_DEBUG=true` enables the SDK's generated debug-token flow. Register the generated token privately in Firebase's App Check settings, then restart Vite as necessary. Never commit a token string or publish a debug console recording. The production build does not enable this development flag.

Reference: [Firebase hybrid web setup](https://firebase.google.com/docs/ai-logic/hybrid/web/get-started).

## Prepare the local model

- [ ] Follow the current [Chrome Prompt API prerequisites](https://developer.chrome.com/docs/ai/prompt-api) and [Firebase setup](https://firebase.google.com/docs/ai-logic/hybrid/web/get-started).
- [ ] Run the browser availability check. Browser availability is separate from a successful Firebase AI Logic request.
- [ ] Press the local Firebase check while connected to initialize and download the browser-managed model if supported.
- [ ] Confirm a real response reports the SDK's on-device inference source. Raw enum values are `on_device` and `in_cloud`; compare against `InferenceSource` constants in code.
- [ ] Disconnect and repeat the local request in the loaded readiness page. This checks local inference, not a complete offline app restart.
- [ ] Run the separate cloud check only when ready to send the fixed diagnostic sentence through the configured Firebase project and consume its quota.

Model weights are not part of the npm SDK or this repository. Device support must be tested; a desktop or mobile device specification alone is not proof. Local-only requests must not silently fall back to the cloud.

## Acceptance before claiming outage readiness

These checks depend on features that are not yet implemented:

- [ ] Prepare a catalog, close the browser, disconnect, reopen, and complete a cash sale.
- [ ] Verify deterministic totals and durable local sale/queue storage.
- [ ] Reconnect to an authorized development POS and preview the import.
- [ ] Import a sale and retrieve its native receipt identifier.
- [ ] Retry after an interrupted response without creating a duplicate sale.
- [ ] Preserve historical charges and unresolved payment states; surface catalog conflicts.
- [ ] Verify recovered historical sales do not dispatch kitchen tickets or initiate payment charges.

Use [verification requirements](VERIFICATION.md) for complete acceptance coverage. Private recordings, real business exports, account configuration, and local task sheets are not required to build this repository and must not be uploaded.
