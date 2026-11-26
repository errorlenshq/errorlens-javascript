/** Shapes of the data the SDK sends. */

export type Level = "debug" | "info" | "warning" | "error" | "fatal";
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface StackFrame {
  filename?: string;
  abs_path?: string;
  function?: string;
  module?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
  pre_context?: string[];
  context_line?: string;
  post_context?: string[];
}

export interface Mechanism {
  type: string;
  handled: boolean;
  [key: string]: unknown;
}

export interface ExceptionValue {
  type: string;
  value: string;
  stacktrace?: { frames: StackFrame[] };
  mechanism?: Mechanism;
}

export interface Breadcrumb {
  type?: string;
  category?: string;
  message?: string;
  level?: Level;
  data?: Record<string, unknown>;
  timestamp?: number;
}

export interface User {
  id?: string | number;
  email?: string;
  username?: string;
  ip_address?: string;
  [key: string]: unknown;
}

export interface ErrorLensEvent {
  event_id?: string;
  type?: "transaction";
  timestamp?: number;
  start_timestamp?: number;
  platform?: string;
  level?: Level;
  message?: string;
  logger?: string;
  transaction?: string;
  release?: string;
  environment?: string;
  server_name?: string;
  exception?: { values: ExceptionValue[] };
  breadcrumbs?: { values: Breadcrumb[] };
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, Record<string, unknown>>;
  user?: User;
  request?: Record<string, unknown>;
  fingerprint?: string[];
  spans?: Record<string, unknown>[];
  sdk?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface EventHint {
  originalException?: unknown;
  [key: string]: unknown;
}

export interface LogRecord {
  timestamp: number;
  trace_id: string;
  level: LogLevel;
  severity_number: number;
  body: string;
  attributes: Record<string, unknown>;
}

export interface MonitorConfig {
  schedule: { type: "crontab"; value: string } | { type: "interval"; value: number; unit: "minute" | "hour" | "day" };
  checkinMargin?: number;
  maxRuntime?: number;
  timezone?: string;
}

export interface Options {
  /** Where to send data: https://<key>@errorlens.io/<project-id>. Without it the SDK does nothing. */
  dsn?: string;
  release?: string;
  environment?: string;
  serverName?: string;
  enabled?: boolean;
  debug?: boolean;
  /** Share of errors to send, 0–1. */
  sampleRate?: number;
  /** Share of requests/page loads to trace, 0–1. Off when unset. */
  tracesSampleRate?: number;
  tracesSampler?: (context: { name: string; op: string; parentSampled?: boolean; [k: string]: unknown }) => number | boolean;
  /** URL patterns that receive the traceparent header. Default: same origin in browsers, everything in Node. */
  tracePropagationTargets?: (string | RegExp)[];
  enableLogs?: boolean;
  /** Personal data (IP address, cookies, request bodies). Off by default. */
  sendDefaultPii?: boolean;
  scrubFields?: string[];
  safeFields?: string[];
  ignoreErrors?: (string | RegExp)[];
  maxBreadcrumbs?: number;
  attachStacktrace?: boolean;
  beforeSend?: (event: ErrorLensEvent, hint: EventHint) => ErrorLensEvent | null;
  beforeSendTransaction?: (event: ErrorLensEvent) => ErrorLensEvent | null;
  beforeBreadcrumb?: (crumb: Breadcrumb, hint?: Record<string, unknown>) => Breadcrumb | null;
  beforeSendLog?: (log: LogRecord) => LogRecord | null;
  /** Integrations to turn off by name, e.g. ["console"]. */
  disabledIntegrations?: string[];
  /** Maximum requests waiting to be sent. */
  maxQueueSize?: number;
  /** Replace the network layer (tests, proxies, custom runtimes). */
  transport?: (url: string, body: string | Uint8Array, headers: Record<string, string>) => Promise<{ status: number; headers: Record<string, string | null> }>;
  /** Used by the SDK packages. */
  _sdk?: { name: string; version: string; platform: string };
}
