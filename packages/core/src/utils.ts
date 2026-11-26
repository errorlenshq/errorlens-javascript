/** Small helpers with no environment assumptions. */

export function uuid4(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID().replace(/-/g, "");
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

export const spanId = (): string => uuid4().slice(16);
export const now = (): number => Date.now() / 1000;

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** A JSON-safe copy: bounded depth, breadth and string length; circular-safe; never throws. */
export function normalize(value: unknown, depth = 6, maxItems = 100, maxString = 2048, seen = new WeakSet<object>()): unknown {
  try {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
    if (typeof value === "string") return truncate(value, maxString);
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "undefined") return undefined;
    if (typeof value === "symbol") return value.toString();
    if (typeof value === "function") return `[Function: ${value.name || "anonymous"}]`;
    if (value instanceof Date) return isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
    if (value instanceof Error) return { name: value.name, message: truncate(value.message, maxString) };
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) return "[Circular]";
    if (depth <= 0) return Array.isArray(value) ? `[Array(${value.length})]` : "[Object]";
    seen.add(value);
    if (typeof (value as { toJSON?: () => unknown }).toJSON === "function") {
      return normalize((value as { toJSON: () => unknown }).toJSON(), depth - 1, maxItems, maxString, seen);
    }
    if (Array.isArray(value) || value instanceof Set) {
      const items = Array.from(value as Iterable<unknown>);
      const out = items.slice(0, maxItems).map((v) => normalize(v, depth - 1, maxItems, maxString, seen));
      if (items.length > maxItems) out.push(`… ${items.length - maxItems} more`);
      return out;
    }
    const entries = value instanceof Map ? Array.from(value.entries()) : Object.entries(value as object);
    const out: Record<string, unknown> = {};
    entries.slice(0, maxItems).forEach(([k, v]) => {
      const n = normalize(v, depth - 1, maxItems, maxString, seen);
      if (n !== undefined) out[truncate(String(k), 200)] = n;
    });
    if (entries.length > maxItems) out["…"] = `${entries.length - maxItems} more`;
    return out;
  } catch {
    return "[unserializable]";
  }
}

export function matches(value: string, patterns: (string | RegExp)[] | undefined): boolean {
  return !!patterns && patterns.some((p) => (typeof p === "string" ? value.includes(p) : p.test(value)));
}
