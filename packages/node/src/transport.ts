import { gzipSync } from "node:zlib";
import { VERSION } from "./version.js";

// Captured before the fetch integration wraps globalThis.fetch, so the SDK's
// own uploads are never traced or recorded as breadcrumbs.
const realFetch: typeof fetch | undefined = globalThis.fetch?.bind(globalThis);

export function nodeTransport(url: string, body: string | Uint8Array, headers: Record<string, string>) {
  if (!realFetch) return Promise.reject(new Error("ErrorLens needs Node.js 18 or newer (global fetch)"));
  return realFetch(url, {
    method: "POST",
    body: gzipSync(typeof body === "string" ? Buffer.from(body) : body),
    headers: { ...headers, "Content-Encoding": "gzip", "User-Agent": `errorlens-node/${VERSION}` },
    signal: AbortSignal.timeout(10_000),
  }).then(async (res) => {
    await res.arrayBuffer().catch(() => undefined);
    return { status: res.status, headers: { "retry-after": res.headers.get("retry-after") } };
  });
}
