/** The client: options, the event pipeline and sending. */

import { envelopeUrl, parseDsn, type Dsn } from "./dsn.js";
import { Scope, type ScopeStore } from "./scope.js";
import { Scrubber } from "./scrub.js";
import { parseStack } from "./stacktrace.js";
import { Transaction, type Span } from "./tracing.js";
import type { Breadcrumb, ErrorLensEvent, EventHint, ExceptionValue, Level, LogLevel, LogRecord, Mechanism, MonitorConfig, Options } from "./types.js";
import { matches, normalize, now, spanId, truncate, uuid4 } from "./utils.js";

const LOG_SEVERITY: Record<LogLevel, number> = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 };
const PII_HEADERS = ["cookie", "set-cookie", "authorization", "proxy-authorization", "x-forwarded-for", "x-real-ip", "forwarded"];

export interface Platform {
  /** Which frames are the app's own code. */
  inApp(filename: string): boolean;
  /** Static contexts (runtime, os, browser…). */
  contexts(): Record<string, Record<string, unknown>>;
  /** Last chance to enrich an event (source context, request info). */
  enrich?(event: ErrorLensEvent, hint: EventHint): void;
}

type Item = [Record<string, unknown>, string];

export class Client {
  readonly options: Options;
  readonly dsn: Dsn | undefined;
  readonly active: boolean;
  readonly scrubber: Scrubber;
  readonly globalScope = new Scope();
  lastEventId: string | undefined;
  integrations: string[] = [];
  dropped = 0;
  private pending = new Set<Promise<void>>();
  private disabledUntil = 0;
  private logs: LogRecord[] = [];
  private logTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: Options, readonly store: ScopeStore, readonly platform: Platform) {
    this.options = { sampleRate: 1, maxBreadcrumbs: 100, maxQueueSize: 30, environment: "production", ...options };
    this.dsn = options.dsn ? parseDsn(options.dsn) : undefined;
    if (options.dsn && !this.dsn) console.warn("[ErrorLens] Invalid DSN — reporting is disabled.");
    this.active = options.enabled !== false && !!this.dsn && !!options.transport;
    this.scrubber = new Scrubber(options.scrubFields, options.safeFields);
    this.globalScope.maxBreadcrumbs = this.options.maxBreadcrumbs!;
  }

  // --- capturing ------------------------------------------------------------------------

  captureException(error: unknown, hint: EventHint = {}, mechanism?: Mechanism, level: Level = "error"): string | undefined {
    if (!this.active) return undefined;
    const event: ErrorLensEvent = { level, exception: { values: this.exceptionValues(error, mechanism) } };
    return this.captureEvent(event, { originalException: error, ...hint });
  }

  captureMessage(message: string, level: Level = "info", hint: EventHint = {}): string | undefined {
    if (!this.active) return undefined;
    const event: ErrorLensEvent = { message, level };
    if (this.options.attachStacktrace) {
      const frames = parseStack(new Error().stack, (f) => this.platform.inApp(f)).filter((f) => !/errorlens/.test(f.filename || ""));
      event.threads = { values: [{ current: true, stacktrace: { frames } }] };
    }
    return this.captureEvent(event, hint);
  }

  captureEvent(event: ErrorLensEvent, hint: EventHint = {}): string | undefined {
    if (!this.active) return undefined;
    let prepared: ErrorLensEvent | null;
    try {
      prepared = this.prepare({ ...event }, hint);
    } catch (e) {
      if (this.options.debug) console.warn("[ErrorLens] Could not prepare event", e);
      return undefined;
    }
    if (!prepared) return undefined;
    this.send([[{ type: "event" }, JSON.stringify(prepared)]], prepared.event_id);
    this.lastEventId = prepared.event_id;
    return prepared.event_id;
  }

  exceptionValues(error: unknown, mechanism?: Mechanism): ExceptionValue[] {
    const values: ExceptionValue[] = [];
    let cur: unknown = error;
    const seen = new Set<unknown>();
    while (cur !== undefined && cur !== null && !seen.has(cur) && values.length < 10) {
      seen.add(cur);
      values.push(this.exceptionValue(cur));
      cur = cur instanceof Error ? (cur as { cause?: unknown }).cause : undefined;
    }
    values.reverse(); // oldest (the cause) first
    values.forEach((v, i) => {
      v.mechanism = i === values.length - 1 ? mechanism || { type: "generic", handled: true } : { type: "chained", handled: true, source: "cause" };
    });
    return values;
  }

  private exceptionValue(err: unknown): ExceptionValue {
    if (err instanceof Error) {
      return {
        type: err.name || err.constructor?.name || "Error",
        value: truncate(err.message || "", 8192),
        stacktrace: { frames: parseStack(err.stack, (f) => this.platform.inApp(f)) },
      };
    }
    if (err && typeof err === "object") {
      const keys = Object.keys(err as object).slice(0, 10).join(", ");
      const ctor = (err as object).constructor?.name;
      return { type: ctor && ctor !== "Object" ? ctor : "Error", value: `Non-Error object thrown with keys: ${keys || "(none)"}` };
    }
    return { type: "Error", value: truncate(String(err), 8192) };
  }

  private prepare(event: ErrorLensEvent, hint: EventHint): ErrorLensEvent | null {
    const o = this.options;
    if (event.type !== "transaction" && o.sampleRate! < 1 && Math.random() >= o.sampleRate!) return null;
    this.defaults(event);
    if (event.type !== "transaction") {
      event.contexts!.trace = event.contexts!.trace || this.traceContext();
    }
    let out: ErrorLensEvent | null = event;
    for (const scope of [this.store.current(), this.store.isolation(), this.globalScope]) {
      out = scope.apply(out, hint);
      if (!out) return null;
    }
    if (this.ignored(out)) return null;
    if (out.breadcrumbs && out.breadcrumbs.values.length > o.maxBreadcrumbs!) {
      out.breadcrumbs.values = out.breadcrumbs.values.slice(-o.maxBreadcrumbs!);
    }
    this.platform.enrich?.(out, hint);
    this.privacy(out);
    for (const key of ["extra", "contexts", "user", "request"] as const) {
      if (out[key] !== undefined) (out as Record<string, unknown>)[key] = normalize(out[key]);
    }
    out = normalize(out, 16, 1000, 16384) as ErrorLensEvent;
    for (const key of ["request", "extra", "contexts", "user", "tags", "breadcrumbs", "exception", "message", "logentry", "spans"]) {
      if (out[key] !== undefined) (out as Record<string, unknown>)[key] = this.scrubber.value(out[key]);
    }
    if (out.type === "transaction") return o.beforeSendTransaction ? o.beforeSendTransaction(out) : out;
    return o.beforeSend ? o.beforeSend(out, hint) : out;
  }

  private defaults(event: ErrorLensEvent): void {
    const o = this.options;
    const sdk = o._sdk || { name: "errorlens.javascript", version: "0.0.0", platform: "javascript" };
    event.event_id = event.event_id || uuid4();
    event.timestamp = event.timestamp || now();
    event.platform = event.platform || sdk.platform;
    if (o.release) event.release = event.release || o.release;
    event.environment = event.environment || o.environment;
    if (o.serverName) event.server_name = event.server_name || o.serverName;
    event.sdk = { name: sdk.name, version: sdk.version, integrations: this.integrations };
    event.contexts = { ...this.platform.contexts(), ...event.contexts };
  }

  private privacy(event: ErrorLensEvent): void {
    if (this.options.sendDefaultPii) return;
    if (event.user && event.user.ip_address === "{{auto}}") delete event.user.ip_address;
    const req = event.request as { headers?: Record<string, string>; cookies?: unknown; data?: unknown } | undefined;
    if (req) {
      delete req.cookies;
      delete req.data;
      if (req.headers) for (const h of Object.keys(req.headers)) if (PII_HEADERS.includes(h.toLowerCase())) delete req.headers[h];
    }
  }

  private ignored(event: ErrorLensEvent): boolean {
    const patterns = this.options.ignoreErrors;
    if (!patterns?.length) return false;
    const texts = [event.message || ""];
    for (const v of event.exception?.values || []) texts.push(`${v.type}: ${v.value}`, v.value);
    return texts.some((t) => t && matches(t, patterns));
  }

  // --- trace context ----------------------------------------------------------------------

  activeSpan(): Span | undefined {
    const span = this.store.current().span;
    return span && span.endTimestamp === undefined ? span : undefined;
  }

  traceContext(): Record<string, unknown> {
    const span = this.activeSpan();
    if (span) return { trace_id: span.traceId, span_id: span.spanId, parent_span_id: span.parentSpanId, op: span.op };
    const iso = this.store.isolation();
    if (!iso.traceId) iso.traceId = uuid4();
    const ctx: Record<string, unknown> = { trace_id: iso.traceId, span_id: spanId() };
    if (iso.parentSpanId) ctx.parent_span_id = iso.parentSpanId;
    return ctx;
  }

  /** The traceparent value for an outgoing request. */
  traceparent(): string {
    const span = this.activeSpan();
    if (span) return span.traceparent();
    const ctx = this.traceContext();
    return `00-${ctx.trace_id}-${spanId()}-00`;
  }

  /**
   * Headers for an outgoing request. Without an active transaction the sampling
   * decision is left to the receiver ("tracestate: errorlens=d"), so a service called
   * from a script or job still traces its own requests.
   */
  propagationHeaders(): Record<string, string> {
    if (this.activeSpan()) return { traceparent: this.traceparent() };
    return { traceparent: this.traceparent(), tracestate: "errorlens=d" };
  }

  sampleTransaction(name: string, op: string, parentSampled: boolean | undefined, context: Record<string, unknown> = {}): boolean {
    if (!this.active) return false;
    const o = this.options;
    if (o.tracesSampler) {
      try {
        const r = o.tracesSampler({ name, op, parentSampled, ...context });
        return typeof r === "boolean" ? r : Math.random() < Number(r);
      } catch {
        return false;
      }
    }
    if (parentSampled !== undefined) return parentSampled;
    return o.tracesSampleRate !== undefined && Math.random() < o.tracesSampleRate;
  }

  startTransaction(name: string, op: string, traceId?: string, parentSpanId?: string, parentSampled?: boolean,
                   context?: Record<string, unknown>, startTimestamp?: number): Transaction {
    const sampled = this.sampleTransaction(name, op, parentSampled, context);
    return new Transaction(op, name, traceId, parentSpanId, sampled, (tx) => this.captureTransaction(tx), startTimestamp);
  }

  captureTransaction(tx: Transaction): void {
    if (!this.active) return;
    try {
      const event = this.prepare(tx.toEvent() as ErrorLensEvent, {});
      if (event) this.send([[{ type: "transaction" }, JSON.stringify(event)]], event.event_id);
    } catch (e) {
      if (this.options.debug) console.warn("[ErrorLens] Could not send transaction", e);
    }
  }

  // --- breadcrumbs ------------------------------------------------------------------------

  addBreadcrumb(crumb: Breadcrumb, hint?: Record<string, unknown>): void {
    if (!this.active) return;
    let c: Breadcrumb | null = { timestamp: now(), type: "default", ...crumb };
    if (this.options.beforeBreadcrumb) {
      try { c = this.options.beforeBreadcrumb(c, hint); } catch { /* keep the crumb */ }
    }
    if (c) this.store.isolation().addBreadcrumb(c);
  }

  // --- logs -------------------------------------------------------------------------------

  captureLog(level: LogLevel, body: string, attributes: Record<string, unknown> = {}): void {
    if (!this.active || !this.options.enableLogs) return;
    const attrs: Record<string, unknown> = { ...attributes };
    if (this.options.release) attrs["errorlens.release"] = this.options.release;
    attrs["errorlens.environment"] = this.options.environment;
    if (this.options.serverName) attrs["server.address"] = this.options.serverName;
    let record: LogRecord | null = {
      timestamp: now(), trace_id: String(this.traceContext().trace_id), level,
      severity_number: LOG_SEVERITY[level], body: truncate(this.scrubber.string(String(body)), 8192), attributes: attrs,
    };
    if (this.options.beforeSendLog) record = this.options.beforeSendLog(record);
    if (!record) return;
    const typed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record.attributes)) typed[k] = this.logAttr(k, v);
    record.attributes = typed;
    this.logs.push(record);
    if (this.logs.length >= 100) this.flushLogs();
    else if (!this.logTimer) {
      this.logTimer = setTimeout(() => this.flushLogs(), 5000);
      (this.logTimer as { unref?: () => void }).unref?.();
    }
  }

  private logAttr(key: string, v: unknown): { value: unknown; type: string } {
    if (this.scrubber.sensitiveKey(key)) return { value: "[Filtered]", type: "string" };
    if (typeof v === "boolean") return { value: v, type: "boolean" };
    if (typeof v === "number") return Number.isInteger(v) ? { value: v, type: "integer" } : { value: v, type: "double" };
    const s = typeof v === "string" ? v : JSON.stringify(normalize(v, 3, 20, 512));
    return { value: truncate(this.scrubber.string(String(s)), 1024), type: "string" };
  }

  flushLogs(): void {
    if (this.logTimer) clearTimeout(this.logTimer);
    this.logTimer = undefined;
    const batch = this.logs;
    this.logs = [];
    if (batch.length) this.send([[{ type: "log", item_count: batch.length }, JSON.stringify({ items: batch })]]);
  }

  // --- cron check-ins ---------------------------------------------------------------------

  captureCheckIn(slug: string, status: "in_progress" | "ok" | "error", checkInId?: string, duration?: number, config?: MonitorConfig): string | undefined {
    if (!this.active) return undefined;
    const id = checkInId || uuid4();
    const payload: Record<string, unknown> = { check_in_id: id, monitor_slug: slug, status, environment: this.options.environment };
    if (duration !== undefined) payload.duration = duration;
    if (this.options.release) payload.release = this.options.release;
    if (config) {
      payload.monitor_config = { schedule: config.schedule, timezone: config.timezone || "UTC",
        ...(config.checkinMargin !== undefined ? { checkin_margin: config.checkinMargin } : {}),
        ...(config.maxRuntime !== undefined ? { max_runtime: config.maxRuntime } : {}) };
    }
    this.send([[{ type: "check_in" }, JSON.stringify(payload)]]);
    return id;
  }

  // --- sending ----------------------------------------------------------------------------

  private send(items: Item[], eventId?: string): void {
    if (!this.dsn || !this.options.transport) return;
    if (Date.now() < this.disabledUntil || this.pending.size >= this.options.maxQueueSize!) {
      this.dropped++;
      return;
    }
    const sdk = this.options._sdk || { name: "errorlens.javascript", version: "0.0.0" };
    const header: Record<string, unknown> = { sent_at: new Date().toISOString(), sdk: { name: sdk.name, version: sdk.version } };
    if (eventId) header.event_id = eventId;
    const lines = [JSON.stringify(header)];
    const enc = new TextEncoder();
    for (const [h, payload] of items) lines.push(JSON.stringify({ ...h, length: enc.encode(payload).length }), payload);
    const body = lines.join("\n") + "\n";
    const p = this.options.transport(envelopeUrl(this.dsn), body, { "Content-Type": "application/x-errorlens-envelope", "X-ErrorLens-Key": this.dsn.publicKey })
      .then((res) => {
        if (res.status === 429 || res.headers["retry-after"]) {
          const secs = Number(res.headers["retry-after"]);
          this.disabledUntil = Date.now() + 1000 * Math.min(3600, Math.max(1, Number.isFinite(secs) ? secs : 60));
        }
      })
      .catch((e) => { if (this.options.debug) console.warn("[ErrorLens] Could not send", e); })
      .finally(() => { this.pending.delete(p); });
    this.pending.add(p);
  }

  /** True while anything is queued or buffered. */
  hasPending(): boolean { return this.pending.size > 0 || this.logs.length > 0; }

  /** Resolves true once everything queued is sent, or false after timeoutMs. */
  async flush(timeoutMs = 2000): Promise<boolean> {
    this.flushLogs();
    const all = Promise.all(Array.from(this.pending)).then(() => true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((r) => { timer = setTimeout(() => r(false), timeoutMs); });
    const done = await Promise.race([all, timeout]);
    if (timer) clearTimeout(timer);
    return done;
  }
}
