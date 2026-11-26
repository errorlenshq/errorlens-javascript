# @errorlenshq/node

ErrorLens for Node.js: errors, performance tracing, structured logs and cron monitors. No dependencies. Node 18+.

```bash
npm install @errorlenshq/node
```

Initialize it before anything else in your app's entry file:

```js
import * as ErrorLens from "@errorlenshq/node";

ErrorLens.init({
  dsn: process.env.ERRORLENS_DSN,   // from your project's settings
  tracesSampleRate: 0.2,            // trace 20% of requests (leave out to turn tracing off)
  enableLogs: true,                 // send ErrorLens.logger.* calls
});
```

CommonJS works too: `const ErrorLens = require("@errorlenshq/node")`.

Without a DSN the SDK does nothing, so it is safe to call `init()` in every environment.

## What you get automatically

- **Uncaught exceptions and unhandled rejections**, reported and flushed before the process exits the way Node normally would (exit code 1, error printed). `--unhandled-rejections=warn|none` is respected.
- **Per-request isolation** for any `http`/`https` server: tags, user and breadcrumbs set while handling a request only appear on that request's events.
- **Request transactions** named after the route (`GET /orders/:id`), continuing incoming W3C `traceparent` headers.
- **Outgoing requests** through `http`, `https` and `fetch`: spans, breadcrumbs and a `traceparent` header, so traces cross services.
- **Console breadcrumbs** (`console.log/info/warn/error/debug`).
- **Source context**: the lines around each frame of your own code.
- **Secret scrubbing** before anything leaves your server: passwords, tokens, API keys, cookies, JWTs, card numbers, and query strings on URLs.

## Frameworks

Requests are already isolated and traced. Add one line to report handler errors (5xx only; 4xx are skipped) and get exact route names:

```js
// Express 4/5: after your routes, before your own error handlers
ErrorLens.setupExpressErrorHandler(app);

// Fastify
ErrorLens.setupFastifyErrorHandler(fastify);

// Koa
ErrorLens.setupKoaErrorHandler(app);

// Hapi
await ErrorLens.setupHapiErrorHandler(server);
```

Serverless functions (AWS Lambda, Google Cloud Functions…): wrap the handler so data is sent before the function freezes.

```js
export const handler = ErrorLens.wrapHandler(async (event) => { /* … */ });
```

## Capturing

```js
try {
  await chargeCard(order);
} catch (err) {
  ErrorLens.captureException(err);   // error.cause chains are included
}

ErrorLens.captureMessage("Payment provider slow", "warning");

ErrorLens.setUser({ id: user.id, email: user.email });
ErrorLens.setTag("plan", "pro");
ErrorLens.setContext("order", { id: order.id, total: order.total });
ErrorLens.addBreadcrumb({ category: "cart", message: "Added item" });

ErrorLens.withScope((scope) => {
  scope.setTag("job", "import");
  ErrorLens.captureException(err);   // tag only on this event
});
```

## Tracing

```js
const rows = await ErrorLens.startSpan({ name: "load orders", op: "db.query" }, () => db.orders.find());
```

Inside a request this is a child span; elsewhere it starts a transaction. For other transports (queues, gRPC) pass `ErrorLens.getTraceHeaders()` along and continue with `startSpan({ name, traceparent, tracestate }, …)`.

## Logs

```js
ErrorLens.logger.info("Order {orderId} paid", { orderId: 42, amount: 19.99 });
```

Logs are batched, linked to the active trace and searchable by attribute. `consoleLogs: true` also sends console output as logs.

## Cron monitors

```js
await ErrorLens.withMonitor("nightly-backup", () => runBackup(), {
  schedule: { type: "crontab", value: "0 2 * * *" },
  maxRuntime: 30, // minutes
});
```

The monitor is created from code; you are alerted when a run fails, takes too long, or doesn't happen.

## Options

| Option | Default | |
|---|---|---|
| `dsn` | `ERRORLENS_DSN` | Where to send data |
| `release` | from `ERRORLENS_RELEASE`, `GITHUB_SHA`, `VERCEL_GIT_COMMIT_SHA`… | Version of your app |
| `environment` | `ERRORLENS_ENVIRONMENT`, `NODE_ENV`, `production` | |
| `sampleRate` | `1` | Share of errors to send |
| `tracesSampleRate` / `tracesSampler` | off | Share of requests to trace |
| `tracePropagationTargets` | all | URL patterns that get `traceparent` |
| `enableLogs` / `consoleLogs` | `false` | Structured logs / console output as logs |
| `sendDefaultPii` | `false` | Include IP addresses, cookies and request bodies |
| `scrubFields` / `safeFields` | | Extra keys to filter / keys never to filter |
| `ignoreErrors` | | Strings or regexes of errors to drop |
| `beforeSend`, `beforeSendTransaction`, `beforeBreadcrumb`, `beforeSendLog` | | Change or drop data (return `null`) |
| `disabledIntegrations` | | Any of `process`, `http`, `fetch`, `console` |
| `includeSourceContext` | `true` | |
| `onFatalError` | exit(1) | Called instead of exiting after an uncaught error |
| `maxBreadcrumbs` | `100` | |
| `maxQueueSize` | `30` | Requests in flight before new data is dropped |
| `debug` | `false` | Log what the SDK does |

Call `await ErrorLens.flush()` before a short-lived script exits (the SDK also flushes when the event loop drains).

## License

MIT
