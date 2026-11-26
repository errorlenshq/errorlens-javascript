import assert from "node:assert/strict";
import { test } from "node:test";
import { KEY, fakeServer, runFixture } from "./helpers.mjs";

const json = (s) => JSON.parse(s.trim().split("\n").pop());

test("errors, messages, scopes, logs, check-ins and spans", async () => {
  const srv = await fakeServer();
  const r = await runFixture("basic.mjs", { ERRORLENS_DSN: srv.dsn });
  await srv.close();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /flushed true/);

  // Transport: gzip, key header, envelope URL.
  const req = srv.requests[0];
  assert.equal(req.url, "/api/42/envelope/");
  assert.equal(req.headers["x-errorlens-key"], KEY);
  assert.equal(req.headers["content-encoding"], "gzip");
  assert.match(req.headers["user-agent"], /^errorlens-node\//);

  const events = srv.items("event");
  const err = events.find((e) => e.exception);
  assert.ok(err, "exception event");
  assert.equal(err.release, "app@1.2.3");
  assert.equal(err.environment, "test");
  assert.equal(err.platform, "node");
  assert.equal(err.sdk.name, "errorlens.javascript.node");
  assert.equal(err.contexts.runtime.name, "node");
  assert.ok(err.contexts.trace.trace_id);
  assert.deepEqual(err.tags, { region: "eu" });
  assert.equal(err.user.id, 7);

  // Cause chain, oldest first.
  const [cause, outer] = err.exception.values;
  assert.equal(cause.type, "SyntaxError");
  assert.equal(outer.type, "Error");
  assert.equal(outer.mechanism.handled, true);
  assert.match(outer.value, /\[Filtered\]/, "secret in the message is scrubbed");
  assert.doesNotMatch(JSON.stringify(err), /sk_live_abcdefghijklmnop1234|hunter2/, "no secrets anywhere");

  // Frames: in_app, relative filename, source context.
  const frame = outer.stacktrace.frames.findLast((f) => f.function === "loadOrder");
  assert.ok(frame, JSON.stringify(outer.stacktrace.frames));
  assert.equal(frame.in_app, true);
  assert.match(frame.filename, /fixtures\/basic\.mjs$/);
  assert.match(frame.context_line, /throw new Error/);
  assert.equal(frame.pre_context.length, 5);

  // Extras scrubbed by key.
  assert.equal(err.extra.config.password, "[Filtered]");
  assert.equal(err.extra.config.apiKey, "[Filtered]");
  assert.equal(err.extra.config.ok, true);

  // Breadcrumbs: manual and console.
  const crumbs = err.breadcrumbs.values;
  assert.ok(crumbs.some((c) => c.category === "auth" && c.message === "signed in"));
  assert.ok(crumbs.some((c) => c.category === "console" && c.level === "warning" && /cache miss/.test(c.message)));

  const msg = events.find((e) => e.message === "hello from tests");
  assert.equal(msg.level, "warning");
  const scoped = events.find((e) => e.message === "scoped message");
  assert.equal(scoped.tags.scoped, "yes");
  assert.equal(msg.tags.scoped, undefined, "withScope changes do not leak");

  // Logs: template, attributes, scrubbing.
  const logs = srv.items("log").flatMap((p) => p.items);
  const log = logs.find((l) => /Order 42 paid by bob/.test(l.body));
  assert.ok(log, JSON.stringify(logs));
  assert.equal(log.level, "info");
  assert.equal(log.attributes["message.template"].value, "Order {orderId} paid by {user}");
  assert.deepEqual(log.attributes.orderId, { value: 42, type: "integer" });
  assert.equal(log.attributes.password.value, "[Filtered]");
  assert.equal(log.attributes["errorlens.release"].value, "app@1.2.3");

  // Check-ins: in_progress then ok, same id, with config.
  const checkins = srv.items("check_in");
  assert.deepEqual(checkins.map((c) => c.status), ["in_progress", "ok"]);
  assert.equal(checkins[0].check_in_id, checkins[1].check_in_id);
  assert.equal(checkins[0].monitor_config.schedule.value, "0 2 * * *");
  assert.ok(checkins[1].duration >= 0.02);

  // startSpan without tracing configured: not sampled, nothing sent.
  assert.equal(srv.items("transaction").length, 0);
});

test("CommonJS require works", async () => {
  const srv = await fakeServer();
  const r = await runFixture("basic.cjs", { ERRORLENS_DSN: srv.dsn });
  await srv.close();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(srv.items("event")[0].exception.values[0].type, "TypeError");
});

test("uncaught exception is reported, then the process exits like Node would", async () => {
  const srv = await fakeServer();
  const r = await runFixture("uncaught.mjs", { ERRORLENS_DSN: srv.dsn });
  await srv.close();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /RangeError: boom uncaught/);
  const ev = srv.items("event")[0];
  assert.equal(ev.level, "fatal");
  assert.equal(ev.exception.values[0].mechanism.handled, false);
  assert.equal(ev.exception.values[0].mechanism.type, "onuncaughtexception");
});

test("unhandled rejection: reported, and fatal by default like Node", async () => {
  const srv = await fakeServer();
  const r = await runFixture("rejection.mjs", { ERRORLENS_DSN: srv.dsn });
  await srv.close();
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.stdout, /still alive/);
  assert.equal(srv.items("event")[0].exception.values[0].mechanism.type, "onunhandledrejection");
});

test("--unhandled-rejections=warn keeps the process alive", async () => {
  const srv = await fakeServer();
  const r = await runFixture("rejection.mjs", { ERRORLENS_DSN: srv.dsn }, ["--unhandled-rejections=warn"]);
  await srv.close();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /still alive/);
  assert.equal(srv.items("event").length, 1);
});

