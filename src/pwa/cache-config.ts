export const PWA_CACHE_VERSION = 'v1';
export const PWA_CACHE_ID = `blackoutbridge-${PWA_CACHE_VERSION}`;
export const PWA_SW_FILENAME = 'sw.js';

export const PWA_PRECACHE_GLOB_PATTERNS = ['**/*.{js,css,html,svg,webmanifest}'] as const;
export const PWA_INCLUDE_ASSETS = ['icon.svg'] as const;
export const PWA_NAVIGATE_FALLBACK = '/index.html';

export const PWA_NAVIGATE_FALLBACK_DENYLIST: readonly RegExp[] = [/^\/api\//, /^\/__\//];

export const PWA_NETWORK_ONLY_PATTERNS: readonly RegExp[] = [
  /^https?:\/\/[^/]+\/api\//,
  /^https?:\/\/[^/]+\/__\//,
  /^https:\/\/(?:[^/]+\.)?googleapis\.com\//,
  /^https:\/\/(?:[^/]+\.)?(?:gstatic\.com\/recaptcha|recaptcha\.net|google\.com\/recaptcha)\//,
];

/**
 * Checks whether a navigation pathname must bypass the SPA offline index.html fallback.
 */
export function isNavigateFallbackDenied(pathname: string): boolean {
  return PWA_NAVIGATE_FALLBACK_DENYLIST.some(pattern => pattern.test(pathname));
}

/**
 * Checks whether a full request URL must remain NetworkOnly and never be served from SW cache.
 */
export function isNetworkOnlyUrl(urlString: string): boolean {
  return PWA_NETWORK_ONLY_PATTERNS.some(pattern => pattern.test(urlString));
}

export function createPwaManifest() {
  return {
    name: 'BlackOutBridge',
    short_name: 'BlackOutBridge',
    description: 'Offline-capable backup restaurant checkout and POS recovery bridge.',
    start_url: '/',
    scope: '/',
    display: 'standalone' as const,
    background_color: '#ffffff',
    theme_color: '#111827',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  };
}

export function createWorkboxConfig() {
  return {
    cacheId: PWA_CACHE_ID,
    cleanupOutdatedCaches: true,
    clientsClaim: true,
    skipWaiting: false,
    globPatterns: [...PWA_PRECACHE_GLOB_PATTERNS],
    navigateFallback: PWA_NAVIGATE_FALLBACK,
    navigateFallbackDenylist: [...PWA_NAVIGATE_FALLBACK_DENYLIST],
    runtimeCaching: PWA_NETWORK_ONLY_PATTERNS.map(urlPattern => ({
      urlPattern,
      handler: 'NetworkOnly' as const,
    })),
  };
}
