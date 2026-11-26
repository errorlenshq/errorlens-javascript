/** The public functions, shared by @errorlenshq/node and @errorlenshq/browser. */

import type { Client } from "./client.js";
import { Scope } from "./scope.js";
import { Span, Transaction, parseTraceparent } from "./tracing.js";
import type { Breadcrumb, ErrorLensEvent, EventHint, Level, LogLevel, MonitorConfig, User } from "./types.js";

interface Carrier { client?: Client }
const KEY = "__errorlens__";
const carrier = ((globalThis as Record<string, unknown>)[KEY] ||= {}) as Carrier;

/** Used by the platform packages' init(); apps call init() instead. */
export function setClient(client: Client | undefined): void { carrier.client = client; }
export function getClient(): Client | undefined { return carrier.client; }
export function isEnabled(): boolean { return !!carrier.client?.active; }

const active = (): Client | undefined => (carrier.client?.active ? carrier.client : undefined);

// --- capturing -------------------------------------------------------------------------------

export function captureException(error: unknown, hint?: EventHint): string | undefined {
  return active()?.captureException(error, hint);
}
export function captureMessage(message: string, level: Level = "info"): string | undefined {
  return active()?.captureMessage(message, level);
}
export function captureEvent(event: ErrorLensEvent, hint?: EventHint): string | undefined {
  return active()?.captureEvent(event, hint);
}
export function lastEventId(): string | undefined { return carrier.client?.lastEventId; }
export function addBreadcrumb(crumb: Breadcrumb): void { active()?.addBreadcrumb(crumb); }

// --- context ---------------------------------------------------------------------------------

function isolation(): Scope | undefined { return carrier.client?.store.isolation(); }
export function setUser(user: User | null): void { isolation()?.setUser(user); }
export function setTag(key: string, value: unknown): void { isolation()?.setTag(key, value); }
export function setTags(tags: Record<string, unknown>): void { isolation()?.setTags(tags); }
export function setExtra(key: string, value: unknown): void { isolation()?.setExtra(key, value); }
export function setExtras(extras: Record<string, unknown>): void { for (const [k, v] of Object.entries(extras)) setExtra(k, v); }
export function setContext(key: string, value: Record<string, unknown> | null): void { isolation()?.setContext(key, value); }
export function getIsolationScope(): Scope { return carrier.client?.store.isolation() || new Scope(); }
export function getCurrentScope(): Scope { return carrier.client?.store.current() || new Scope(); }
export function getGlobalScope(): Scope { return carrier.client?.globalScope || new Scope(); }

/** Runs callback with a temporary copy of the current scope. */
export function withScope<T>(callback: (scope: Scope) => T): T {
  const c = carrier.client;
  if (!c) return callback(new Scope());
  const scope = c.store.current().clone();
  return c.store.withCurrent(scope, () => callback(scope));
}

/** Runs callback with a fresh isolation scope — like a new request. */
export function withIsolationScope<T>(callback: (scope: Scope) => T): T {
  const c = carrier.client;
  if (!c) return callback(new Scope());
  return c.store.withIsolation(() => callback(c.store.isolation()));
}

// --- tracing ---------------------------------------------------------------------------------

export interface SpanOptions {
  name: string;
  op?: string;
  attributes?: Record<string, unknown>;
  /** Continue a trace from another service (a traceparent header value). */
  traceparent?: string;
  /** The tracestate header that came with it. */
  tracestate?: string;
}

const noop = () => new Span("noop", "noop", "0".repeat(32), undefined, false, undefined);

/**
 * Times the callback. Inside a transaction this is a child span; otherwise it
 * starts a transaction. Promises are awaited before the span ends.
 *
 *   await ErrorLens.startSpan({ name: "load orders", op: "db.query" }, () => db.orders.find());
 */
export function startSpan<T>(options: SpanOptions, callback: (span: Span) => T): T {
  const c = active();
  if (!c) return callback(noop());
  const span = startInactiveSpan(options);
  const scope = c.store.current().clone();
  scope.span = span;
  return c.store.withCurrent(scope, () => {
    let result: T;
    try {
      result = callback(span);
    } catch (e) {
      span.setStatus("internal_error");
      span.end();
      throw e;
    }
    if (result && typeof (result as { then?: unknown }).then === "function") {
      return (result as unknown as Promise<unknown>).then(
        (v) => { span.end(); return v; },
        (e) => { span.setStatus("internal_error"); span.end(); throw e; },
      ) as unknown as T;
    }
    span.end();
    return result;
  });
}

