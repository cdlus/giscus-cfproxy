// === WIDGET HTML REWRITE (poweredBy) ===
const TARGET_WIDGET_PATH = "/en/widget";
const PATTERN_POWERED_BY =
  `"poweredBy":"– powered by \\u003ca\\u003egiscus\\u003c/a\\u003e"`;
const REPLACEMENT_POWERED_BY = `"poweredBy":""`;

// === CHUNK REWRITE (append upvote-remover) ===
// Gate by path prefix+suffix so hash bumps don't break the rule
const CHUNK_PREFIX = "/_next/static/chunks/4947-";
const CHUNK_SUFFIX = ".js";

// JS injected at the end of the 4947 chunk. Runs inside the iframe.
// It removes the upvote button eagerly and on any subsequent renders.
const INJECT_UPVOTE_REMOVER =
  `;(()=>{try{const rm=()=>{document.querySelectorAll(".gsc-upvote-button").forEach((n)=>{const p=n.parentElement;n.remove();if(p&&p.classList&&p.classList.contains("gsc-comment-reactions")&&p.childElementCount===0){p.remove();}});};if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",rm);}else{rm();}const mo=new MutationObserver((muts)=>{for(const m of muts){for(const node of m.addedNodes||[]){if(node&&node.nodeType===1){if(node.matches&&node.matches(".gsc-upvote-button")){rm();return;}if(node.querySelector&&node.querySelector(".gsc-upvote-button")){rm();return;}}}}});mo.observe(document.documentElement,{subtree:true,childList:true});}catch(e){/* noop */}})();`;

// Optional CDN cache TTL (seconds) for transformed bodies
const CACHE_TTL_SECONDS = 300; // 5 minutes

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    const isWidget = url.pathname === TARGET_WIDGET_PATH;
    const isTargetChunk =
      url.pathname.startsWith(CHUNK_PREFIX) && url.pathname.endsWith(CHUNK_SUFFIX);

    // Build upstream URL
    const upstreamURL = new URL(url.pathname + url.search, "https://giscus.app");

    // Cache key mirrors the upstream URL for GETs we rewrite
    const cacheKey = new Request(upstreamURL.toString(), {
      method: "GET",
      headers: { "CF-Proxy-Rewrite": "1" }, // just to avoid accidental Vary collisions
    });

    // Try cache first for GETs we intend to rewrite
    if ((isWidget || isTargetChunk) && req.method === "GET") {
      const hit = await caches.default.match(cacheKey);
      if (hit) return hit;
    }

    // Proxy to giscus.app
    const headers = new Headers(req.headers);
    headers.set("accept-encoding", "identity"); // keep body editable

    const upstream = await fetch(upstreamURL.toString(), {
      method: req.method,
      headers,
      body:
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : await req.blob(),
    });

    // Quick pass-through if we’re not rewriting
    if (!isWidget && !isTargetChunk) {
      return upstream;
    }

    // Only rewrite textual/javascript responses that aren’t compressed
    const ct = upstream.headers.get("content-type") || "";
    const enc = upstream.headers.get("content-encoding") || "";
    const isTextLike = /json|text|javascript/i.test(ct);
    if (!isTextLike || enc) {
      return upstream;
    }

    // === REWRITE LOGIC ===
    let bodyText: string;
    try {
      bodyText = await upstream.text();
    } catch {
      // If body can't be read as text, pass through
      return upstream;
    }

    if (isWidget) {
      // Exact-string replacement, as in your original worker
      bodyText = bodyText.replaceAll(PATTERN_POWERED_BY, REPLACEMENT_POWERED_BY);
    }

    if (isTargetChunk) {
      // Append the upvote remover at the end (before any sourceMappingURL works too)
      // If you prefer to insert before a source map comment, do it like:
      // bodyText = bodyText.replace(/\/\/# sourceMappingURL=.*$/m, INJECT_UPVOTE_REMOVER + "\n$&");
      bodyText += INJECT_UPVOTE_REMOVER;
    }

    // Fix headers for transformed body
    const outHeaders = new Headers(upstream.headers);
    outHeaders.delete("content-length");
    outHeaders.delete("content-encoding");
    outHeaders.set("cache-control", `public, max-age=0, s-maxage=${CACHE_TTL_SECONDS}`);

    const rewritten = new Response(bodyText, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });

    // Store transformed GETs in Cloudflare cache
    if ((isWidget || isTargetChunk) && req.method === "GET") {
      await caches.default.put(cacheKey, rewritten.clone());
    }

    return rewritten;
  },
};
