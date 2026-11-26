/** Browser integrations: global error handlers and breadcrumbs, tracing headers, page-load timing. */
import { getClient, matches, now, parseTraceparent, type Client, type Level } from "@errorlenshq/core";

const PATCHED = "__errorlens_patched__";
const active = (): Client | undefined => { const c = getClient(); return c?.active ? c : undefined; };

function stripQuery(url: string): string {
  const i = url.search(/[?#]/);
  return i === -1 ? url : url.slice(0, i);
}

function isOwnUrl(c: Client, url: string): boolean {
  try { return !!c.dsn && new URL(url, location.href).host === c.dsn.host; } catch { return false; }
}

/** Default: only same-origin requests get traceparent (other origins would need it in their CORS allow list). */
function shouldPropagate(c: Client, url: string): boolean {
  const targets = c.options.tracePropagationTargets;
  if (targets) return matches(url, targets);
  try { return new URL(url, location.href).origin === location.origin; } catch { return false; }
}

// ------------------------------------------------------------------ global handlers

export function instrumentGlobalHandlers(): void {
  addEventListener("error", (ev: ErrorEvent) => {
    const c = active();
    if (!c) return;
    const err = ev.error;
    if (err instanceof Error) {
      c.captureException(err, {}, { type: "onerror", handled: false });
      return;
    }
    // Cross-origin script errors carry no details; they are noise.
    if (!ev.message || ev.message === "Script error." || ev.message === "Script error") return;
    c.captureEvent({
      level: "error",
      exception: { values: [{
        type: "Error", value: ev.message, mechanism: { type: "onerror", handled: false },
        stacktrace: ev.filename ? { frames: [{ filename: ev.filename, abs_path: ev.filename, lineno: ev.lineno, colno: ev.colno, in_app: true, function: "?" }] } : undefined,
      }] },
    }, { originalException: err });
  });
  addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
    const c = active();
    if (!c) return;
    let reason: unknown = ev.reason;
    // Some libraries wrap the rejection reason: CustomEvent.detail.reason
    const detail = (ev as unknown as { detail?: { reason?: unknown } }).detail;
    if (reason === undefined && detail?.reason !== undefined) reason = detail.reason;
    if (reason instanceof Error) {
      c.captureException(reason, {}, { type: "onunhandledrejection", handled: false });
    } else {
      const text = typeof reason === "object" && reason !== null ? JSON.stringify(reason)?.slice(0, 2000) : String(reason);
      c.captureEvent({ level: "error", exception: { values: [{ type: "UnhandledRejection",
        value: `Non-Error promise rejection captured with value: ${text}`, mechanism: { type: "onunhandledrejection", handled: false } }] } },
        { originalException: reason });
    }
  });
}

// ------------------------------------------------------------------ breadcrumbs

function describeElement(el: Element | null): string {
  if (!el || !el.tagName) return "";
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let i = 0; cur && i < 5 && cur.tagName !== "HTML"; i++, cur = cur.parentElement) {
    let s = cur.tagName.toLowerCase();
    if (cur.id) s += `#${cur.id}`;
    const cls = typeof cur.className === "string" ? cur.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
    if (cls.length) s += `.${cls.join(".")}`;
    for (const a of ["name", "type", "role", "aria-label", "data-testid"]) {
      const v = cur.getAttribute(a);
      if (v) s += `[${a}="${v.slice(0, 40)}"]`;
    }
    parts.unshift(s);
    if (cur.id) break;
  }
  return parts.join(" > ");
}

export function instrumentDom(): void {
  let last: { target: EventTarget | null; type: string; at: number } | undefined;
  const handler = (ev: Event) => {
    const c = active();
    if (!c) return;
    const t = Date.now();
    // Typing produces one crumb per burst, not per key; double events are merged.
    if (last && last.target === ev.target && last.type === ev.type && t - last.at < 1000) { last.at = t; return; }
    last = { target: ev.target, type: ev.type, at: t };
    const target = describeElement(ev.target as Element);
    if (target) c.addBreadcrumb({ category: `ui.${ev.type === "keypress" ? "input" : "click"}`, message: target });
  };
  addEventListener("click", handler, { capture: true, passive: true });
  addEventListener("keypress", handler, { capture: true, passive: true });
}

export function instrumentHistory(onNavigate?: (from: string, to: string) => void): void {
  let lastUrl = location.href;
  const record = (to: string | URL | null | undefined) => {
    if (to === undefined || to === null) return;
    const from = lastUrl;
    const next = new URL(String(to), location.href).href;
    lastUrl = next;
    if (from === next) return;
    active()?.addBreadcrumb({ category: "navigation", data: { from: stripQuery(from), to: stripQuery(next) } });
    onNavigate?.(from, next);
  };
  for (const method of ["pushState", "replaceState"] as const) {
    const orig = history[method] as History["pushState"] & { [PATCHED]?: boolean };
    if (orig[PATCHED]) continue;
    const wrapped = function (this: History, data: unknown, unused: string, url?: string | URL | null) {
      const r = orig.call(this, data, unused, url);
      try { record(url); } catch { /* never break navigation */ }
      return r;
    } as History["pushState"] & { [PATCHED]?: boolean };
    wrapped[PATCHED] = true;
    history[method] = wrapped;
  }
  addEventListener("popstate", () => record(location.href));
}

