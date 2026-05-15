// ---------------------------------------------------------------------------
// HTTP(S) proxy bootstrap — make Node's global fetch route through HTTPS_PROXY
// ---------------------------------------------------------------------------
// Node 18+'s global fetch is built on undici but does NOT honor the
// HTTPS_PROXY / HTTP_PROXY / ALL_PROXY environment variables by default.
// Setting those env vars alone has no effect on outbound fetch calls — they
// still go direct.
//
// In networks behind a restrictive egress (corporate proxy, regional
// constraints, etc.), upstream API endpoints may only be reachable via a
// proxy. Without this bootstrap, dependency fetch calls would silently fail
// with ENOTFOUND or hang on connect timeout despite a "proxy" being set.
//
// What this does:
//   - Read HTTPS_PROXY (case-insensitive variants) at daemon start
//   - If present, install an undici ProxyAgent as the process-global
//     dispatcher so EVERY subsequent fetch() call (including inside
//     third-party packages that use native fetch) transparently routes
//     through the proxy
//   - NO_PROXY is honored as the standard comma-separated host list
//
// Failure policy: if undici can't be loaded or the proxy URL is malformed,
// log a loud warning and continue without proxy — better to limp along
// than crash the daemon.
// ---------------------------------------------------------------------------

import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { logger } from './logger.js';

/**
 * Initialize global fetch proxy from environment. Call once at daemon start.
 * Returns the proxy URL that was configured, or undefined if no proxy is set.
 */
export function initProxyFromEnv(): string | undefined {
  // Honor both lowercase and uppercase forms (some shells / launchd contexts
  // only carry one). Uppercase wins if both are set.
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;

  if (!proxyUrl) {
    logger.info('No proxy configured (HTTPS_PROXY / HTTP_PROXY / ALL_PROXY all unset)');
    return undefined;
  }

  try {
    const agent = new ProxyAgent({ uri: proxyUrl });
    setGlobalDispatcher(agent);
    logger.info('Global fetch proxy installed', {
      proxy: proxyUrl,
      noProxy: process.env.NO_PROXY || process.env.no_proxy || '(none)',
    });
    return proxyUrl;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to install proxy dispatcher; continuing without proxy', {
      proxy: proxyUrl,
      error: msg,
    });
    return undefined;
  }
}
