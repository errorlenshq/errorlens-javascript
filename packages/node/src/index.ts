/**
 * ErrorLens for Node.js.
 *
 *   import * as ErrorLens from "@errorlenshq/node";
 *   ErrorLens.init({ dsn: process.env.ERRORLENS_DSN, tracesSampleRate: 0.2 });
 */
import * as os from "node:os";
import { Client, getClient, setClient, type ErrorLensEvent, type EventHint, type Options } from "@errorlenshq/core";
import { addSourceContext, inApp, nodeContexts } from "./context.js";
import { instrumentConsole } from "./console.js";
import { instrumentFetch } from "./fetch.js";
import { instrumentHttpClient, instrumentHttpServer, setRequestRoute } from "./http.js";
import { instrumentProcess } from "./process.js";
import { AsyncScopeStore } from "./store.js";
import { nodeTransport } from "./transport.js";
import { VERSION } from "./version.js";

export * from "@errorlenshq/core";
export { setupExpressErrorHandler, setupFastifyErrorHandler, setupKoaErrorHandler, setupHapiErrorHandler } from "./frameworks.js";
export { AsyncScopeStore, VERSION };

export interface NodeOptions extends Options {
  /** Send console.* output as logs too (needs enableLogs). Breadcrumbs are always recorded. */
  consoleLogs?: boolean;
  /** Add the source lines around each frame of your own code. Default true. */
  includeSourceContext?: boolean;
  /** Called instead of exiting after an uncaught error has been reported. */
  onFatalError?: (error: unknown) => void;
}

const RELEASE_VARS = ["ERRORLENS_RELEASE", "GITHUB_SHA", "CI_COMMIT_SHA", "VERCEL_GIT_COMMIT_SHA", "RENDER_GIT_COMMIT",
  "HEROKU_SLUG_COMMIT", "RAILWAY_GIT_COMMIT_SHA", "CF_PAGES_COMMIT_SHA", "SOURCE_VERSION", "COMMIT_SHA", "GIT_COMMIT"];

function detectRelease(): string | undefined {
  for (const v of RELEASE_VARS) if (process.env[v]) return process.env[v];
  return undefined;
}

let integrationsInstalled = false;

/** Starts the SDK. Without a DSN (or ERRORLENS_DSN) it does nothing, so it is safe to call everywhere. */
export function init(options: NodeOptions = {}): Client {
  const opts: NodeOptions = {
    dsn: process.env.ERRORLENS_DSN,
    release: detectRelease(),
    environment: process.env.ERRORLENS_ENVIRONMENT || process.env.NODE_ENV || "production",
    serverName: os.hostname(),
    transport: nodeTransport,
    ...options,
    _sdk: { name: "errorlens.javascript.node", version: VERSION, platform: "node" },
  };
  if (opts.tracesSampleRate === undefined && process.env.ERRORLENS_TRACES_SAMPLE_RATE) {
    opts.tracesSampleRate = Number(process.env.ERRORLENS_TRACES_SAMPLE_RATE);
  }
  const sourceContext = opts.includeSourceContext !== false;
  const client = new Client(opts, new AsyncScopeStore(), {
    inApp,
    contexts: nodeContexts,
    enrich: (event: ErrorLensEvent, _hint: EventHint) => { if (sourceContext) addSourceContext(event); },
  });
  const disabled = new Set(opts.disabledIntegrations || []);
  const names = ["process", "http", "fetch", "console"].filter((n) => !disabled.has(n));
  client.integrations = names;
  setClient(client);
  if (client.active && !integrationsInstalled) {
    // Patches are installed once per process; they do nothing while no client is active.
    integrationsInstalled = true;
    if (names.includes("process")) instrumentProcess(opts.onFatalError);
    if (names.includes("http")) { instrumentHttpClient(); instrumentHttpServer(); }
    if (names.includes("fetch")) instrumentFetch();
    if (names.includes("console")) instrumentConsole(!!opts.consoleLogs && !!opts.enableLogs);
  }
  if (opts.debug) console.info(`[ErrorLens] ${client.active ? "enabled" : "disabled (no DSN)"} — ${names.join(", ")}`);
  return client;
}

/** Names the current request's transaction (when the automatic route name is not what you want). */
export function setTransactionName(name: string, req?: object): void {
  if (req) setRequestRoute(req, name);
  getClient()?.store.isolation().setTransactionName(name);
}

/**
 * Wraps a serverless handler (AWS Lambda, Google Cloud Functions…): each call gets
 * its own scope and data is sent before the function returns.
 */
export function wrapHandler<A extends unknown[], R>(handler: (...args: A) => R | Promise<R>, name?: string): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const c = getClient();
    if (!c?.active) return handler(...args);
    return c.store.withIsolation(async () => {
      const tx = c.startTransaction(name || handler.name || "handler", "function.serverless");
      const scope = c.store.current();
      scope.span = tx;
      try {
        return await handler(...args);
      } catch (e) {
        tx.setStatus("internal_error");
        c.captureException(e, {}, { type: "serverless", handled: false });
        throw e;
      } finally {
        tx.end();
        await c.flush(2000);
      }
    }, true);
  };
}
