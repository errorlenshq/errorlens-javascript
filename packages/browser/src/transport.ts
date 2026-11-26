/**
 * fetch with keepalive, so reports survive the page being closed. The key goes in
 * the URL and the body is sent as text/plain: a "simple" request, with no CORS
 * preflight round trip.
 *
 * Reports that can't be sent because of the network (offline, a dropped mobile or
 * HTTP/3 connection) are retried once, then kept in localStorage and sent again
 * 30 seconds later, when the device comes back online, and on the next page load.
 * HTTP error answers (rate limits, a wrong key) are never retried.
 */
const KEEPALIVE_LIMIT = 60_000; // browsers cap keepalive bodies at 64 KiB in total
const QUEUE_KEY = "errorlens:queue";
const QUEUE_MAX = 30; // reports kept per browser
const QUEUE_ITEM_MAX = 100_000; // characters; bigger reports aren't kept
const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
const LATER_MS = 30_000;

type Result = { status: number; headers: Record<string, string | null> };
type Queued = { url: string; body: string; at: number };

let keepaliveInFlight = 0;
let draining = false;
let laterTimer: ReturnType<typeof setTimeout> | undefined;
let listening = false;
let queueEnabled = true;

/** init({ offlineQueue: false }) turns keeping reports off. */
export function setOfflineQueue(enabled: boolean): void {
  queueEnabled = enabled;
}

const realFetch: typeof fetch | undefined =
  typeof fetch === "function" ? fetch.bind(globalThis) : undefined;

function post(target: string, body: string | Uint8Array, keepalive: boolean): Promise<Result> {
  return realFetch!(target, {
    method: "POST",
    body: body as BodyInit,
    keepalive,
    credentials: "omit",
    referrerPolicy: "origin",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
  }).then((res) => ({ status: res.status, headers: { "retry-after": res.headers.get("retry-after") } }));
}

// --- the queue: localStorage can be missing, full or blocked; every access is guarded -------------

function readQueue(): Queued[] {
  try {
    const items = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]") as Queued[];
    const fresh = items.filter((q) => q && typeof q.url === "string" && typeof q.body === "string" && Date.now() - q.at < QUEUE_TTL_MS);
    return fresh.slice(-QUEUE_MAX);
  } catch {
    return [];
  }
}

function writeQueue(items: Queued[]): void {
  try {
    if (items.length) localStorage.setItem(QUEUE_KEY, JSON.stringify(items.slice(-QUEUE_MAX)));
    else localStorage.removeItem(QUEUE_KEY);
  } catch {
    /* storage full or blocked: the report is lost, the page is not affected */
  }
}

function enqueue(url: string, body: string | Uint8Array): void {
  if (!queueEnabled || typeof body !== "string" || body.length > QUEUE_ITEM_MAX) return;
  writeQueue([...readQueue(), { url, body, at: Date.now() }]);
  scheduleDrain(LATER_MS);
  listen();
}

function scheduleDrain(ms: number): void {
  if (laterTimer || typeof setTimeout === "undefined") return;
  laterTimer = setTimeout(() => {
    laterTimer = undefined;
    void drain();
  }, ms);
}

function listen(): void {
  if (listening || typeof addEventListener !== "function") return;
  listening = true;
  addEventListener("online", () => void drain());
}

/** Sends kept reports, oldest first; stops at the first network failure and keeps the rest. */
export async function drain(): Promise<void> {
  if (draining || !realFetch) return;
  draining = true;
  try {
    for (;;) {
      const [next] = readQueue();
      if (!next) return;
      try {
        await post(next.url, next.body, false);
      } catch {
        scheduleDrain(LATER_MS);
        return; // still offline: try later
      }
      // sent (or answered with an HTTP error, which a retry wouldn't change): drop it
      writeQueue(readQueue().filter((q) => !(q.at === next.at && q.body === next.body)));
    }
  } finally {
    draining = false;
  }
}

/** Starts sending reports kept by an earlier page, once this page has loaded. */
export function startQueue(): void {
  if (typeof addEventListener !== "function") return;
  listen();
  if (!readQueue().length) return;
  const go = () => scheduleDrain(3000);
  if (typeof document !== "undefined" && document.readyState === "complete") go();
  else addEventListener("load", go, { once: true });
}

export function browserTransport(url: string, body: string | Uint8Array, headers: Record<string, string>): Promise<Result> {
  const size = typeof body === "string" ? body.length * 2 : body.byteLength;
  const keepalive = keepaliveInFlight + size <= KEEPALIVE_LIMIT;
  const target = `${url}?key=${encodeURIComponent(headers["X-ErrorLens-Key"] || "")}`;
  if (!realFetch) return Promise.reject(new Error("fetch is not available"));
  const send = (attempt: number): Promise<Result> => {
    const ka = attempt === 0 && keepalive;
    if (ka) keepaliveInFlight += size;
    return post(target, body, ka)
      .then((res) => {
        if (queueEnabled && readQueue().length) scheduleDrain(1000); // the network works again: send what was kept
        return res;
      })
      .catch((err: unknown) => {
        const offline = typeof navigator !== "undefined" && navigator.onLine === false;
        if (attempt === 0 && !offline) return new Promise<void>((r) => setTimeout(r, 1500)).then(() => send(1));
        enqueue(target, body);
        throw err;
      })
      .finally(() => { if (ka) keepaliveInFlight -= size; });
  };
  return send(0);
}
