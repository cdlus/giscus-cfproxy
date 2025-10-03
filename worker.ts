// worker.ts
export default {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      // forward to giscus.app (same path & query)
      const upstream = new URL(url.pathname + url.search, "https://giscus.app");
  
      // clone headers and prefer identity encoding so we can rewrite
      const h = new Headers(req.headers);
      h.set("accept-encoding", "identity");
  
      const res = await fetch(upstream.toString(), { method: req.method, headers: h });
  
      const ct = res.headers.get("content-type") || "";
      const enc = res.headers.get("content-encoding") || "";
  
      // pass-through if not text-ish or is encoded
      const textLike = /json|text|javascript/i.test(ct);
      if (!textLike || enc) return res;
  
      // remove length/encoding; we will stream a modified body
      const outHeaders = new Headers(res.headers);
      outHeaders.delete("content-length");
      outHeaders.delete("content-encoding");
  
      // streaming text transform with tiny tail buffer
      const patNoSpace = `"poweredBy":"– powered by \\u003ca\\u003egiscus\\u003c/a\\u003e"`;
      const patSpace   = `"poweredBy": "– powered by \\u003ca\\u003egiscus\\u003c/a\\u003e"`;
      const replacement = `"poweredBy":""`;
  
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const keep = Math.max(patNoSpace.length, patSpace.length) - 1;
      let tail = "";
  
      const ts = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          let s = tail + decoder.decode(chunk, { stream: true });
  
          // keep a tail so patterns spanning chunk boundary are caught
          const safeLen = Math.max(0, s.length - keep);
          const head = s.slice(0, safeLen);
          tail = s.slice(safeLen);
  
          const replaced = head
            .replaceAll(patNoSpace, replacement)
            .replaceAll(patSpace, replacement);
  
          controller.enqueue(encoder.encode(replaced));
        },
        flush(controller) {
          if (tail) {
            const replaced = tail
              .replaceAll(patNoSpace, replacement)
              .replaceAll(patSpace, replacement);
            controller.enqueue(encoder.encode(replaced));
          }
        },
      });
  
      res.body!.pipeThrough(ts);
  
      return new Response(ts.readable, {
        status: res.status,
        statusText: res.statusText,
        headers: outHeaders,
      });
    },
  };
  