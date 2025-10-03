// Only rewrite this exact path
const TARGET_PATH = "/en/widget";

// Only this no-space pattern
const PATTERN = `"poweredBy":"– powered by \\u003ca\\u003egiscus\\u003c/a\\u003e"`;
const REPLACEMENT = `"poweredBy":""`;

// Optional CDN cache TTL (seconds) for the transformed body
const CACHE_TTL_SECONDS = 300; // 5 minutes

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Gate by path
    const shouldRewrite = (url.pathname === TARGET_PATH);

    // Cache key (same path+query on giscus.app)
    const cacheKey = new Request(`https://giscus.app${url.pathname}${url.search}`);

    // Try cache first (only for GET and when we rewrite)
    if (shouldRewrite && req.method === "GET") {
      const hit = await caches.default.match(cacheKey);
      if (hit) return hit;
    }

    // Proxy to giscus.app
    const upstreamURL = new URL(url.pathname + url.search, "https://giscus.app");
    const headers = new Headers(req.headers);
    headers.set("accept-encoding", "identity"); // keep body editable

    const upstream = await fetch(upstreamURL.toString(), {
      method: req.method,
      headers,
      body: (req.method === "GET" || req.method === "HEAD") ? undefined : await req.blob(),
    });

    // If we’re not rewriting or it’s not text-ish (or compressed), just pass through.
    const ct = upstream.headers.get("content-type") || "";
    const enc = upstream.headers.get("content-encoding") || "";
    const textLike = /json|text|javascript/i.test(ct);

    if (!shouldRewrite || !textLike || enc) {
      return upstream;
    }

    // Streaming replace with tiny tail buffer so we don’t miss boundary matches
    const dec = new TextDecoder();
    const encdr = new TextEncoder();
    const keep = PATTERN.length - 1;
    let tail = "";

    const ts = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const s = tail + dec.decode(chunk, { stream: true });
        const safe = Math.max(0, s.length - keep);
        const head = s.slice(0, safe);
        tail = s.slice(safe);
        controller.enqueue(encdr.encode(head.replaceAll(PATTERN, REPLACEMENT)));
      },
      flush(controller) {
        if (tail) controller.enqueue(encdr.encode(tail.replaceAll(PATTERN, REPLACEMENT)));
      },
    });

    // Fix headers for transformed body
    const outHeaders = new Headers(upstream.headers);
    outHeaders.delete("content-length");
    outHeaders.delete("content-encoding");
    // Optional cache hints for browsers/other CDNs
    outHeaders.set("cache-control", `public, max-age=0, s-maxage=${CACHE_TTL_SECONDS}`);

    upstream.body!.pipeThrough(ts);
    const rewritten = new Response(ts.readable, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });

    // Store the transformed response in Cloudflare cache
    if (req.method === "GET") {
      await caches.default.put(cacheKey, rewritten.clone());
    }

    return rewritten;
  },
};
