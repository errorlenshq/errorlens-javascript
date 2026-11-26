// A fake ingest server (no SDK loaded in this process) and a runner for fixture apps.
import { spawn } from "node:child_process";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

export const KEY = "testkey123";

export function parseEnvelope(text) {
  const lines = text.split("\n");
  const header = JSON.parse(lines[0]);
  const items = [];
  for (let i = 1; i + 1 < lines.length; i += 2) {
    if (!lines[i]) break;
    items.push({ header: JSON.parse(lines[i]), payload: JSON.parse(lines[i + 1]) });
  }
  return { header, items };
}

/** options.respond(req) may return { status, headers } to simulate rate limits. */
export async function fakeServer(options = {}) {
  const envelopes = [];
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") body = gunzipSync(body);
      requests.push({ method: req.method, url: req.url, headers: req.headers });
      const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
      if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
      if (req.method === "POST" && req.url.includes("/envelope/")) envelopes.push({ ...parseEnvelope(body.toString()), headers: req.headers, url: req.url });
      const r = options.respond?.(req) || { status: 200, headers: {} };
      res.writeHead(r.status, { ...cors, ...r.headers, "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const items = (type) => envelopes.flatMap((e) => e.items).filter((i) => !type || i.header.type === type).map((i) => i.payload);
  return {
    port, envelopes, requests, items,
    dsn: `http://${KEY}@127.0.0.1:${port}/42`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    async waitFor(pred, ms = 5000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 20)); }
      return false;
    },
  };
}

/** Runs test/fixtures/<name> with the DSN; resolves with exit code and output. */
export function runFixture(name, env = {}, args = []) {
  const file = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...args, file], { env: { ...process.env, NODE_OPTIONS: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
    child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}
