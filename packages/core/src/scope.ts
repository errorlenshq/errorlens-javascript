/** Scopes: tags, user, breadcrumbs and the active span attached to events. */

import type { Breadcrumb, ErrorLensEvent, EventHint, Level, User } from "./types.js";
import type { Span } from "./tracing.js";

export type EventProcessor = (event: ErrorLensEvent, hint: EventHint) => ErrorLensEvent | null;

export class Scope {
  tags: Record<string, string> = {};
  extra: Record<string, unknown> = {};
  contexts: Record<string, Record<string, unknown>> = {};
  user: User | undefined;
  level: Level | undefined;
  fingerprint: string[] | undefined;
  transactionName: string | undefined;
  request: Record<string, unknown> | undefined;
  breadcrumbs: Breadcrumb[] = [];
  maxBreadcrumbs = 100;
  span: Span | undefined;
  processors: EventProcessor[] = [];
  /** Trace for errors and logs outside a transaction (one per request). */
  traceId: string | undefined;
  parentSpanId: string | undefined;

  setTag(key: string, value: unknown): this { this.tags[String(key).slice(0, 200)] = String(value).slice(0, 200); return this; }
  setTags(tags: Record<string, unknown>): this { for (const [k, v] of Object.entries(tags)) this.setTag(k, v); return this; }
  setExtra(key: string, value: unknown): this { this.extra[key] = value; return this; }
  setContext(key: string, value: Record<string, unknown> | null): this {
    if (value === null) delete this.contexts[key];
    else this.contexts[key] = { ...value };
    return this;
  }
  setUser(user: User | null): this { this.user = user ? { ...user } : undefined; return this; }
  setLevel(level: Level): this { this.level = level; return this; }
  setFingerprint(fp: string[]): this { this.fingerprint = [...fp]; return this; }
  setTransactionName(name: string): this { this.transactionName = name; return this; }
  addBreadcrumb(crumb: Breadcrumb): this {
    this.breadcrumbs.push(crumb);
    if (this.breadcrumbs.length > this.maxBreadcrumbs) this.breadcrumbs.splice(0, this.breadcrumbs.length - this.maxBreadcrumbs);
    return this;
  }
  clearBreadcrumbs(): this { this.breadcrumbs = []; return this; }
  addEventProcessor(fn: EventProcessor): this { this.processors.push(fn); return this; }

  clone(): Scope {
    const s = new Scope();
    s.tags = { ...this.tags };
    s.extra = { ...this.extra };
    s.contexts = JSON.parse(JSON.stringify(this.contexts));
    s.user = this.user ? { ...this.user } : undefined;
    s.level = this.level;
    s.fingerprint = this.fingerprint ? [...this.fingerprint] : undefined;
    s.transactionName = this.transactionName;
    s.request = this.request;
    s.breadcrumbs = [...this.breadcrumbs];
    s.maxBreadcrumbs = this.maxBreadcrumbs;
    s.span = this.span;
    s.processors = [...this.processors];
    s.traceId = this.traceId;
    s.parentSpanId = this.parentSpanId;
    return s;
  }

  /** Merges this scope into the event; fields already on the event win. */
  apply(event: ErrorLensEvent, hint: EventHint): ErrorLensEvent | null {
    if (Object.keys(this.tags).length) event.tags = { ...this.tags, ...event.tags };
    if (Object.keys(this.extra).length) event.extra = { ...this.extra, ...event.extra };
    for (const [k, v] of Object.entries(this.contexts)) {
      event.contexts = event.contexts || {};
      if (!event.contexts[k]) event.contexts[k] = { ...v };
    }
    if (this.user && !event.user) event.user = { ...this.user };
    if (this.level && !event.level) event.level = this.level;
    if (this.fingerprint && !event.fingerprint) event.fingerprint = [...this.fingerprint];
    if (this.transactionName && !event.transaction) event.transaction = this.transactionName;
    if (this.request && !event.request) event.request = { ...this.request };
    if (this.breadcrumbs.length && event.type !== "transaction") {
      event.breadcrumbs = { values: [...this.breadcrumbs, ...(event.breadcrumbs?.values || [])] };
    }
    let out: ErrorLensEvent | null = event;
    for (const p of this.processors) {
      out = p(out, hint);
      if (!out) return null;
    }
    return out;
  }
}

/** Where the active scopes live: per request in Node (AsyncLocalStorage), per page in browsers. */
export interface ScopeStore {
  isolation(): Scope;
  current(): Scope;
  /** Runs fn with a fresh isolation scope (and current scope) — one per request or task. */
  withIsolation<T>(fn: () => T, freshBreadcrumbs?: boolean): T;
  /** Runs fn with the given current scope. */
  withCurrent<T>(scope: Scope, fn: () => T): T;
}

/** Synchronous store for single-context environments (browsers). */
export class StackScopeStore implements ScopeStore {
  private iso = new Scope();
  private cur = new Scope();

  isolation(): Scope { return this.iso; }
  current(): Scope { return this.cur; }

  withIsolation<T>(fn: () => T, freshBreadcrumbs = false): T {
    const [prevIso, prevCur] = [this.iso, this.cur];
    this.iso = prevIso.clone();
    if (freshBreadcrumbs) this.iso.clearBreadcrumbs();
    this.cur = prevCur.clone();
    try {
      return fn();
    } finally {
      this.iso = prevIso;
      this.cur = prevCur;
    }
  }

  withCurrent<T>(scope: Scope, fn: () => T): T {
    const prev = this.cur;
    this.cur = scope;
    try {
      return fn();
    } finally {
      this.cur = prev;
    }
  }
}