test("without a DSN the SDK does nothing and patches nothing", async () => {
  const r = await runFixture("disabled.mjs", { ERRORLENS_DSN: "" });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(json(r.stdout), { enabled: false, patched: false, id: null });
});

test("http server: per-request isolation, trace continuation and propagation", async () => {
  const srv = await fakeServer();
  const r = await runFixture("http-server.mjs", { ERRORLENS_DSN: srv.dsn });
  await srv.close();
  assert.equal(r.code, 0, r.stderr);
  const { seen } = json(r.stdout);

  const errors = srv.items("event");
  assert.equal(errors.length, 2);
  for (const e of errors) {
    const user = /failed for (\w)/.exec(e.exception.values[0].value)[1];
    assert.equal(e.user.id, user, "each request sees only its own user");
    const mine = e.breadcrumbs.values.filter((c) => /^handling/.test(c.message || ""));
    assert.deepEqual(mine.map((c) => c.message), [`handling ${user}`], "and only its own breadcrumbs");
    assert.equal(e.request.method, "GET");
    assert.match(e.request.url, /\/orders\/\d+$/);
    assert.equal(e.request.query_string, `user=${user}`);
    assert.equal(e.transaction, "GET /orders/:id");
  }

  const all = srv.items("transaction");
  const txs = all.filter((t) => t.transaction === "GET /orders/:id");
  assert.equal(txs.length, 2);
  const a = txs.find((t) => t.spans.some((s) => /inventory\/a/.test(s.description)));
  assert.equal(a.transaction, "GET /orders/:id");
  assert.equal(a.contexts.trace.trace_id, "0af7651916cd43dd8448eb211c80319c", "incoming traceparent continued");
  assert.equal(a.contexts.trace.parent_span_id, "b7ad6b7169203331");
  assert.equal(a.contexts.trace.status, "internal_error");
  const clientSpans = a.spans.filter((s) => s.op === "http.client");
  assert.equal(clientSpans.length, 2, "http.get and fetch both traced");
  assert.ok(clientSpans.every((s) => !s.description.includes("?")), "query strings are dropped");

  // Downstream got traceparent headers belonging to each request's trace.
  assert.equal(seen.length, 4);
  const traceIds = new Set(txs.map((t) => t.contexts.trace.trace_id));
  for (const h of seen) assert.ok(traceIds.has(h.split("-")[1]), h);
  // The downstream service traced its side too, as children of the callers' spans.
  const down = all.filter((t) => t.transaction !== "GET /orders/:id");
  assert.equal(down.length, 4, all.map((t) => t.transaction).join());
  const spanIds = new Set(txs.flatMap((t) => t.spans.map((s) => s.span_id)));
  for (const d of down) assert.ok(spanIds.has(d.contexts.trace.parent_span_id));
  const errA = errors.find((e) => e.user.id === "a");
  assert.equal(errA.contexts.trace.trace_id, a.contexts.trace.trace_id, "error linked to its request's trace");
});

test("Express, Fastify, Koa and Hapi", async () => {
  const srv = await fakeServer();
  const r = await runFixture("frameworks.mjs", { ERRORLENS_DSN: srv.dsn });
  await srv.close();
  assert.equal(r.code, 0, r.stderr);
  const out = json(r.stdout);
  assert.deepEqual(out, { express: [200, 500, 418], fastify: [200, 500], koa: [200, 500], hapi: [200, 500] });

  const errors = srv.items("event").map((e) => `${e.exception.values.at(-1).mechanism.type}: ${e.exception.values.at(-1).value} @ ${e.transaction}`).sort();
  assert.deepEqual(errors, [
    "express: express route failed @ GET /api/fail/:id",
    "fastify: fastify route failed @ GET /boom/:n",
    "hapi: hapi route failed @ GET /crash",
    "koa: koa route failed @ GET /explode/:n",
  ], "5xx errors reported once each, 4xx skipped");

  const names = srv.items("transaction").map((t) => `${t.transaction} ${t.contexts.trace.status}`).sort();
  assert.deepEqual(names, [
    "GET /api/fail/:id internal_error",
    "GET /api/users/:id ok",
    "GET /boom/:n internal_error",
    "GET /crash internal_error",
    "GET /explode/:n internal_error",
    "GET /items/:id ok",
    "GET /teapot invalid_argument",
    "GET /things/:id ok",
    "GET /widgets/{id} ok",
  ]);
});

test("Retry-After pauses sending", async () => {
  let n = 0;
  const srv = await fakeServer({ respond: () => (n++ === 0 ? { status: 429, headers: { "Retry-After": "60" } } : null) });
  const r = await runFixture("ratelimit.mjs", { ERRORLENS_DSN: srv.dsn });
  await srv.close();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(srv.items("event").length, 1);
  assert.deepEqual(json(r.stdout), { dropped: 5 });
});

test("serverless wrapper sends before returning", async () => {
  const srv = await fakeServer();
  const r = await runFixture("serverless.mjs", { ERRORLENS_DSN: srv.dsn });
  await srv.close();
  assert.equal(r.code, 0, r.stderr);
  const [ev] = srv.items("event");
  assert.equal(ev.exception.values[0].value, "lambda failed");
  assert.equal(ev.tags.invocation, "2", "tags from one invocation do not leak into another");
  assert.deepEqual(srv.items("transaction").map((t) => `${t.transaction} ${t.contexts.trace.status}`), ["orders ok", "orders internal_error"]);
});
