import { getClient, matches, type Client } from "@errorlenshq/core";

export const active = (): Client | undefined => { const c = getClient(); return c?.active ? c : undefined; };

/** True for requests to the ErrorLens server itself (never traced). */
export function isOwnUrl(c: Client, url: string): boolean {
  if (!c.dsn) return false;
  try { return new URL(url).host === c.dsn.host; } catch { return false; }
}

export function shouldPropagate(c: Client, url: string): boolean {
  const targets = c.options.tracePropagationTargets;
  return !targets || matches(url, targets);
}

/** Drops the query string and fragment, which often carry tokens. */
export function stripQuery(url: string): string {
  const i = url.search(/[?#]/);
  return i === -1 ? url : url.slice(0, i);
}

const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}|[0-9a-f]{16,}|[0-9a-f]{24})$/i;

/** /orders/123/items/9f8e… → /orders/:id/items/:id, so transactions group by route. */
export function parameterize(path: string): string {
  return stripQuery(path).split("/").map((s) => (ID_SEGMENT.test(s) ? ":id" : s)).join("/") || "/";
}
