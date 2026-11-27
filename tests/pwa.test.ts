import { describe, expect, it, vi } from 'vitest';
import type { RegisterSWOptions } from 'vite-plugin-pwa/types';
import {
  createPwaController,
  createWorkboxConfig,
  inspectOfflineCacheReadiness,
  isNavigateFallbackDenied,
  isNetworkOnlyUrl,
  PWA_CACHE_ID,
  PWA_CACHE_VERSION,
  type CacheStorageLike,
  type ServiceWorkerContainerLike,
} from '../src/pwa';

describe('PWA cache configuration and routing boundaries', () => {
  it('configures versioned cache ID, cleanup, and safe update activation', () => {
    const workbox = createWorkboxConfig();
    expect(workbox.cacheId).toBe(PWA_CACHE_ID);
    expect(PWA_CACHE_ID).toContain(PWA_CACHE_VERSION);
    expect(workbox.cleanupOutdatedCaches).toBe(true);
    expect(workbox.skipWaiting).toBe(false);
    expect(workbox.clientsClaim).toBe(true);
    expect(workbox.navigateFallback).toBe('/index.html');
  });

  it('denies SPA navigateFallback on /api/* and /__* routes while allowing app routes', () => {
    expect(isNavigateFallbackDenied('/api/continuity/catalog')).toBe(true);
    expect(isNavigateFallbackDenied('/api/continuity/import/commit')).toBe(true);
    expect(isNavigateFallbackDenied('/__/auth/handler')).toBe(true);

    expect(isNavigateFallbackDenied('/')).toBe(false);
    expect(isNavigateFallbackDenied('/checkout')).toBe(false);
    expect(isNavigateFallbackDenied('/recovery')).toBe(false);
  });

  it('keeps POS connector, Firebase reserved, AI Logic, and App Check URLs NetworkOnly', () => {
    expect(isNetworkOnlyUrl('https://blackoutbridge.web.app/api/continuity/import/commit')).toBe(
      true
    );
    expect(isNetworkOnlyUrl('http://127.0.0.1:4173/api/continuity/catalog')).toBe(true);
    expect(isNetworkOnlyUrl('https://blackoutbridge.web.app/__/firebase/init.json')).toBe(true);
    expect(isNetworkOnlyUrl('https://generativelanguage.googleapis.com/v1beta/models')).toBe(true);
    expect(isNetworkOnlyUrl('https://firebaseinstallations.googleapis.com/v1/projects')).toBe(true);
    expect(isNetworkOnlyUrl('https://www.google.com/recaptcha/enterprise.js')).toBe(true);
    expect(isNetworkOnlyUrl('https://www.gstatic.com/recaptcha/releases/abc.js')).toBe(true);

    expect(isNetworkOnlyUrl('https://blackoutbridge.web.app/')).toBe(false);
    expect(isNetworkOnlyUrl('https://blackoutbridge.web.app/assets/index-abc.js')).toBe(false);
    expect(isNetworkOnlyUrl('https://blackoutbridge.web.app/icon.svg')).toBe(false);
  });
});

describe('createPwaController lifecycle', () => {
  it('reports unsupported cleanly when navigator.serviceWorker is absent', async () => {
    const controller = createPwaController();
    expect(controller.getState().supported).toBe(false);
    expect(controller.getState().registrationState).toBe('unsupported');

    const result = await controller.register();
    expect(result.registrationState).toBe('unsupported');
    expect(await controller.applyUpdate()).toBe(false);
    expect(await controller.checkForUpdates()).toBe(false);
  });

  it('tracks offlineReady, needRefresh, update application, and registration errors', async () => {
    let capturedOptions: RegisterSWOptions | undefined;
    const updateCallback = vi.fn(async () => undefined);
    const regUpdate = vi.fn(async () => undefined);

    const swContainer: ServiceWorkerContainerLike = {
      controller: {},
      getRegistration: async () => ({
        active: {},
        update: regUpdate,
      }),
    };

    const states: string[] = [];
    const controller = createPwaController({
      serviceWorkerContainer: swContainer,
      registerSwFn: options => {
        capturedOptions = options;
        return updateCallback;
      },
      onStateChange: s => states.push(`${s.registrationState}:${s.offlineReady}:${s.needRefresh}`),
    });

    await controller.register();
    capturedOptions?.onRegisteredSW?.('/sw.js', {
      active: {},
      update: regUpdate,
    } as unknown as ServiceWorkerRegistration);
    expect(controller.getState().registrationState).toBe('registered');
    expect(controller.getState().controlledBySw).toBe(true);

    capturedOptions?.onOfflineReady?.();
    expect(controller.getState().offlineReady).toBe(true);

    capturedOptions?.onNeedRefresh?.();
    expect(controller.getState().needRefresh).toBe(true);

    expect(await controller.checkForUpdates()).toBe(true);
    expect(regUpdate).toHaveBeenCalledTimes(1);

    expect(await controller.applyUpdate()).toBe(true);
    expect(updateCallback).toHaveBeenCalledWith(true);
    expect(controller.getState().needRefresh).toBe(false);
    expect(states.length).toBeGreaterThanOrEqual(4);

    // Separate controller error test
    const errorController = createPwaController({
      serviceWorkerContainer: swContainer,
      registerSwFn: options => {
        options?.onRegisterError?.(new Error('SW script 404'));
        return updateCallback;
      },
    });
    await errorController.register();
    expect(errorController.getState().registrationState).toBe('error');
    expect(errorController.getState().errorMessage).toBe('SW script 404');
  });
});

