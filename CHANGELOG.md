# Changelog

All three packages (`@errorlenshq/core`, `@errorlenshq/node`, `@errorlenshq/browser`) share one version.

## 1.0.4

- Browser: reports that can't be sent because of the network (offline, a dropped mobile or HTTP/3 connection) are kept in `localStorage` (up to 30, for 24 hours) and sent 30 seconds later, when the browser is back online, or on the next page load. `offlineQueue: false` turns this off.

## 1.0.3

- Browser: a report whose upload fails because of the network is retried once. HTTP error answers are never retried.
- Stack traces keep function names from code run by `eval` / `new Function` (marked as not your own code).
- `allowUrls` / `denyUrls` judge real script URLs only.

## 1.0.2

- Every package exports `./package.json`, for bundlers and version checks.

## 1.0.1

- First release published from GitHub Actions with npm provenance.

## 1.0.0

- First release: errors, breadcrumbs, scopes, tracing with W3C `traceparent`, structured logs, cron monitors and secret scrubbing for Node.js (Express, Fastify, Koa, Hapi, serverless) and browsers. No dependencies.
