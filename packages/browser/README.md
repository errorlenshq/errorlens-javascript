# @errorlenshq/browser

ErrorLens for the browser: errors, breadcrumbs, page-load and navigation tracing, web vitals and logs. No dependencies; 12 KB gzipped.

```bash
npm install @errorlenshq/browser
```

```js
import * as ErrorLens from "@errorlenshq/browser";

ErrorLens.init({
  dsn: "https://<key>@errorlens.io/<project-id>",
  release: "web@1.4.0",
  tracesSampleRate: 0.1,
});
```

Or with a script tag (sets `window.ErrorLens`):

```html
<script src="https://cdn.jsdelivr.net/npm/@errorlenshq/browser@1/dist/errorlens.min.js" crossorigin="anonymous"></script>
<script>ErrorLens.init({ dsn: "https://<key>@errorlens.io/<project-id>" });</script>
```

## What you get automatically

- **Uncaught errors and unhandled promise rejections.**
- **Breadcrumbs**: clicks and typing (with a readable element path), `fetch`/XHR requests, history navigation, console output.
- **Tracing** (with `tracesSampleRate`): a page-load transaction with navigation-timing and resource spans and web vitals (LCP, FCP, CLS), a transaction per single-page-app route change, and spans for `fetch`/XHR calls.
- **Distributed traces**: same-origin requests get a `traceparent` header. To include other origins, list them in `tracePropagationTargets` (they must allow the header in CORS). To link a page load to the server request that rendered it, render `<meta name="traceparent" content="…">` (`getTraceparent()` in `@errorlenshq/node`).
- **Noise filtered**: errors from browser extensions, cross-origin "Script error.", and `ResizeObserver` loop warnings are dropped. Use `allowUrls`/`denyUrls` to report only your own scripts.
- **Reliable delivery**: reports use `fetch` with `keepalive` and are flushed when the tab is hidden, so errors right before navigation still arrive. Requests are CORS "simple" requests — no preflight round trip.

## Capturing

```js
ErrorLens.captureException(err);
ErrorLens.captureMessage("Checkout took too long", "warning");
ErrorLens.setUser({ id: "42" });
ErrorLens.setTag("ab_test", "new-checkout");

const onClick = ErrorLens.wrap(() => riskyThing());

await ErrorLens.startSpan({ name: "render chart", op: "ui.render" }, () => drawChart(data));

ErrorLens.logger.warn("Cart {cartId} is slow", { cartId: 7 });  // needs enableLogs: true
```

## Options

Same as `@errorlenshq/node` (`sampleRate`, `tracesSampleRate`, `tracePropagationTargets`, `enableLogs`, `consoleLogs`, `ignoreErrors`, `beforeSend`, `beforeBreadcrumb`, `maxBreadcrumbs`, `sendDefaultPii`…) plus:

| Option | |
|---|---|
| `allowUrls` | Only report errors from scripts matching these strings/regexes |
| `denyUrls` | Drop errors from scripts matching these |
| `disabledIntegrations` | Any of `globalHandlers`, `dom`, `history`, `console`, `fetch`, `xhr`, `pageload` |

## License

MIT