describe('inspectOfflineCacheReadiness diagnostics', () => {
  it('requires active SW registration plus required app-shell HTML, JS, and CSS in app-scoped cache', async () => {
    const activeSw: ServiceWorkerContainerLike = {
      controller: {},
      getRegistration: async () => ({
        active: {},
        scope: 'https://example.web.app/',
        update: async () => undefined,
      }),
    };

    // Unrelated workbox-precache-* cache must be ignored even if populated with HTML/JS/CSS.
    const unrelatedCaches: CacheStorageLike = {
      keys: async () => ['workbox-precache-v2-https://other.example/'],
      open: async () => ({
        keys: async () => ['/index.html', '/assets/index.js', '/assets/index.css'],
      }),
    };
    const unrelatedResult = await inspectOfflineCacheReadiness({
      serviceWorkerContainer: activeSw,
      cacheStorage: unrelatedCaches,
    });
    expect(unrelatedResult.hasActiveRegistration).toBe(true);
    expect(unrelatedResult.matchingCacheNames).toEqual([]);
    expect(unrelatedResult.cachedAssetCount).toBe(0);
    expect(unrelatedResult.hasRequiredAppShell).toBe(false);
    expect(unrelatedResult.readyForOfflineStart).toBe(false);

    // Non-empty app cache containing only /icon.svg is not ready.
    const iconOnlyCaches: CacheStorageLike = {
      keys: async () => ['blackoutbridge-v1'],
      open: async () => ({ keys: async () => ['/icon.svg'] }),
    };
    const iconOnlyResult = await inspectOfflineCacheReadiness({
      serviceWorkerContainer: activeSw,
      cacheStorage: iconOnlyCaches,
    });
    expect(iconOnlyResult.cachedAssetCount).toBe(1);
    expect(iconOnlyResult.hasRequiredAppShell).toBe(false);
    expect(iconOnlyResult.readyForOfflineStart).toBe(false);

    // Partial app shell missing app JS bundle and CSS (only index.html + registerSW.js) is not ready.
    const partialShellCaches: CacheStorageLike = {
      keys: async () => ['blackoutbridge-v1-precache'],
      open: async () => ({
        keys: async () => ['/index.html', '/registerSW.js', '/workbox-abc123.js'],
      }),
    };
    const partialResult = await inspectOfflineCacheReadiness({
      serviceWorkerContainer: activeSw,
      cacheStorage: partialShellCaches,
    });
    expect(partialResult.hasAppShellHtml).toBe(true);
    expect(partialResult.hasAppShellScript).toBe(false);
    expect(partialResult.hasAppShellStyles).toBe(false);
    expect(partialResult.hasRequiredAppShell).toBe(false);
    expect(partialResult.readyForOfflineStart).toBe(false);

    // Scoped Workbox precache with Request-like entries and full app shell reports ready;
    // caches for other registration scopes are excluded.
    const populatedCaches: CacheStorageLike = {
      keys: async () => [
        'blackoutbridge-v1-precache-v2-https://example.web.app/',
        'blackoutbridge-v1-precache-v2-https://other.web.app/',
        'unrelated-cache',
      ],
      open: async name => ({
        keys: async () =>
          name === 'blackoutbridge-v1-precache-v2-https://example.web.app/'
            ? [
                { url: 'https://example.web.app/index.html?__WB_REVISION__=5a9f6f' },
                { url: 'https://example.web.app/assets/index-DqbFatFZ.js' },
                { url: 'https://example.web.app/assets/index-CdTRqWY8.css' },
                { url: 'https://example.web.app/icon.svg?__WB_REVISION__=4ed42e' },
              ]
            : ['/ignore-me.html', '/ignore-me.js', '/ignore-me.css'],
      }),
    };

    const ready = await inspectOfflineCacheReadiness({
      serviceWorkerContainer: activeSw,
      cacheStorage: populatedCaches,
    });
    expect(ready.matchingCacheNames).toEqual([
      'blackoutbridge-v1-precache-v2-https://example.web.app/',
    ]);
    expect(ready.cachedAssetCount).toBe(4);
    expect(ready.hasAppShellHtml).toBe(true);
    expect(ready.hasAppShellScript).toBe(true);
    expect(ready.hasAppShellStyles).toBe(true);
    expect(ready.hasRequiredAppShell).toBe(true);
    expect(ready.readyForOfflineStart).toBe(true);
  });
});
