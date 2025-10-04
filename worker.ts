/**
 * Reverse proxy for giscus.app with:
 * - /en/widget "powered by" removal
 * - /_next/static/chunks/4947-*.js upvote-hiding/removal
 * - Verbose logging & debug headers when __debug=1 is in the query
 */

const TARGET_WIDGET_PATH = "/en/widget";
const PATTERN_POWERED_BY =
  `"poweredBy":"– powered by \\u003ca\\u003egiscus\\u003c/a\\u003e"`;
const REPLACEMENT_POWERED_BY = `"poweredBy":""`;

// Next.js chunk family (hash changes over time)
const CHUNK_PREFIX = "/_next/static/chunks/4947-";
const CHUNK_SUFFIX = ".js";

// STRATEGY 1: exact minified snippet (from your pasted chunk)
const PATTERN_UPVOTE_1 =
  `className:"gsc-upvote-button gsc-social-reaction-summary-item "+(t.viewerHasUpvoted?"has-reacted":""),onClick:R,`;
const REPLACEMENT_UPVOTE_1 =
  `className:"gsc-upvote-button gsc-social-reaction-summary-item "+(t.viewerHasUpvoted?"has-reacted":""),style:{display:"none"},onClick:R,`;

// STRATEGY 2: softer class rewrite (works even if prop order changes)
const PATTERN_UPVOTE_2 = `"gsc-upvote-button gsc-social-reaction-summary-item"`;
const REPLACEMENT_UPVOTE_2 = `"gsc-upvote-button-hidden"`;

// Edge cache TTL for transformed bodies
const CACHE_TTL_SECONDS = 300;

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const debug = url.searchParams.get("__debug") === "1";

    const isWidget = url.pathname === TARGET_WIDGET_PATH;
    const isTargetChunk =
      url.pathname.startsWith(CHUNK_PREFIX) && url.pathname.endsWith(CHUNK_SUFFIX);

    // Proxy upstream
    const upstreamURL = new URL(url.pathname + url.search, "https://giscus.app");

    // Cache only rewritten GETs (unless debug)
    const shouldTryCache = !debug && (isWidget || isTargetChunk) && req.method === "GET";
    const cacheKey = new Request(upstreamURL.toString());

    if (shouldTryCache) {
      const hit = await caches.default.match(cacheKey);
      if (hit) {
        if (debug) {
          console.log("[CACHE HIT]", {
            path: url.pathname,
            isWidget,
            isTargetChunk,
            upstream: upstreamURL.toString(),
          });
        }
        return withDebugHeaders(hit, {
          debug,
          cache: "HIT",
          isWidget,
          isTargetChunk,
          note: "served from cache",
        });
      }
    }

    // Ensure body is editable
    const fwdHeaders = new Headers(req.headers);
    fwdHeaders.set("accept-encoding", "identity");

    const upstream = await fetch(upstreamURL.toString(), {
      method: req.method,
      headers: fwdHeaders,
      body:
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : await req.blob(),
    });

    const ct = upstream.headers.get("content-type") || "";
    const enc = upstream.headers.get("content-encoding") || "";
    const textLike = /json|text|javascript/i.test(ct);

    if (debug) {
      console.log("[UPSTREAM]", {
        method: req.method,
        path: url.pathname,
        query: url.search,
        upstream: upstreamURL.toString(),
        status: upstream.status,
        contentType: ct,
        contentEncoding: enc,
        wantsRewrite: isWidget || isTargetChunk,
        textLike,
      });
    }

    // Not our target or not text-ish or compressed → pass through
    if ((!isWidget && !isTargetChunk) || !textLike || enc) {
      if (debug) {
        console.log("[PASS THROUGH]", {
          reason: (!isWidget && !isTargetChunk) ? "not a target path" : (!textLike ? "not text-like" : "encoded"),
        });
      }
      return withDebugHeaders(upstream, {
        debug,
        cache: "BYPASS",
        isWidget,
        isTargetChunk,
        encoded: !!enc,
        textLike,
      });
    }

    // Read as text and attempt rewrites
    let body: string;
    try {
      body = await upstream.text();
    } catch (err) {
      if (debug) console.log("[READ FAIL] switching to passthrough", { err: String(err) });
      return withDebugHeaders(upstream, {
        debug,
        cache: "BYPASS",
        isWidget,
        isTargetChunk,
        note: "failed to read text()",
      });
    }

    const beforeLen = body.length;

    // Track matches & actions for debugging
    const diag: Record<string, unknown> = {
      isWidget,
      isTargetChunk,
      beforeLen,
      poweredByReplCount: 0,
      upvoteStrategy1Matches: 0,
      upvoteStrategy2Matches: 0,
      removedViaStrategy3: false,
    };

    if (isWidget) {
      const c1 = countMatches(body, PATTERN_POWERED_BY);
      body = body.replaceAll(PATTERN_POWERED_BY, REPLACEMENT_POWERED_BY);
      diag.poweredByReplCount = c1;
    }

    if (isTargetChunk) {
      // Strategy 1: precise injection of style prop
      const c1 = countMatches(body, PATTERN_UPVOTE_1);
      if (c1 > 0) {
        body = body.replaceAll(PATTERN_UPVOTE_1, REPLACEMENT_UPVOTE_1);
        diag.upvoteStrategy1Matches = c1;
      } else {
        // Strategy 2: rewrite the class string to a hidden one
        const c2 = countMatches(body, PATTERN_UPVOTE_2);
        if (c2 > 0) {
          body = body.replaceAll(PATTERN_UPVOTE_2, REPLACEMENT_UPVOTE_2);
          diag.upvoteStrategy2Matches = c2;
        } else {
          // Strategy 3 (fallback): remove the entire button object literal
          const removed = removeUpvoteButtonObjectLiteral(body, debug);
          if (removed) {
            body = removed;
            diag.removedViaStrategy3 = true;
          }
        }
      }
    }

    const afterLen = body.length;
    diag["afterLen"] = afterLen;

    if (debug) {
      console.log("[REWRITE SUMMARY]", {
        path: url.pathname,
        ...diag,
      });
    }

    // Fix headers for transformed body
    const outHeaders = new Headers(upstream.headers);
    outHeaders.delete("content-length");
    outHeaders.delete("content-encoding");
    outHeaders.set(
      "cache-control",
      debug ? "no-store" : `public, max-age=0, s-maxage=${CACHE_TTL_SECONDS}`
    );

    const rewritten = new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });

    if (!debug && (isWidget || isTargetChunk) && req.method === "GET") {
      await caches.default.put(cacheKey, rewritten.clone());
      if (debug) console.log("[CACHE PUT]", { key: upstreamURL.toString() });
    }

    return withDebugHeaders(rewritten, {
      debug,
      cache: shouldTryCache ? "MISS_STORED" : "BYPASS",
      ...diag,
    });
  },
};

