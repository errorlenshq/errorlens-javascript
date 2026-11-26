/**
 * ErrorLens for browsers.
 *
 *   import * as ErrorLens from "@errorlenshq/browser";
 *   ErrorLens.init({ dsn: "https://<key>@errorlens.io/<project>", tracesSampleRate: 0.1 });
 */
import { Client, StackScopeStore, getClient, setClient, type ErrorLensEvent, type Options } from "@errorlenshq/core";
import {
  instrumentConsole, instrumentDom, instrumentFetch, instrumentGlobalHandlers, instrumentHistory,
  instrumentPageLoad, instrumentXhr, navigationTracer,
} from "./integrations.js";
import { browserTransport } from "./transport.js";

export * from "@errorlenshq/core";
export const VERSION = "1.0.2";

export interface BrowserOptions extends Options {
  /** Send console.* output as logs too (needs enableLogs). Breadcrumbs are always recorded. */
  consoleLogs?: boolean;
  /** Script URLs whose errors are reported. Default: all. */
  allowUrls?: (string | RegExp)[];
  /** Script URLs whose errors are dropped (in addition to browser extensions). */
  denyUrls?: (string | RegExp)[];
}

const EXTENSION = /^(?:chrome|moz|safari(?:-web)?|ms-browser)-extension:\/\/|^webkit-masked-url:/;
// Noise every site sees and nobody can fix.
const DEFAULT_IGNORE = [
  /^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/,
  /^Script error\.?$/,
  "Non-Error promise rejection captured with value: Object Not Found Matching Id:",
];

function inApp(filename: string): boolean {
  if (!filename || EXTENSION.test(filename) || /\/node_modules\//.test(filename)) return false;
  try { return new URL(filename, location.href).origin === location.origin; } catch { return false; }
}

function browserContexts(): Record<string, Record<string, unknown>> {
  const ua = navigator.userAgent;
  const nav = navigator as Navigator & { userAgentData?: { brands?: { brand: string; version: string }[]; platform?: string; mobile?: boolean } };
  const brand = nav.userAgentData?.brands?.find((b) => !/Not.?A.?Brand|Chromium/i.test(b.brand));
  const browser = brand ? { name: brand.brand, version: brand.version } : parseUa(ua);
  return {
    browser,
    os: { name: nav.userAgentData?.platform || osFromUa(ua) },
    device: { screen_resolution: `${screen.width}x${screen.height}`, mobile: nav.userAgentData?.mobile ?? /Mobi/.test(ua), online: navigator.onLine },
  };
}

function parseUa(ua: string): { name: string; version?: string } {
  for (const [name, re] of [["Edge", /Edg\/([\d.]+)/], ["Opera", /OPR\/([\d.]+)/], ["Firefox", /Firefox\/([\d.]+)/],
    ["Chrome", /Chrome\/([\d.]+)/], ["Safari", /Version\/([\d.]+).*Safari/]] as [string, RegExp][]) {
    const m = re.exec(ua);
    if (m) return { name, version: m[1] };
  }
  return { name: "Unknown" };
}

function osFromUa(ua: string): string {
  if (/Windows/.test(ua)) return "Windows";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Android/.test(ua)) return "Android";
  if (/Linux/.test(ua)) return "Linux";
  return "Unknown";
}

function frameUrls(event: ErrorLensEvent): string[] {
  const out: string[] = [];
  // frames with a real script URL only (not "<anonymous>" eval code), so allow/deny lists judge the script that failed
  for (const v of event.exception?.values || []) for (const f of v.stacktrace?.frames || []) {
    const url = f.abs_path || f.filename;
    if (url && /^(https?|blob|file|chrome-extension|moz-extension|safari(-web)?-extension):/.test(url)) out.push(url);
  }
  return out;
}

let installed = false;

/** Starts the SDK. Without a DSN it does nothing. Call it as early as possible. */
export function init(options: BrowserOptions = {}): Client {
  const opts: BrowserOptions = {
    transport: browserTransport,
    ...options,
    ignoreErrors: [...DEFAULT_IGNORE, ...(options.ignoreErrors || [])],
    _sdk: { name: "errorlens.javascript.browser", version: VERSION, platform: "javascript" },
  };
  const client = new Client(opts, new StackScopeStore(), {
    inApp,
    contexts: browserContexts,
    enrich(event) {
      event.request = { url: location.href, headers: { "User-Agent": navigator.userAgent, ...(document.referrer ? { Referer: document.referrer } : {}) }, ...event.request };
    },
  });
  // Drop errors thrown by browser extensions, and apply allow/deny lists.
  client.globalScope.addEventProcessor((event) => {
    if (event.type === "transaction") return event;
    const urls = frameUrls(event);
    const last = urls[urls.length - 1];
    if (urls.some((u) => EXTENSION.test(u))) return null;
    if (last && opts.denyUrls?.some((p) => (typeof p === "string" ? last.includes(p) : p.test(last)))) return null;
    if (last && opts.allowUrls?.length && !opts.allowUrls.some((p) => (typeof p === "string" ? last.includes(p) : p.test(last)))) return null;
    return event;
  });
  const disabled = new Set(opts.disabledIntegrations || []);
  const names = ["globalHandlers", "dom", "history", "console", "fetch", "xhr", "pageload"].filter((n) => !disabled.has(n));
  client.integrations = names;
  setClient(client);
  if (!client.active || typeof window === "undefined") return client;
  if (!installed) {
    installed = true;
    if (names.includes("globalHandlers")) instrumentGlobalHandlers();
    if (names.includes("dom")) instrumentDom();
    const tracing = opts.tracesSampleRate !== undefined || !!opts.tracesSampler;
    if (names.includes("history")) instrumentHistory(tracing && names.includes("pageload") ? navigationTracer(client) : undefined);
    if (names.includes("console")) instrumentConsole(!!opts.consoleLogs && !!opts.enableLogs);
    if (names.includes("fetch")) instrumentFetch();
    if (names.includes("xhr")) instrumentXhr();
    if (tracing && names.includes("pageload")) instrumentPageLoad(client);
    // Send what is queued when the tab is hidden or closed (keepalive lets it finish).
    addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void client.flush(0); });
  }
  return client;
}

/** Wraps a function so anything it throws is reported (then rethrown). */
export function wrap<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return function (this: unknown, ...args: A): R {
    try {
      return fn.apply(this, args);
    } catch (e) {
      getClient()?.captureException(e, {}, { type: "wrap", handled: false });
      throw e;
    }
  };
}
