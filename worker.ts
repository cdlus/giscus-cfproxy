const CSS_PREFIX = "/_next/static/css/";
const CSS_SUFFIX = ".css";

// Append to all CSS so it always wins in cascade order
const INJECT_CSS =
  "\n/* giscus proxy override */\n" +
  ".gsc-upvote-button{display:none!important}\n" +
  ".gsc-upvotes{display:none!important}\n";

// Optional: keep your widget poweredBy rewrite
const TARGET_WIDGET_PATH = "/en/widget";
const PATTERN_POWERED_BY =
  `"poweredBy":"– powered by \\u003ca\\u003egiscus\\u003c/a\\u003e"`;
const REPLACEMENT_POWERED_BY = `"poweredBy":""`;

// Short TTL while developing
const CACHE_TTL_SECONDS = 300;

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const isCss = url.pathname.startsWith(CSS_PREFIX) && url.pathname.endsWith(CSS_SUFFIX);
    const isWidget = url.pathname === TARGET_WIDGET_PATH;
    const noCache = url.searchParams.has("nocache");

    // Proxy target on giscus.app
    const upstreamURL = new URL(url.pathname + url.search, "https://giscus.app");
    const cacheKey = new Request(upstreamURL.toString());

    // Quick purge hook (per colo)
    if (url.searchParams.has("purge") && req.method === "GET") {
      const ok = await caches.default.delete(cacheKey);
      return new Response("purged:" + ok, {
        headers: { "X-Debug-Purged": String(ok) },
      });
    }

    // Only cache widget; don't cache CSS while iterating
    const shouldCache = !noCache && isWidget && req.method === "GET";
    if (shouldCache) {
      const hit = await caches.default.match(cacheKey);
      if (hit) return addDebug(hit, { Cache: "HIT", Css: false, Widget: true });
    }

    // Keep body editable; DO NOT auto-follow redirects
    const h = new Headers(req.headers);
    h.set("accept-encoding", "identity");

    const upstream = await fetch(upstreamURL.toString(), {
      method: req.method,
      headers: h,
      body: (req.method === "GET" || req.method === "HEAD") ? undefined : await req.blob(),
      redirect: "manual", // <- key: forward 3xx instead of following
    });

    // If upstream responds with a redirect, forward it as-is
    if (upstream.status >= 300 && upstream.status < 400) {
      const loc = upstream.headers.get("location");
      if (loc) {
        // Make sure Location is absolute
        const absolute = new URL(loc, upstreamURL).toString();
        const out = new Headers();
        out.set("Location", absolute);
        out.set("Cache-Control", "no-store");
        out.set("X-Debug-Redirect", "forwarded");
        out.set("X-Debug-Location", absolute);
        return new Response(null, { status: upstream.status, headers: out });
      }
      // No Location? Just forward the status with no body
      return new Response(null, {
        status: upstream.status,
        headers: { "Cache-Control": "no-store", "X-Debug-Redirect": "no-location" },
      });
    }

    // Non-redirects continue below
    const ct = upstream.headers.get("content-type") || "";
    const enc = upstream.headers.get("content-encoding") || "";

    if (!/text|json|javascript|css/i.test(ct) || enc) {
      return addDebug(upstream, {
        Cache: "BYPASS",
        Reason: enc ? "encoded" : "not-text",
      });
    }

    let body = await upstream.text();
    let poweredByCount = 0;
    let appended = 0;

    // Optional widget tweak
    if (isWidget) {
      const before = body;
      body = body.replaceAll(PATTERN_POWERED_BY, REPLACEMENT_POWERED_BY);
      poweredByCount = before === body ? 0 : 1;
    }

    // Append our override to any CSS file so it always wins
    if (isCss && !body.includes(".gsc-upvote-button{display:none")) {
      body += INJECT_CSS;
      appended = 1;
    }

    // Fix headers
    const out = new Headers(upstream.headers);
    out.delete("content-length");
    out.delete("content-encoding");
    out.set(
      "cache-control",
      isCss ? "no-store" : `public, max-age=0, s-maxage=${CACHE_TTL_SECONDS}`
    );

    const rewritten = new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });

    if (shouldCache) await caches.default.put(cacheKey, rewritten.clone());

    return addDebug(rewritten, {
      Cache: shouldCache ? "MISS_STORED" : (isCss ? "NO_STORE" : "BYPASS"),
      CssAppended: appended,
      PoweredByRepl: poweredByCount,
    });
  },
};

function addDebug(res, info) {
  const h = new Headers(res.headers);
  Object.entries(info).forEach(([k, v]) => h.set(`X-Debug-${k}`, String(v)));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