/** Helpers */

function countMatches(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0, idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function withDebugHeaders(res: Response, info: Record<string, unknown>): Response {
  if (!info.debug) return res;

  const h = new Headers(res.headers);
  h.set("X-Debug-Cache", String(info.cache ?? ""));
  h.set("X-Debug-Widget", String(!!info.isWidget));
  h.set("X-Debug-Chunk4947", String(!!info.isTargetChunk));
  if (typeof info.poweredByReplCount === "number")
    h.set("X-Debug-PoweredBy-Repl", String(info.poweredByReplCount));
  if (typeof info.upvoteStrategy1Matches === "number")
    h.set("X-Debug-Upvote-S1", String(info.upvoteStrategy1Matches));
  if (typeof info.upvoteStrategy2Matches === "number")
    h.set("X-Debug-Upvote-S2", String(info.upvoteStrategy2Matches));
  if (typeof info.removedViaStrategy3 === "boolean")
    h.set("X-Debug-Upvote-S3", info.removedViaStrategy3 ? "1" : "0");
  if (typeof info.beforeLen === "number" && typeof info.afterLen === "number")
    h.set("X-Debug-BodyLens", `${info.beforeLen}->${info.afterLen}`);

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: h,
  });
}

/**
 * Strategy 3 fallback:
 * Remove the entire upvote <button> object literal by scanning
 * for the minified call pattern and balancing braces.
 * This is intentionally conservative; it only runs if S1/S2 both miss.
 */
function removeUpvoteButtonObjectLiteral(body: string, debug: boolean): string | null {
  const anchor =
    `,(0,o.BX)("button",{type:"button",className:"gsc-upvote-button gsc-social-reaction-summary-item "`;

  const startIdx = body.indexOf(anchor);
  if (startIdx === -1) {
    if (debug) console.log("[S3] anchor not found");
    return null;
  }

  // Find the opening brace of the object literal after the anchor
  const objStart = body.indexOf("{", startIdx);
  if (objStart === -1) {
    if (debug) console.log("[S3] opening brace not found");
    return null;
  }

  // Balance braces to locate the matching closing brace
  let depth = 0;
  let i = objStart;
  for (; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        // i is the closing brace of the object literal
        break;
      }
    }
  }
  if (depth !== 0) {
    if (debug) console.log("[S3] brace scan failed");
    return null;
  }

  // The call looks like: ,(0,o.BX)("button",{...})  → remove from the comma before call to the closing paren
  let callEnd = i + 1; // end of object
  // consume possible trailing ), and children array, then the closing ) of BX call
  // we’ll remove until the first ')' after object that closes the BX call
  while (callEnd < body.length && body[callEnd] !== ")") callEnd++;
  if (callEnd < body.length) callEnd++; // include the ')'

  const removalStart = startIdx; // includes leading comma
  const removalEnd = callEnd;

  const before = body.slice(0, removalStart);
  const after = body.slice(removalEnd);

  if (debug) {
    console.log("[S3] removing range", {
      removalStart,
      removalEnd,
      removedLen: removalEnd - removalStart,
      previewStart: body.slice(Math.max(0, removalStart - 60), removalStart),
      previewEnd: body.slice(removalEnd, Math.min(body.length, removalEnd + 60)),
    });
  }

  return before + after;
}