const CONSOLE_LEVELS: [string, Level][] = [["debug", "debug"], ["log", "info"], ["info", "info"], ["warn", "warning"], ["error", "error"]];

function format(args: unknown[]): string {
  return args.map((a) => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(" ").slice(0, 2048);
}

export function instrumentConsole(sendLogs: boolean): void {
  const con = console as unknown as Record<string, ((...a: unknown[]) => void) & { [PATCHED]?: boolean }>;
  let inside = false;
  for (const [method, level] of CONSOLE_LEVELS) {
    const orig = con[method];
    if (typeof orig !== "function" || orig[PATCHED]) continue;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const c = active();
      if (c && !inside) {
        inside = true;
        try {
          const message = format(args);
          c.addBreadcrumb({ category: "console", level, message });
          if (sendLogs) c.captureLog(level === "warning" ? "warn" : level === "info" ? "info" : level, message, { "logger.name": "console" });
        } catch { /* never break console */ } finally { inside = false; }
      }
      return orig.apply(this, args);
    } as typeof orig;
    wrapped[PATCHED] = true;
    con[method] = wrapped;
  }
}

// ------------------------------------------------------------------ network

function httpCrumb(c: Client, category: string, method: string, url: string, start: number, status?: number, error?: unknown) {
  c.addBreadcrumb({
    type: "http", category, level: error || (status ?? 0) >= 500 ? "error" : (status ?? 0) >= 400 ? "warning" : "info",
    data: { method, url: stripQuery(url), status_code: status, duration_ms: Date.now() - start, ...(error ? { error: String((error as Error)?.message || error) } : {}) },
  });
}

export function instrumentFetch(): void {
  const orig = globalThis.fetch as typeof fetch & { [PATCHED]?: boolean };
  if (typeof orig !== "function" || orig[PATCHED]) return;
  const wrapped = function (input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const c = active();
    if (!c) return orig(input, init);
    const isReq = typeof Request !== "undefined" && input instanceof Request;
    const url = isReq ? (input as Request).url : String(input);
    if (isOwnUrl(c, url)) return orig(input, init);
    const method = String(init?.method || (isReq ? (input as Request).method : "GET")).toUpperCase();
    const span = c.activeSpan()?.startChild("http.client", `${method} ${stripQuery(new URL(url, location.href).href)}`);
    if (shouldPropagate(c, url)) {
      const headers = new Headers(init?.headers || (isReq ? (input as Request).headers : undefined));
      if (!headers.has("traceparent")) {
        const h = span ? { traceparent: span.traceparent() } : c.propagationHeaders();
        for (const [k, v] of Object.entries(h)) headers.set(k, v);
        init = { ...init, headers };
      }
    }
    const start = Date.now();
    return orig(input, init).then(
      (res) => { span?.setHttpStatus(res.status); span?.end(); httpCrumb(c, "fetch", method, url, start, res.status); return res; },
      (err) => { span?.setStatus("internal_error"); span?.end(); httpCrumb(c, "fetch", method, url, start, undefined, err); throw err; },
    );
  } as typeof fetch & { [PATCHED]?: boolean };
  wrapped[PATCHED] = true;
  globalThis.fetch = wrapped;
}

export function instrumentXhr(): void {
  if (typeof XMLHttpRequest === "undefined") return;
  const proto = XMLHttpRequest.prototype as XMLHttpRequest & { [PATCHED]?: boolean };
  if (proto[PATCHED]) return;
  proto[PATCHED] = true;
  const META = "__errorlens_xhr__";
  const open = proto.open;
  const send = proto.send;
  proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    (this as unknown as Record<string, unknown>)[META] = { method: String(method).toUpperCase(), url: String(url) };
    return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof proto.open;
  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const c = active();
    const meta = (this as unknown as Record<string, { method: string; url: string }>)[META];
    if (c && meta && !isOwnUrl(c, meta.url)) {
      const span = c.activeSpan()?.startChild("http.client", `${meta.method} ${stripQuery(new URL(meta.url, location.href).href)}`);
      if (shouldPropagate(c, meta.url)) {
        try {
          const h = span ? { traceparent: span.traceparent() } : c.propagationHeaders();
          for (const [k, v] of Object.entries(h)) this.setRequestHeader(k, v);
        } catch { /* not opened */ }
      }
      const start = Date.now();
      this.addEventListener("loadend", () => {
        const status = this.status || undefined;
        if (span) { if (status) span.setHttpStatus(status); else span.setStatus("internal_error"); span.end(); }
        httpCrumb(c, "xhr", meta.method, meta.url, start, status, status ? undefined : "network error");
      }, { once: true });
    }
    return send.call(this, body);
  };
}

// ------------------------------------------------------------------ page load and navigation timing

function readMeta(name: string): string | undefined {
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") || undefined;
}

let finishPageLoad: (() => void) | undefined;

