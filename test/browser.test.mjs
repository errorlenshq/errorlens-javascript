// Runs the <script> build in real Chrome against a cross-origin fake ingest server.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { test } from "node:test";
import { fakeServer } from "./helpers.mjs";

const CHROME = process.env.CHROME_PATH || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find((p) => existsSync(p));

const bundle = new URL("../packages/browser/dist/errorlens.min.js", import.meta.url);

test("browser SDK in Chrome", { skip: !CHROME && "no Chrome found (set CHROME_PATH)" }, async () => {
  const { default: puppeteer } = await import("puppeteer-core");
  const ingest = await fakeServer();
  const apiHeaders = [];
  const page = (dsn) => `<!doctype html><html><head>
<meta name="traceparent" content="00-11111111111111111111111111111111-2222222222222222-01">
<script src="/errorlens.min.js"></script>
<script>
  ErrorLens.init({ dsn: ${JSON.stringify(dsn)}, release: "web@1.0.0", tracesSampleRate: 1, enableLogs: true });
  ErrorLens.setUser({ id: "u1" });
</script></head><body>
<button id="buy" class="btn primary" data-testid="buy-button">Buy</button>
<script>
  document.getElementById("buy").addEventListener("click", async () => {
    await fetch("/api/data?token=secret");
    history.pushState({}, "", "/checkout");
    console.log("checkout started", { step: 1 });
    setTimeout(() => { throw new TypeError("checkout exploded"); }, 0);
  });
  window.rejectSoon = () => Promise.reject(new Error("rejected in page"));
  window.extensionError = () => {
    const e = new Error("from an extension");
    e.stack = "Error: from an extension\\n    at foo (chrome-extension://abcdef/content.js:1:1)";
    ErrorLens.captureException(e);
  };
</script></body></html>`;
  const site = http.createServer((req, res) => {
    if (req.url === "/errorlens.min.js") { res.writeHead(200, { "Content-Type": "text/javascript" }); res.end(readFileSync(bundle)); return; }
    if (req.url.startsWith("/api/")) { apiHeaders.push(req.headers); res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); return; }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(page(ingest.dsn));
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  try {
    const tab = await browser.newPage();
    const pageErrors = [];
    tab.on("console", (m) => { if (m.type() === "error" && !/checkout exploded|rejected in page/.test(m.text())) pageErrors.push(m.text()); });
    await tab.goto(`http://127.0.0.1:${site.address().port}/shop`, { waitUntil: "load" });
    await tab.click("#buy");
    assert.ok(await ingest.waitFor(() => ingest.items("event").some((e) => /checkout exploded/.test(JSON.stringify(e)))), "error event");
    await tab.evaluate(() => { window.rejectSoon(); window.extensionError(); });
    assert.ok(await ingest.waitFor(() => ingest.items("event").length >= 2), "rejection event");
    assert.ok(await ingest.waitFor(() => ingest.items("transaction").some((t) => t.contexts.trace.op === "pageload"), 6000), "pageload transaction");
    // Hiding the page flushes buffered logs.
    await tab.evaluate(() => ErrorLens.flush(2000));
    await ingest.waitFor(() => ingest.items("log").length > 0, 3000);

    // Simple CORS request: key in the URL, text/plain body, no preflight.
    assert.ok(ingest.requests.every((r) => r.method === "POST"), "no OPTIONS preflight");
    assert.match(ingest.requests[0].url, /^\/api\/42\/envelope\/\?key=testkey123$/);

    const events = ingest.items("event");
    const err = events.find((e) => /checkout exploded/.test(JSON.stringify(e)));
    const ex = err.exception.values.at(-1);
    assert.equal(ex.type, "TypeError");
    assert.equal(ex.mechanism.type, "onerror");
    assert.equal(ex.mechanism.handled, false);
    assert.equal(err.sdk.name, "errorlens.javascript.browser");
    assert.equal(err.release, "web@1.0.0");
    assert.equal(err.user.id, "u1");
    assert.equal(err.contexts.browser.name.length > 0, true);
    assert.match(err.request.url, /\/checkout$/);
    assert.ok(err.request.headers["User-Agent"]);
    assert.ok(ex.stacktrace.frames.some((f) => f.in_app), "page frames are in_app");

    const crumbs = err.breadcrumbs.values;
    const click = crumbs.find((c) => c.category === "ui.click");
    assert.match(click.message, /button#buy\.btn\.primary\[data-testid="buy-button"\]/);
    const f = crumbs.find((c) => c.category === "fetch");
    assert.equal(f.data.status_code, 200);
    assert.ok(!f.data.url.includes("token"), "query string dropped from breadcrumbs");
    assert.ok(crumbs.some((c) => c.category === "navigation" && /\/checkout$/.test(c.data.to)));
    assert.ok(crumbs.some((c) => c.category === "console" && /checkout started/.test(c.message)));
    assert.ok(!crumbs.some((c) => /\/api\/42\/envelope/.test(JSON.stringify(c))), "SDK's own requests are not recorded");

    const rej = events.find((e) => /rejected in page/.test(JSON.stringify(e)));
    assert.equal(rej.exception.values.at(-1).mechanism.type, "onunhandledrejection");
    assert.ok(!events.some((e) => /from an extension/.test(JSON.stringify(e))), "extension errors dropped");

    // Same-origin request got the page's trace; the page load continued the server's trace.
    assert.match(apiHeaders[0].traceparent, /^00-11111111111111111111111111111111-[0-9a-f]{16}-01$/);
    const pl = ingest.items("transaction").find((t) => t.contexts.trace.op === "pageload");
    assert.equal(pl.contexts.trace.trace_id, "11111111111111111111111111111111");
    assert.equal(pl.contexts.trace.parent_span_id, "2222222222222222");
    assert.equal(pl.transaction, "/shop");
    assert.ok(pl.spans.some((s) => s.op === "browser" && s.description === "request"), "navigation timing spans");
    assert.ok(pl.spans.some((s) => s.op === "resource.script"), "resource spans");
    assert.ok(pl.spans.some((s) => s.op === "http.client" && /\/api\/data$/.test(s.description)), "fetch span");

    assert.deepEqual(pageErrors, [], "the SDK itself logged no errors");
  } finally {
    await browser.close();
    site.close();
    await ingest.close();
  }
});
