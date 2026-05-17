// ---------------------------------------------------------------------------
// HTTP(S) proxy bootstrap — selective, per-host fetch proxying
// ---------------------------------------------------------------------------
// Node 18+'s global fetch is built on undici but does NOT honor the
// HTTPS_PROXY / HTTP_PROXY / ALL_PROXY environment variables by default.
// Setting those env vars alone has no effect on outbound fetch calls.
//
// This daemon talks to exactly two classes of host:
//   - WeChat ilink + CDN  (*.weixin.qq.com)  — must be reached DIRECT.
//     This is a China-side endpoint; routing it through an overseas proxy
//     adds latency and, worse, couples WeChat liveness to proxy liveness.
//     (A stale proxy port silently killed the WeChat poll loop once — the
//     bridge appeared "running" while every getupdates fetch failed.)
//   - Claude / Anthropic API — typically only reachable VIA the proxy from
//     the same network, so it MUST go through HTTPS_PROXY.
//
// So we do NOT install a blanket global proxy. Instead we use undici's
// EnvHttpProxyAgent, which routes per-host according to HTTPS_PROXY /
// HTTP_PROXY and natively honors NO_PROXY. We force the WeChat domain into
// NO_PROXY in-process so WeChat is always direct regardless of how the
// operator configured their environment — everything else (Claude) still
// flows through the proxy.
//
// Failure policy: if undici can't be loaded or the proxy URL is malformed,
// log a loud warning and continue without proxy — better to limp along
// than crash the daemon.
// ---------------------------------------------------------------------------

import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { logger } from './logger.js';

// Hosts that must NEVER go through the proxy. undici's NO_PROXY matching
// treats a bare domain as covering its subdomains (host ending in
// "." + entry), so "weixin.qq.com" also bypasses "ilinkai.weixin.qq.com"
// and "novac2c.cdn.weixin.qq.com".
const FORCED_NO_PROXY = ['weixin.qq.com', 'wechat.com'];

/**
 * Initialize selective fetch proxying from environment. Call once at daemon
 * start, before any fetch() happens. Returns the proxy URL that will be used
 * for proxied hosts, or undefined if no proxy is configured.
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

  // Merge our forced bypass list into NO_PROXY (dedup, preserve operator
  // entries). EnvHttpProxyAgent reads NO_PROXY at construction time, so this
  // must happen before `new EnvHttpProxyAgent()`.
  const existingNoProxy = process.env.NO_PROXY || process.env.no_proxy || '';
  const merged = new Set(
    existingNoProxy
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  for (const h of FORCED_NO_PROXY) merged.add(h);
  const noProxy = Array.from(merged).join(',');
  process.env.NO_PROXY = noProxy;
  process.env.no_proxy = noProxy;
  // ALL_PROXY would override the per-host NO_PROXY logic in EnvHttpProxyAgent,
  // so drop it — HTTPS_PROXY/HTTP_PROXY carry the same value here anyway.
  delete process.env.ALL_PROXY;
  delete process.env.all_proxy;

  try {
    const agent = new EnvHttpProxyAgent();
    setGlobalDispatcher(agent);
    logger.info('Selective fetch proxy installed', {
      proxy: proxyUrl,
      noProxy,
      note: 'WeChat (*.weixin.qq.com) is direct; other hosts (Claude) via proxy',
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
