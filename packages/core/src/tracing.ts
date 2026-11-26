/** Spans, transactions and W3C trace context (traceparent). */

import { now, spanId, uuid4 } from "./utils.js";

const TRACEPARENT = /^\s*([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})\s*$/;
const MAX_SPANS = 1000;

/** sampled is undefined when the caller left the decision to us. */
export interface TraceParent { traceId: string; parentSpanId: string; sampled: boolean | undefined }

export function parseTraceparent(value: string | null | undefined, tracestate?: string | null): TraceParent | undefined {
  if (!value) return undefined;
  const m = TRACEPARENT.exec(value.toLowerCase());
  if (!m || m[1] === "ff" || /^0+$/.test(m[2]) || /^0+$/.test(m[3])) return undefined;
  const deferred = !!tracestate && /(?:^|,)\s*errorlens=d\s*(?:,|$)/.test(tracestate);
  return { traceId: m[2], parentSpanId: m[3], sampled: deferred ? undefined : (parseInt(m[4], 16) & 1) === 1 };
}

export function httpStatusToSpanStatus(code: number | undefined): string {
  if (code === undefined) return "unknown";
  if (code < 400) return "ok";
  const known: Record<number, string> = { 400: "invalid_argument", 401: "unauthenticated", 403: "permission_denied",
    404: "not_found", 409: "already_exists", 429: "resource_exhausted", 499: "cancelled", 501: "unimplemented",
    503: "unavailable", 504: "deadline_exceeded" };
  return known[code] || (code >= 500 ? "internal_error" : "invalid_argument");
}

export class Span {
  readonly spanId = spanId();
  readonly startTimestamp: number;
  endTimestamp: number | undefined;
  status: string | undefined;
  data: Record<string, unknown> = {};
  name: string;

  constructor(
    public op: string,
    name: string,
    public readonly traceId: string,
    public readonly parentSpanId: string | undefined,
    public readonly sampled: boolean,
    public readonly transaction: Transaction | undefined,
    startTimestamp?: number,
  ) {
    this.name = name;
    this.startTimestamp = startTimestamp ?? now();
  }

  setData(key: string, value: unknown): this { this.data[key] = value; return this; }
  setStatus(status: string): this { this.status = status; return this; }
  setHttpStatus(code: number): this {
    this.status = httpStatusToSpanStatus(code);
    this.data["http.response.status_code"] = code;
    return this;
  }
  updateName(name: string): this { this.name = name; return this; }
  isRecording(): boolean { return this.sampled && this.endTimestamp === undefined; }
  traceparent(): string { return `00-${this.traceId}-${this.spanId}-${this.sampled ? "01" : "00"}`; }

  startChild(op: string, name: string): Span {
    return new Span(op, name, this.traceId, this.spanId, this.sampled, this.transaction);
  }

  end(timestamp?: number): void {
    if (this.endTimestamp !== undefined) return;
    this.endTimestamp = timestamp ?? now();
    if (this.transaction && (this.transaction as Span) !== this) this.transaction._childEnded(this);
  }

  toJSON(): Record<string, unknown> {
    const d: Record<string, unknown> = {
      trace_id: this.traceId, span_id: this.spanId, parent_span_id: this.parentSpanId, op: this.op,
      description: this.name, start_timestamp: this.startTimestamp, timestamp: this.endTimestamp ?? now(),
      status: this.status || "ok",
    };
    if (Object.keys(this.data).length) d.data = this.data;
    return d;
  }
}

export class Transaction extends Span {
  private spans: Span[] = [];
  private dropped = 0;

  constructor(op: string, name: string, traceId: string | undefined, parentSpanId: string | undefined, sampled: boolean,
              private readonly onEnd: (tx: Transaction) => void, startTimestamp?: number) {
    super(op, name, traceId || uuid4(), parentSpanId, sampled, undefined, startTimestamp);
    (this as { transaction: Transaction }).transaction = this;
  }

  _childEnded(span: Span): void {
    if (!this.sampled) return;
    if (this.spans.length < MAX_SPANS) this.spans.push(span);
    else this.dropped++;
  }

  end(timestamp?: number): void {
    if (this.endTimestamp !== undefined) return;
    super.end(timestamp);
    if (this.sampled) this.onEnd(this);
  }

  toEvent(): Record<string, unknown> {
    const trace: Record<string, unknown> = { trace_id: this.traceId, span_id: this.spanId, op: this.op, status: this.status || "ok" };
    if (this.parentSpanId) trace.parent_span_id = this.parentSpanId;
    if (Object.keys(this.data).length) trace.data = this.data;
    const event: Record<string, unknown> = {
      type: "transaction", event_id: uuid4(), transaction: this.name, start_timestamp: this.startTimestamp,
      timestamp: this.endTimestamp ?? now(), contexts: { trace }, spans: this.spans.map((s) => s.toJSON()),
    };
    if (this.dropped) event.extra = { dropped_spans: this.dropped };
    return event;
  }
}