/** A transaction for the initial page load, with navigation timing and web vitals. */
export function instrumentPageLoad(c: Client): void {
  const nav = performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
  const origin = performance.timeOrigin / 1000;
  // The server can link the page load to its own request with <meta name="traceparent" content="…">.
  const tp = parseTraceparent(readMeta("traceparent"), readMeta("tracestate"));
  const iso = c.store.isolation();
  if (tp) { iso.traceId = tp.traceId; iso.parentSpanId = tp.parentSpanId; }
  const tx = c.startTransaction(location.pathname, "pageload", tp?.traceId || iso.traceId, tp?.parentSpanId, tp?.sampled,
    { location: location.href }, origin);
  if (!tx.sampled) return;
  iso.traceId = tx.traceId;
  c.store.current().span = tx;

  const vitals: Record<string, number> = {};
  const observe = (type: string, cb: (entries: PerformanceEntry[]) => void) => {
    try { new PerformanceObserver((l) => cb(l.getEntries())).observe({ type, buffered: true } as PerformanceObserverInit); } catch { /* unsupported */ }
  };
  observe("paint", (es) => { for (const e of es) if (e.name === "first-contentful-paint") vitals.fcp = e.startTime; });
  observe("largest-contentful-paint", (es) => { const e = es[es.length - 1]; if (e) vitals.lcp = e.startTime; });
  observe("layout-shift", (es) => {
    for (const e of es as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) vitals.cls = (vitals.cls || 0) + e.value;
  });

  const finish = () => {
    if (tx.endTimestamp !== undefined) return;
    const n = (performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined) || nav;
    if (n) {
      const phase = (op: string, name: string, s: number, e: number) => {
        if (!(e > 0) || e < s) return;
        const span = tx.startChild(op, name);
        (span as { startTimestamp: number }).startTimestamp = origin + s / 1000;
        span.end(origin + e / 1000);
      };
      phase("browser", "dns", n.domainLookupStart, n.domainLookupEnd);
      phase("browser", "connect", n.connectStart, n.connectEnd);
      phase("browser", "request", n.requestStart, n.responseStart);
      phase("browser", "response", n.responseStart, n.responseEnd);
      phase("browser", "dom", n.responseEnd, n.domContentLoadedEventEnd);
      phase("browser", "load", n.domContentLoadedEventEnd, n.loadEventEnd);
      tx.setData("ttfb_ms", Math.round(n.responseStart));
    }
    for (const r of (performance.getEntriesByType?.("resource") || []).slice(0, 100) as PerformanceResourceTiming[]) {
      if (r.startTime > performance.now()) continue;
      const span = tx.startChild(`resource.${r.initiatorType}`, stripQuery(r.name));
      (span as { startTimestamp: number }).startTimestamp = origin + r.startTime / 1000;
      if (r.transferSize) span.setData("http.response_transfer_size", r.transferSize);
      span.end(origin + r.responseEnd / 1000);
    }
    for (const [k, v] of Object.entries(vitals)) tx.setData(`web_vital.${k}`, k === "cls" ? Math.round(v * 1000) / 1000 : Math.round(v));
    tx.end(n?.loadEventEnd ? origin + n.loadEventEnd / 1000 : now());
    finishPageLoad = undefined;
    if (c.store.current().span === tx) c.store.current().span = undefined;
  };
  finishPageLoad = finish;
  // Wait a moment after load so LCP and layout shifts settle; also end if the page is hidden first.
  const afterLoad = () => setTimeout(finish, 1000);
  if (document.readyState === "complete") afterLoad();
  else addEventListener("load", afterLoad, { once: true });
  addEventListener("pagehide", finish, { once: true });
}

/** Single-page-app navigations: a new trace and a "navigation" transaction for each route change. */
export function navigationTracer(c: Client): (from: string, to: string) => void {
  return (_from, to) => {
    const cur = c.store.current();
    // A route change ends the page load (with its timing spans) or the previous navigation.
    if (finishPageLoad) { finishPageLoad(); finishPageLoad = undefined; }
    if (cur.span && cur.span.endTimestamp === undefined) cur.span.end();
    const iso = c.store.isolation();
    iso.traceId = undefined;
    iso.parentSpanId = undefined;
    const path = new URL(to).pathname;
    iso.setTransactionName(path);
    const tx = c.startTransaction(path, "navigation");
    if (!tx.sampled) return;
    iso.traceId = tx.traceId;
    cur.span = tx;
    // The view is "done" once the network has been quiet for a second (max 30 s).
    let timer = setTimeout(end, 1000);
    const max = setTimeout(end, 30_000);
    const poke = () => { clearTimeout(timer); timer = setTimeout(end, 1000); };
    const obs = typeof PerformanceObserver !== "undefined" ? new PerformanceObserver(poke) : undefined;
    try { obs?.observe({ type: "resource" } as PerformanceObserverInit); } catch { /* unsupported */ }
    function end() {
      clearTimeout(timer); clearTimeout(max); obs?.disconnect();
      tx.end();
      if (cur.span === tx) cur.span = undefined;
    }
  };
}
