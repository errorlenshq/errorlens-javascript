# @errorlenshq/core

The shared core of the ErrorLens JavaScript SDKs: event pipeline, scopes, tracing, scrubbing and the envelope transport protocol.

You don't install this directly — use [`@errorlenshq/node`](https://www.npmjs.com/package/@errorlenshq/node) or [`@errorlenshq/browser`](https://www.npmjs.com/package/@errorlenshq/browser). It is useful on its own for other runtimes (Deno, Bun, edge workers): create a `Client` with your own `ScopeStore`, platform hooks and `transport`, then call `setClient(client)`.

MIT licensed.
