import type { RegisterSWOptions } from 'vite-plugin-pwa/types';
import { PWA_CACHE_ID, PWA_CACHE_VERSION } from './cache-config';

export type PwaReadinessState = {
  supported: boolean;
  cacheId: string;
  cacheVersion: string;
  registrationState: 'idle' | 'registering' | 'registered' | 'unsupported' | 'error';
  offlineReady: boolean;
  needRefresh: boolean;
  controlledBySw: boolean;
  errorMessage?: string;
};

export type OfflineCacheDiagnostics = {
  serviceWorkerSupported: boolean;
  cacheStorageSupported: boolean;
  hasActiveRegistration: boolean;
  controlledBySw: boolean;
  matchingCacheNames: string[];
  cachedAssetCount: number;
  hasAppShellHtml: boolean;
  hasAppShellScript: boolean;
  hasAppShellStyles: boolean;
  hasRequiredAppShell: boolean;
  readyForOfflineStart: boolean;
};

export type ServiceWorkerRegistrationLike = {
  active: unknown;
  scope?: string;
  update(): Promise<unknown>;
};

export type ServiceWorkerContainerLike = {
  controller: unknown;
  getRegistration(): Promise<ServiceWorkerRegistrationLike | undefined>;
};

export type CacheLike = {
  keys(): Promise<readonly unknown[]>;
};

export type CacheStorageLike = {
  keys(): Promise<string[]>;
  open(cacheName: string): Promise<CacheLike>;
};

export type RegisterSwFn = (options?: RegisterSWOptions) => (reloadPage?: boolean) => Promise<void>;

export type PwaControllerOptions = {
  registerSwFn?: RegisterSwFn;
  serviceWorkerContainer?: ServiceWorkerContainerLike;
  onStateChange?: (state: PwaReadinessState) => void;
};

function resolveServiceWorkerContainer(
  provided?: ServiceWorkerContainerLike
): ServiceWorkerContainerLike | undefined {
  if (provided) return provided;
  if (typeof globalThis.navigator !== 'undefined' && 'serviceWorker' in globalThis.navigator) {
    return globalThis.navigator.serviceWorker;
  }
  return undefined;
}

function resolveCacheStorage(provided?: CacheStorageLike): CacheStorageLike | undefined {
  if (provided) return provided;
  if (typeof globalThis.caches !== 'undefined') {
    return globalThis.caches;
  }
  return undefined;
}

function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim().slice(0, 160);
  }
  return 'Service worker registration failed.';
}

function matchesAppCache(cacheName: string, registrationScope?: string): boolean {
  const isAppPrefixed = cacheName === PWA_CACHE_ID || cacheName.startsWith(`${PWA_CACHE_ID}-`);
  if (!isAppPrefixed) return false;
  if (registrationScope && cacheName.includes('-precache-v2-')) {
    return cacheName === `${PWA_CACHE_ID}-precache-v2-${registrationScope}`;
  }
  return true;
}

function extractEntryPathname(entry: unknown): string | null {
  let rawUrl: string | undefined;
  if (typeof entry === 'string') {
    rawUrl = entry;
  } else if (entry && typeof entry === 'object' && 'url' in entry) {
    const candidate = (entry as { url?: unknown }).url;
    if (typeof candidate === 'string') {
      rawUrl = candidate;
    }
  }
  if (!rawUrl || !rawUrl.trim()) return null;
  try {
    return new URL(rawUrl, 'https://app.local').pathname;
  } catch {
    return null;
  }
}

function isHtmlShellPath(pathname: string): boolean {
  return pathname === '/' || pathname === '/index.html' || pathname.endsWith('/index.html');
}

function isAppScriptPath(pathname: string): boolean {
  if (!pathname.endsWith('.js')) return false;
  const basename = pathname.split('/').pop() ?? '';
  return (
    basename !== 'sw.js' &&
    basename !== 'registerSW.js' &&
    !basename.startsWith('workbox-')
  );
}

function isAppStylesPath(pathname: string): boolean {
  return pathname.endsWith('.css');
}

/**
 * Creates a UI-agnostic controller around vite-plugin-pwa registration and update prompts.
 */
