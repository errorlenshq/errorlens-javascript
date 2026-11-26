// Plain node:http server; each request sets its own user, calls a downstream service and fails.
import http from "node:http";
import * as ErrorLens from "@errorlenshq/node";

ErrorLens.init({ tracesSampleRate: 1 });

const seen = [];
const downstream = http.createServer((req, res) => { seen.push(req.headers.traceparent || null); res.end("ok"); });
await new Promise((r) => downstream.listen(0, "127.0.0.1", r));
const dPort = downstream.address().port;

const app = http.createServer(async (req, res) => {
  const user = new URL(req.url, "http://x").searchParams.get("user");
  ErrorLens.setUser({ id: user });
  ErrorLens.addBreadcrumb({ message: `handling ${user}` });
  await new Promise((r) => setTimeout(r, user === "a" ? 50 : 10)); // interleave the two requests
  await new Promise((r) => http.get(`http://127.0.0.1:${dPort}/inventory/${user}`, (dr) => { dr.resume(); dr.on("end", r); }));
  await fetch(`http://127.0.0.1:${dPort}/prices?user=${user}`).then((r) => r.text());
  ErrorLens.captureException(new Error(`failed for ${user}`));
  res.statusCode = 500;
  res.end("error");
});
await new Promise((r) => app.listen(0, "127.0.0.1", r));
const port = app.address().port;

const incoming = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
await Promise.all([
  fetch(`http://127.0.0.1:${port}/orders/123?user=a`, { headers: { traceparent: incoming } }).then((r) => r.text()),
  fetch(`http://127.0.0.1:${port}/orders/456?user=b`).then((r) => r.text()),
]);
await ErrorLens.flush(5000);
console.log(JSON.stringify({ seen }));
app.close(); downstream.close();