/** A span you end yourself with span.end(). */
export function startInactiveSpan(options: SpanOptions): Span {
  const c = active();
  if (!c) return noop();
  const parent = options.traceparent ? undefined : c.activeSpan();
  let span: Span;
  if (parent) {
    span = parent.startChild(options.op || "function", options.name);
  } else {
    const iso = c.store.isolation();
    const tp = parseTraceparent(options.traceparent, options.tracestate);
    span = c.startTransaction(options.name, options.op || "function", tp?.traceId || iso.traceId,
      tp?.parentSpanId || iso.parentSpanId, tp?.sampled);
  }
  for (const [k, v] of Object.entries(options.attributes || {})) span.setData(k, v);
  return span;
}

export function getActiveSpan(): Span | undefined { return active()?.activeSpan(); }

/** The W3C traceparent header value for an outgoing request. */
export function getTraceparent(): string | undefined { return active()?.traceparent(); }

/** traceparent (and tracestate) headers for an outgoing request; empty when the SDK is off. */
export function getTraceHeaders(): Record<string, string> { return active()?.propagationHeaders() || {}; }

export { Span, Transaction };

// --- logs ------------------------------------------------------------------------------------

function log(level: LogLevel, message: string, attributes?: Record<string, unknown>): void {
  const c = active();
  if (!c) return;
  const attrs: Record<string, unknown> = { ...attributes };
  let body = message;
  if (attributes && /\{[\w.]+\}/.test(message)) {
    attrs["message.template"] = message;
    body = message.replace(/\{([\w.]+)\}/g, (m, k: string) => (k in attributes ? String(attributes[k]) : m));
  }
  c.captureLog(level, body, attrs);
}

/** Structured logs (needs init({ enableLogs: true })):  logger.info("Order {orderId} paid", { orderId: 42 }) */
export const logger = {
  trace: (message: string, attributes?: Record<string, unknown>) => log("trace", message, attributes),
  debug: (message: string, attributes?: Record<string, unknown>) => log("debug", message, attributes),
  info: (message: string, attributes?: Record<string, unknown>) => log("info", message, attributes),
  warn: (message: string, attributes?: Record<string, unknown>) => log("warn", message, attributes),
  error: (message: string, attributes?: Record<string, unknown>) => log("error", message, attributes),
  fatal: (message: string, attributes?: Record<string, unknown>) => log("fatal", message, attributes),
};

// --- cron monitors ---------------------------------------------------------------------------

export function captureCheckIn(checkIn: { monitorSlug: string; status: "in_progress" | "ok" | "error"; checkInId?: string; duration?: number },
                               config?: MonitorConfig): string | undefined {
  return active()?.captureCheckIn(checkIn.monitorSlug, checkIn.status, checkIn.checkInId, checkIn.duration, config);
}

/**
 * Reports a scheduled job's run to a cron monitor; with a config, the monitor
 * is created or updated from code.
 *
 *   await withMonitor("nightly-backup", () => backup(), { schedule: { type: "crontab", value: "0 2 * * *" } });
 */
export function withMonitor<T>(slug: string, callback: () => T, config?: MonitorConfig): T {
  const id = captureCheckIn({ monitorSlug: slug, status: "in_progress" }, config);
  const start = Date.now();
  const done = (status: "ok" | "error") =>
    captureCheckIn({ monitorSlug: slug, status, checkInId: id, duration: (Date.now() - start) / 1000 }, config);
  let result: T;
  try {
    result = callback();
  } catch (e) {
    done("error");
    throw e;
  }
  if (result && typeof (result as { then?: unknown }).then === "function") {
    return (result as unknown as Promise<unknown>).then((v) => { done("ok"); return v; }, (e) => { done("error"); throw e; }) as unknown as T;
  }
  done("ok");
  return result;
}

// --- lifecycle -------------------------------------------------------------------------------

/** Waits until queued data is sent (up to timeoutMs). Call before short-lived processes exit. */
export function flush(timeoutMs?: number): Promise<boolean> {
  return carrier.client ? carrier.client.flush(timeoutMs) : Promise.resolve(true);
}

export async function close(timeoutMs?: number): Promise<boolean> {
  const ok = await flush(timeoutMs);
  carrier.client = undefined;
  return ok;
}
