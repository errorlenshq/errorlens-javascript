/** The global fetch (undici): spans, breadcrumbs and traceparent on outgoing requests. */
import { active, isOwnUrl, shouldPropagate, stripQuery } from "./util.js";

const PATCHED = Symbol.for("errorlens.patched");

export function instrumentFetch(): void {
  const orig = globalThis.fetch as typeof fetch & { [PATCHED]?: boolean };
  if (!orig || orig[PATCHED]) return;
  const wrapped = function (input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const c = active();
    if (!c) return orig(input, init);
    const isReq = typeof Request !== "undefined" && input instanceof Request;
    const url = isReq ? (input as Request).url : String(input);
    if (isOwnUrl(c, url)) return orig(input, init);
    const method = String(init?.method || (isReq ? (input as Request).method : "GET")).toUpperCase();
    const clean = stripQuery(url);
    const span = c.activeSpan()?.startChild("http.client", `${method} ${clean}`);
    span?.setData("http.request.method", method).setData("url.full", clean);
    if (shouldPropagate(c, url)) {
      const headers = new Headers(init?.headers || (isReq ? (input as Request).headers : undefined));
      if (!headers.has("traceparent")) {
        const h = span ? { traceparent: span.traceparent() } : c.propagationHeaders();
        for (const [k, v] of Object.entries(h)) headers.set(k, v);
        init = { ...init, headers };
      }
    }
    const start = Date.now();
    const crumb = (status?: number, error?: unknown) => c.addBreadcrumb({
      type: "http", category: "fetch", level: error || (status ?? 0) >= 500 ? "error" : (status ?? 0) >= 400 ? "warning" : "info",
      data: { method, url: clean, status_code: status, duration_ms: Date.now() - start, ...(error ? { error: String((error as Error)?.message || error) } : {}) },
    });
    return orig(input, init).then(
      (res) => { span?.setHttpStatus(res.status); span?.end(); crumb(res.status); return res; },
      (err) => { span?.setStatus("internal_error"); span?.end(); crumb(undefined, err); throw err; },
    );
  } as typeof fetch & { [PATCHED]?: boolean };
  wrapped[PATCHED] = true;
  globalThis.fetch = wrapped;
}
