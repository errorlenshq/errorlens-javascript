/** One-line error reporting for popular frameworks. Requests are already isolated and traced by the http integration. */
import { setRequestRoute } from "./http.js";
import { active } from "./util.js";

function status(err: any): number | undefined {
  const s = err?.status ?? err?.statusCode ?? err?.output?.statusCode;
  return typeof s === "number" ? s : undefined;
}

/** Reports errors that reach the framework, except 4xx client errors. */
function report(err: unknown, framework: string): void {
  const s = status(err);
  if (s !== undefined && s < 500) return;
  active()?.captureException(err, {}, { type: framework, handled: false });
}

/**
 * Express (4 and 5). Call after all routes and before your own error handlers:
 *   ErrorLens.setupExpressErrorHandler(app);
 */
export function setupExpressErrorHandler(app: { use: (...args: any[]) => unknown }): void {
  app.use(function errorlensErrorHandler(err: unknown, _req: unknown, _res: unknown, next: (e?: unknown) => void) {
    report(err, "express");
    next(err);
  });
}

/** Fastify: names transactions after routes and reports handler errors.  ErrorLens.setupFastifyErrorHandler(fastify); */
export function setupFastifyErrorHandler(fastify: { addHook: (...args: any[]) => unknown }): void {
  fastify.addHook("onRequest", (request: any, _reply: unknown, done: () => void) => {
    const route = request.routeOptions?.url ?? request.routerPath;
    if (route) setRequestRoute(request.raw, `${request.method} ${route}`);
    done();
  });
  fastify.addHook("onError", (_request: unknown, _reply: unknown, error: unknown, done: () => void) => {
    report(error, "fastify");
    done();
  });
}

/** Koa: add before other middleware.  ErrorLens.setupKoaErrorHandler(app); */
export function setupKoaErrorHandler(app: { use: (fn: any) => unknown; middleware?: unknown[] }): void {
  const name = (ctx: any) => { if (ctx._matchedRoute) setRequestRoute(ctx.req, `${ctx.method} ${ctx._matchedRoute}`); };
  const mw = async (ctx: any, next: () => Promise<unknown>) => {
    try {
      await next();
    } catch (err) {
      name(ctx);
      report(err, "koa");
      throw err;
    }
    name(ctx);
  };
  // Run first, so errors from every other middleware pass through it.
  if (Array.isArray(app.middleware)) app.middleware.unshift(mw);
  else app.use(mw);
}

/** Hapi: await ErrorLens.setupHapiErrorHandler(server); */
export async function setupHapiErrorHandler(server: any): Promise<void> {
  server.ext("onPreResponse", (request: any, h: any) => {
    if (request.route?.path) setRequestRoute(request.raw?.req, `${request.method.toUpperCase()} ${request.route.path}`);
    const r = request.response;
    if (r && r.isBoom && (r.output?.statusCode ?? 500) >= 500) report(r, "hapi");
    return h.continue;
  });
}
