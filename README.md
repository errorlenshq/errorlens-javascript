# ErrorLens JavaScript SDKs

Error tracking, performance tracing, logs and cron monitoring for JavaScript, for [ErrorLens](https://errorlens.io) — hosted or self-hosted.

| Package | |
|---|---|
| [`@errorlenshq/node`](packages/node) | Node.js 18+: Express, Fastify, Koa, Hapi, plain `http`, serverless |
| [`@errorlenshq/browser`](packages/browser) | Browsers and single-page apps (React, Vue, Angular, Svelte…) |
| [`@errorlenshq/core`](packages/core) | Shared core, for other runtimes |

- No runtime dependencies.
- ES modules and CommonJS, with TypeScript types.
- W3C trace context (`traceparent`), so traces connect across Node, Python and browsers.
- Secrets are scrubbed in the SDK, before data leaves your app.

```js
import * as ErrorLens from "@errorlenshq/node";
ErrorLens.init({ dsn: process.env.ERRORLENS_DSN, tracesSampleRate: 0.2 });
```

Documentation: https://errorlens.io/docs/

## Development

```bash
npm install
npm test
```

Tests start real apps (Express, Fastify, Koa, Hapi, plain `http`) in child processes against a fake ingest server, and run the browser bundle in Chrome (set `CHROME_PATH` if it isn't found).

## License

MIT
