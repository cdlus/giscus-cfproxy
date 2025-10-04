// Minimal reverse proxy for giscus.app with simple logging

// 1) /en/widget → remove "powered by"
const TARGET_WIDGET_PATH = "/en/widget";
const PATTERN_POWERED_BY =
  `"poweredBy":"– powered by \\u003ca\\u003egiscus\\u003c/a\\u003e"`;
const REPLACEMENT_POWERED_BY = `"poweredBy":""`;

// 2) /_next/static/chunks/4947-*.js → hide the upvote button
const CHUNK_PREFIX = "/_next/static/chunks/4947-";
const CHUNK_SUFFIX = ".js";

// EXACT snippet from your pasted chunk (minified)
const PATTERN_UPVOTE =
  `className:"gsc-upvote-button gsc-social-reaction-summary-item "+(t.viewerHasUpvoted?"has-reacted":""),onClick:R,`;
// Inject a style prop to make it invisible
const REPLACEMENT_UPVOTE =
  `className:"gsc-upvote-button gsc-social-reaction-summary-item "+(t.viewerHasUpvoted?"has-reacted":""),style:{display:"none"},onClick:R,`;

// Optional edge cache for transformed bodies
const CACHE_TTL_SECONDS = 300;

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const isWidget = url.pathname === TARGET_WIDGET_PATH;
    const isTargetChunk =
      url.pathname.startsWith(CHUNK_PREFIX) && url.pathname.endsWith(CHUNK_SUFFIX);

    // Upstream URL on giscus.app
    const upstreamURL = new URL(url.pathname + url.search, "https://giscus.app");

    // Try cache only for GETs we rewrite
    const shouldCache = (isWidget || isTargetChunk) && req.method === "GET";
    const cacheKey = new Request(upstreamURL.toString());

    if (shouldCache) {
      const hit = await caches.default.match(cacheKey);
      if (hit) {
        // Minimal logging for cache hits
        console.log("[CACHE HIT]", url.pathname);
        return addDebugHeaders(hit, { cache: "HIT" });
      }
    }

    // Ensure upstream body is not compressed (so we can edit it)
    const fwdHeaders = new Headers(req.headers);
    fwdHeaders.set("accept-encoding", "identity");

    const upstream = await fetch(upstreamURL.toString(), {
      method: req.method,
      headers: fwdHeaders,
      body: (req.method === "GET" || req.method === "HEAD")
        ? undefined
        : await req.blob(),
    });

    const ct = upstream.headers.get("content-type") || "";
    const enc = upstream.headers.get("content-encoding") || "";

    // Minimal upstream log
    console.log("[UPSTREAM]", {
      path: url.pathname,
      status: upstream.status,
      ct, enc,
      widget: isWidget,
      chunk4947: isTargetChunk,
    });

    // Pass through if not our targets or body is not text-ish or is encoded
    const textLike = /json|text|javascript/i.test(ct);
    if ((!isWidget && !isTargetChunk) || !textLike || enc) {
      return addDebugHeaders(upstream, { cache: "BYPASS", reason: "no-rewrite" });
    }

    // Read, rewrite, and log counts
    let body = await upstream.text();
    let poweredByCount = 0;
    let upvoteCount = 0;

    if (isWidget) {
      poweredByCount = count(body, PATTERN_POWERED_BY);
      if (poweredByCount) body = body.replaceAll(PATTERN_POWERED_BY, REPLACEMENT_POWERED_BY);
    }

    if (isTargetChunk) {
      upvoteCount = count(body, PATTERN_UPVOTE);
      if (upvoteCount) body = body.replaceAll(PATTERN_UPVOTE, REPLACEMENT_UPVOTE);
    }

    console.log("[REWRITE]", {
      path: url.pathname,
      poweredByCount,
      upvoteCount,
    });

    // Update headers (length/encoding change)
    const outHeaders = new Headers(upstream.headers);
    outHeaders.delete("content-length");
    outHeaders.delete("content-encoding");
    outHeaders.set("cache-control", `public, max-age=0, s-maxage=${CACHE_TTL_SECONDS}`);

    const rewritten = new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });

    if (shouldCache) {
      await caches.default.put(cacheKey, rewritten.clone());
    }

    return addDebugHeaders(rewritten, {
      cache: shouldCache ? "MISS_STORED" : "BYPASS",
      poweredByCount,
      upvoteCount,
    });
  },
};

/** helpers */

function count(haystack: string, needle: string): number {
  let c = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    c++; i += needle.length;
  }
  return c;
}

function addDebugHeaders(res: Response, info: Record<string, unknown>): Response {
  const h = new Headers(res.headers);
  if (info.cache) h.set("X-Debug-Cache", String(info.cache));
  if (typeof info.poweredByCount === "number") h.set("X-Debug-PoweredBy", String(info.poweredByCount));
  if (typeof info.upvoteCount === "number") h.set("X-Debug-Upvote", String(info.upvoteCount));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
