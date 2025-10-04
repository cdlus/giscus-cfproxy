/**
 * Reverse proxy for giscus.app with two rewrites:
 * 1) /en/widget → remove "powered by" text
 * 2) /_next/static/chunks/4947-*.js → hide the upvote button inside the iframe
 */

const TARGET_WIDGET_PATH = "/en/widget";
const PATTERN_POWERED_BY =
  `"poweredBy":"– powered by \\u003ca\\u003egiscus\\u003c/a\\u003e"`;
const REPLACEMENT_POWERED_BY = `"poweredBy":""`;

// Match this exact file family (hash changes over time)
const CHUNK_PREFIX = "/_next/static/chunks/4947-";
const CHUNK_SUFFIX = ".js";

// EXACT substring from the chunk you pasted (minified code)
const PATTERN_UPVOTE = `className:"gsc-upvote-button gsc-social-reaction-summary-item "+(t.viewerHasUpvoted?"has-reacted":""),onClick:R,`;

// Inject a style prop right after className → makes it invisible, no CSS needed
const REPLACEMENT_UPVOTE = `className:"gsc-upvote-button gsc-social-reaction-summary-item "+(t.viewerHasUpvoted?"has-reacted":""),style:{display:"none"},onClick:R,`;

// Edge cache TTL for transformed bodies
const CACHE_TTL_SECONDS = 300;

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const isWidget = url.pathname === TARGET_WIDGET_PATH;
    const isTargetChunk =
      url.pathname.startsWith(CHUNK_PREFIX) && url.pathname.endsWith(CHUNK_SUFFIX);

    // Proxy upstream
    const upstreamURL = new URL(url.pathname + url.search, "https://giscus.app");

    // Cache only rewritten GETs
    const shouldTryCache = (isWidget || isTargetChunk) && req.method === "GET";
    const cacheKey = new Request(upstreamURL.toString());

    if (shouldTryCache) {
      const hit = await caches.default.match(cacheKey);
      if (hit) return hit;
    }

    // Ensure body is editable
    const headers = new Headers(req.headers);
    headers.set("accept-encoding", "identity");

    const upstream = await fetch(upstreamURL.toString(), {
      method: req.method,
      headers,
      body:
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : await req.blob(),
    });

    // If not our target or not text/JS (or compressed), pass through
    const ct = upstream.headers.get("content-type") || "";
    const enc = upstream.headers.get("content-encoding") || "";
    const textLike = /json|text|javascript/i.test(ct);

    if ((!isWidget && !isTargetChunk) || !textLike || enc) {
      return upstream;
    }

    // Read as text; do precise replacements
    let body = await upstream.text();

    if (isWidget) {
      body = body.replaceAll(PATTERN_POWERED_BY, REPLACEMENT_POWERED_BY);
    }

    if (isTargetChunk) {
      // Insert style:{display:"none"} into the upvote button props
      body = body.replaceAll(PATTERN_UPVOTE, REPLACEMENT_UPVOTE);
    }

    // Fix headers for transformed body
    const outHeaders = new Headers(upstream.headers);
    outHeaders.delete("content-length");
    outHeaders.delete("content-encoding");
    outHeaders.set("cache-control", `public, max-age=0, s-maxage=${CACHE_TTL_SECONDS}`);

    const rewritten = new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });

    if (shouldTryCache) {
      await caches.default.put(cacheKey, rewritten.clone());
    }

    return rewritten;
  },
};
