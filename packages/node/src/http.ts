/** Node's http/https modules: outgoing request spans and breadcrumbs, incoming request isolation and transactions. */
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { httpStatusToSpanStatus, now, parseTraceparent, uuid4, type Client, type Scope, type Span } from "@errorlenshq/core";
import { active, isOwnUrl, parameterize, shouldPropagate, stripQuery } from "./util.js";

const PATCHED = Symbol.for("errorlens.patched");
type AnyFn = ((...args: any[]) => any) & { [PATCHED]?: boolean };

// ---------------------------------------------------------------- outgoing requests

function describe(args: unknown[], defaultProtocol: string): { method: string; url: string } {
  let url: URL | undefined;
  let opts: Record<string, any> = {};
  if (typeof args[0] === "string" || args[0] instanceof URL) {
    try { url = new URL(String(args[0])); } catch { /* relative */ }
    if (args[1] && typeof args[1] === "object") opts = args[1] as Record<string, any>;
  } else if (args[0] && typeof args[0] === "object") {
    opts = args[0] as Record<string, any>;
  }
  const method = String(opts.method || "GET").toUpperCase();
  if (!url) {
    const protocol = opts.protocol || defaultProtocol;
    const host = opts.hostname || opts.host || "localhost";
    const port = opts.port && !(protocol === "https:" && +opts.port === 443) && !(protocol === "http:" && +opts.port === 80) ? `:${opts.port}` : "";
    return { method, url: `${protocol}//${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}${port}${opts.path || "/"}` };
  }
  return { method, url: url.toString() };
}

function wrapRequest(orig: AnyFn, defaultProtocol: string): AnyFn {
  if (orig[PATCHED]) return orig;
  const wrapped: AnyFn = function (this: unknown, ...args: any[]) {
    const c = active();
    if (!c) return orig.apply(this, args);
    const { method, url } = describe(args, defaultProtocol);
    if (isOwnUrl(c, url)) return orig.apply(this, args);
    const clean = stripQuery(url);
    const parent = c.activeSpan();
    const span = parent?.startChild("http.client", `${method} ${clean}`);
    span?.setData("http.request.method", method).setData("url.full", clean);
    const req = orig.apply(this, args) as http.ClientRequest;
    try {
      if (shouldPropagate(c, url) && !req.headersSent && !req.getHeader("traceparent")) {
        const h = span ? { traceparent: span.traceparent() } : c.propagationHeaders();
        for (const [k, v] of Object.entries(h)) req.setHeader(k, v);
      }
    } catch { /* headers already sent */ }
    const start = Date.now();
    let done = false;
    const finish = (status?: number, error?: Error) => {
      if (done) return;
      done = true;
      if (span) {
        if (status !== undefined) span.setHttpStatus(status);
        else span.setStatus(error ? "internal_error" : "unknown");
        span.end();
      }
      c.addBreadcrumb({
        type: "http", category: "http", level: error || (status ?? 0) >= 500 ? "error" : (status ?? 0) >= 400 ? "warning" : "info",
        data: { method, url: clean, status_code: status, duration_ms: Date.now() - start, ...(error ? { error: error.message } : {}) },
      });
    };
    req.once("response", (res: http.IncomingMessage) => {
      res.once("end", () => finish(res.statusCode));
      res.once("close", () => finish(res.statusCode));
    });
    req.once("error", (e: Error) => finish(undefined, e));
    req.once("close", () => setImmediate(() => finish(undefined)));
    return req;
  };
  wrapped[PATCHED] = true;
  return wrapped;
}

export function instrumentHttpClient(): void {
  for (const [mod, proto] of [[http, "http:"], [https, "https:"]] as const) {
    const m = mod as unknown as Record<string, AnyFn>;
    const request = wrapRequest(m.request, proto);
    m.request = request;
    if (!(m.get as AnyFn)[PATCHED]) {
      const get: AnyFn = function (this: unknown, ...args: any[]) {
        const req = request.apply(this, args);
        req.end();
        return req;
      };
      get[PATCHED] = true;
      m.get = get;
    }
  }
  syncBuiltinESMExports();
}

