/**
 * fetch with keepalive, so reports survive the page being closed. The key goes in
 * the URL and the body is sent as text/plain: a "simple" request, with no CORS
 * preflight round trip.
 */
const KEEPALIVE_LIMIT = 60_000; // browsers cap keepalive bodies at 64 KiB in total
let keepaliveInFlight = 0;

const realFetch: typeof fetch | undefined =
  typeof fetch === "function" ? fetch.bind(globalThis) : undefined;

export function browserTransport(url: string, body: string | Uint8Array, headers: Record<string, string>) {
  const size = typeof body === "string" ? body.length * 2 : body.byteLength;
  const keepalive = keepaliveInFlight + size <= KEEPALIVE_LIMIT;
  const target = `${url}?key=${encodeURIComponent(headers["X-ErrorLens-Key"] || "")}`;
  if (!realFetch) return Promise.reject(new Error("fetch is not available"));
  const send = (attempt: number): Promise<{ status: number; headers: Record<string, string | null> }> => {
    const ka = attempt === 0 && keepalive;
    if (ka) keepaliveInFlight += size;
    return realFetch(target, {
      method: "POST",
      body: body as BodyInit,
      keepalive: ka,
      credentials: "omit",
      referrerPolicy: "origin",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
    })
      .then((res) => ({ status: res.status, headers: { "retry-after": res.headers.get("retry-after") } }))
      .catch((err: unknown) => {
        // A network failure (offline blip, a dropped HTTP/3 connection) gets one more try on a fresh request.
        // HTTP errors are answers, not failures, and are never retried.
        if (attempt > 0 || (typeof navigator !== "undefined" && navigator.onLine === false)) throw err;
        return new Promise((r) => setTimeout(r, 1500)).then(() => send(attempt + 1));
      })
      .finally(() => { if (ka) keepaliveInFlight -= size; });
  };
  return send(0);
}