export function createPwaController(options?: PwaControllerOptions) {
  const swContainer = resolveServiceWorkerContainer(options?.serviceWorkerContainer);
  let registration: ServiceWorkerRegistrationLike | undefined;
  let updateSw: ((reloadPage?: boolean) => Promise<void>) | undefined;

  let state: PwaReadinessState = {
    supported: Boolean(swContainer),
    cacheId: PWA_CACHE_ID,
    cacheVersion: PWA_CACHE_VERSION,
    registrationState: swContainer ? 'idle' : 'unsupported',
    offlineReady: false,
    needRefresh: false,
    controlledBySw: Boolean(swContainer?.controller),
  };

  function setState(patch: Partial<PwaReadinessState>, clearError = false): PwaReadinessState {
    const next: PwaReadinessState = {
      ...state,
      ...patch,
    };
    if (clearError) {
      delete next.errorMessage;
    }
    state = next;
    options?.onStateChange?.({ ...state });
    return { ...state };
  }

  return {
    getState(): PwaReadinessState {
      return { ...state };
    },

    async register(): Promise<PwaReadinessState> {
      if (!swContainer) {
        return setState({ supported: false, registrationState: 'unsupported' }, true);
      }
      if (updateSw) {
        return setState({ controlledBySw: Boolean(swContainer.controller) });
      }

      setState({ registrationState: 'registering' }, true);

      try {
        const registerSW =
          options?.registerSwFn ?? (await import('virtual:pwa-register')).registerSW;

        updateSw = registerSW({
          immediate: true,
          onRegisteredSW(_swScriptUrl, reg) {
            registration = reg;
            setState(
              {
                registrationState: 'registered',
                controlledBySw: Boolean(swContainer.controller),
              },
              true
            );
          },
          onOfflineReady() {
            setState(
              {
                registrationState: 'registered',
                offlineReady: true,
                controlledBySw: Boolean(swContainer.controller),
              },
              true
            );
          },
          onNeedRefresh() {
            setState(
              {
                registrationState: 'registered',
                needRefresh: true,
                controlledBySw: Boolean(swContainer.controller),
              },
              true
            );
          },
          onRegisterError(error) {
            updateSw = undefined;
            setState({
              registrationState: 'error',
              errorMessage: sanitizeErrorMessage(error),
            });
          },
        });

        return { ...state };
      } catch (error) {
        updateSw = undefined;
        return setState({
          registrationState: 'error',
          errorMessage: sanitizeErrorMessage(error),
        });
      }
    },

    async applyUpdate(): Promise<boolean> {
      if (!updateSw) return false;
      await updateSw(true);
      setState({ needRefresh: false, controlledBySw: Boolean(swContainer?.controller) }, true);
      return true;
    },

    async checkForUpdates(): Promise<boolean> {
      const targetReg = registration ?? (await swContainer?.getRegistration());
      if (!targetReg || typeof targetReg.update !== 'function') return false;
      await targetReg.update();
      return true;
    },
  };
}

/**
 * Inspects actual Service Worker registration and CacheStorage entries for this app's scoped
 * precache and required app-shell assets (HTML, app JS bundle, CSS) rather than relying on
 * navigator.onLine alone. This diagnostic does not substitute for a live disconnected restart test.
 */
export async function inspectOfflineCacheReadiness(deps?: {
  serviceWorkerContainer?: ServiceWorkerContainerLike;
  cacheStorage?: CacheStorageLike;
}): Promise<OfflineCacheDiagnostics> {
  const swContainer = resolveServiceWorkerContainer(deps?.serviceWorkerContainer);
  const cacheStorage = resolveCacheStorage(deps?.cacheStorage);

  const serviceWorkerSupported = Boolean(swContainer);
  const cacheStorageSupported = Boolean(cacheStorage);
  const controlledBySw = Boolean(swContainer?.controller);

  let hasActiveRegistration = false;
  let registrationScope: string | undefined;
  if (swContainer) {
    try {
      const reg = await swContainer.getRegistration();
      hasActiveRegistration = Boolean(reg?.active);
      if (typeof reg?.scope === 'string' && reg.scope.trim().length > 0) {
        registrationScope = reg.scope;
      }
    } catch {
      hasActiveRegistration = false;
      registrationScope = undefined;
    }
  }

  let matchingCacheNames: string[] = [];
  let cachedAssetCount = 0;
  let hasAppShellHtml = false;
  let hasAppShellScript = false;
  let hasAppShellStyles = false;

  if (cacheStorage) {
    try {
      const names = await cacheStorage.keys();
      matchingCacheNames = names.filter(name => matchesAppCache(name, registrationScope));
      for (const name of matchingCacheNames) {
        const cache = await cacheStorage.open(name);
        const entries = await cache.keys();
        cachedAssetCount += entries.length;
        for (const entry of entries) {
          const pathname = extractEntryPathname(entry);
          if (!pathname) continue;
          if (isHtmlShellPath(pathname)) hasAppShellHtml = true;
          if (isAppScriptPath(pathname)) hasAppShellScript = true;
          if (isAppStylesPath(pathname)) hasAppShellStyles = true;
        }
      }
    } catch {
      matchingCacheNames = [];
      cachedAssetCount = 0;
      hasAppShellHtml = false;
      hasAppShellScript = false;
      hasAppShellStyles = false;
    }
  }

  const hasRequiredAppShell = hasAppShellHtml && hasAppShellScript && hasAppShellStyles;

  return {
    serviceWorkerSupported,
    cacheStorageSupported,
    hasActiveRegistration,
    controlledBySw,
    matchingCacheNames,
    cachedAssetCount,
    hasAppShellHtml,
    hasAppShellScript,
    hasAppShellStyles,
    hasRequiredAppShell,
    readyForOfflineStart: hasActiveRegistration && hasRequiredAppShell,
  };
}