// ---------------------------------------------------------------- incoming requests

export interface RequestState { transaction?: Span; name?: string; nameFixed?: boolean; scope?: Scope }
export const REQUEST_STATE = Symbol.for("errorlens.request");

/** Overrides the transaction name for the current request (frameworks call this with the route). */
export function setRequestRoute(req: object | undefined, route: string): void {
  const s = req && (req as Record<symbol, RequestState>)[REQUEST_STATE];
  if (s) { s.name = route; s.nameFixed = true; s.scope?.setTransactionName(route); }
}

function requestInfo(c: Client, req: http.IncomingMessage): Record<string, unknown> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
  const encrypted = (req.socket as { encrypted?: boolean }).encrypted;
  const proto = String(req.headers["x-forwarded-proto"] || (encrypted ? "https" : "http")).split(",")[0].trim();
  const path = req.url || "/";
  const q = path.indexOf("?");
  const info: Record<string, unknown> = {
    method: req.method, url: `${proto}://${req.headers.host || "localhost"}${q === -1 ? path : path.slice(0, q)}`, headers,
  };
  if (q !== -1) info.query_string = path.slice(q + 1);
  if (c.options.sendDefaultPii) {
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
    if (ip) info.env = { REMOTE_ADDR: ip };
  }
  return info;
}

function handleRequest(c: Client, req: http.IncomingMessage, res: http.ServerResponse, run: () => boolean): boolean {
  return c.store.withIsolation(() => {
    const scope = c.store.isolation();
    const tp = parseTraceparent(req.headers.traceparent as string | undefined, req.headers.tracestate as string | undefined);
    scope.traceId = tp?.traceId || uuid4();
    scope.parentSpanId = tp?.parentSpanId;
    scope.request = requestInfo(c, req);
    const method = (req.method || "GET").toUpperCase();
    const state: RequestState = { name: `${method} ${parameterize(req.url || "/")}`, scope };
    (req as unknown as Record<symbol, RequestState>)[REQUEST_STATE] = state;
    scope.setTransactionName(state.name!);

    if (method !== "OPTIONS" && method !== "HEAD") {
      const tx = c.startTransaction(state.name!, "http.server", scope.traceId, tp?.parentSpanId, tp?.sampled,
        { request: req }, now());
      if (tx.sampled) {
        state.transaction = tx;
        tx.setData("http.request.method", method);
        const cur = c.store.current();
        cur.span = tx;
      }
    }

    // Express/connect set req.route when a route matches; req.baseUrl is the full
    // mount path only at that moment (nested routers reset it on the way out).
    let route: unknown;
    Object.defineProperty(req, "route", {
      configurable: true, enumerable: true, get: () => route,
      set(v: { path?: unknown } | undefined) {
        route = v;
        if (!state.nameFixed && v && typeof v.path === "string") {
          state.name = `${method} ${(req as { baseUrl?: string }).baseUrl || ""}${v.path}`;
          scope.setTransactionName(state.name);
        }
      },
    });

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      scope.setTransactionName(state.name!);
      const tx = state.transaction;
      if (tx) {
        tx.updateName(state.name!);
        if (res.writableFinished || res.headersSent) tx.setHttpStatus(res.statusCode);
        else tx.setStatus("cancelled");
        tx.end();
      }
    };
    res.once("finish", finish);
    res.once("close", finish);
    return run();
  }, true);
}

function patchServer(proto: { emit: AnyFn }): void {
  const orig = proto.emit;
  if (orig[PATCHED]) return;
  const emit: AnyFn = function (this: unknown, event: string, ...args: any[]) {
    const c = event === "request" ? active() : undefined;
    if (!c) return orig.call(this, event, ...args);
    return handleRequest(c, args[0], args[1], () => orig.call(this, event, ...args));
  };
  emit[PATCHED] = true;
  proto.emit = emit;
}

export function instrumentHttpServer(): void {
  patchServer(http.Server.prototype as unknown as { emit: AnyFn });
  patchServer(https.Server.prototype as unknown as { emit: AnyFn });
}

export { httpStatusToSpanStatus };
