// Reverse proxy for giscus.app (minimal, plain JS)

// ---- optional: keep your widget "poweredBy" rewrite
const TARGET_WIDGET_PATH = "/en/widget";
const PATTERN_POWERED_BY =
  `"poweredBy":"– powered by \\u003ca\\u003egiscus\\u003c/a\\u003e"`;
const REPLACEMENT_POWERED_BY = `"poweredBy":""`;

// ---- CSS target
const CSS_PREFIX = "/_next/static/css/";
const CSS_SUFFIX = ".css";

// exact token in the minified CSS you pasted:
//   .gsc-upvote-button{font-weight:500}.gsc-upvote-button:disabled{...}
const PATTERN_UPVOTE_CSS_1 = `.gsc-upvote-button{font-weight:500}`;
const PATTERN_UPVOTE_CSS_2 = `.gsc-upvote-button{font-weight: 500}`; // just-in-case variant
const REPLACEMENT_UPVOTE_CSS = `.gsc-upvote-button{display:none !important}`;

// short TTL for dev
const CACHE_TTL_SECONDS = 300;

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const isWidget = url.pathname === TARGET_WIDGET_PATH;
    const isCss = url.pathname.startsWith(CSS_PREFIX) && url.pathname.endsWith(CSS_SUFFIX);

    // allow ad-hoc cache bypass while debugging
    const noCache = url.searchParams.has("nocache");

    // upstream url on giscus.app
    const upstreamURL = new URL(url.pathname + url.search, "https://giscus.app");

    const shouldCache = !noCache && (isWidget || isCss) && req.method === "GET";
    const cacheKey = new Request(upstreamURL.toString());

    if (shouldCache) {
      const hit = await caches.default.match(cacheKey);
      if (hit) return addDebug(hit, { Cache: "HIT", Widget: isWidget, Css: isCss });
    }

    // fetch upstream, keep body editable
    const fwd = new Headers(req.headers);
    fwd.set("accept-encoding", "identity");

    const upstream = await fetch(upstreamURL.toString(), {
      method: req.method,
      headers: fwd,
      body: (req.method === "GET" || req.method === "HEAD") ? undefined : await req.blob(),
    });

    const ct = upstream.headers.get("content-type") || "";
    const enc = upstream.headers.get("content-encoding") || "";
    const textLike = /json|text|javascript|css/i.test(ct);

    // pass-through if not our targets or not text-ish or encoded
    if ((!isWidget && !isCss) || !textLike || enc) {
      return addDebug(upstream, {
        Cache: "BYPASS",
        Reason: (!textLike ? "not-text" : (enc ? "encoded" : "not-target")),
      });
    }

    // read & rewrite
    let body = await upstream.text();
    let poweredByCount = 0;
    let cssUpvoteCount = 0;

    if (isWidget) {
      poweredByCount = count(body, PATTERN_POWERED_BY);
      if (poweredByCount) body = body.replaceAll(PATTERN_POWERED_BY, REPLACEMENT_POWERED_BY);
    }

    if (isCss) {
      // exact minified match first
      const c1 = count(body, PATTERN_UPVOTE_CSS_1);
      if (c1) {
        body = body.replaceAll(PATTERN_UPVOTE_CSS_1, REPLACEMENT_UPVOTE_CSS);
        cssUpvoteCount += c1;
      } else {
        // fallback with optional space after colon
        const c2 = count(body, PATTERN_UPVOTE_CSS_2);
        if (c2) {
          body = body.replaceAll(PATTERN_UPVOTE_CSS_2, REPLACEMENT_UPVOTE_CSS);
          cssUpvoteCount += c2;
        }
      }
    }

    // fix headers after mutation
    const out = new Headers(upstream.headers);
    out.delete("content-length");
    out.delete("content-encoding");
    out.set("cache-control", `public, max-age=0, s-maxage=${CACHE_TTL_SECONDS}`);

    const rewritten = new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });

    if (shouldCache) await caches.default.put(cacheKey, rewritten.clone());

    return addDebug(rewritten, {
      Cache: shouldCache ? "MISS_STORED" : "BYPASS",
      PoweredByRepl: poweredByCount,
      CssUpvoteRepl: cssUpvoteCount,
    });
  },
};

// --- helpers
function count(haystack, needle) {
  if (!needle) return 0;
  let c = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { c++; i += needle.length; }
  return c;
}
function addDebug(res, info) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(info)) h.set(`X-Debug-${k}`, String(v));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
