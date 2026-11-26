import { readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import type { ErrorLensEvent } from "@errorlenshq/core";

const CONTEXT_LINES = 5;
const cache = new Map<string, string[] | null>();

export function inApp(filename: string): boolean {
  return !!filename && !filename.includes("/node_modules/") && !filename.includes("\\node_modules\\") &&
    !filename.startsWith("node:") && !filename.startsWith("internal/") && (filename.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filename));
}

function lines(file: string): string[] | null {
  if (cache.has(file)) return cache.get(file)!;
  let out: string[] | null = null;
  try {
    if (statSync(file).size < 2_000_000) out = readFileSync(file, "utf8").split(/\r?\n/);
  } catch { /* not readable */ }
  if (cache.size > 200) cache.clear();
  cache.set(file, out);
  return out;
}

/** Adds the source lines around each of the app's own frames. */
export function addSourceContext(event: ErrorLensEvent): void {
  for (const ex of event.exception?.values || []) {
    for (const f of ex.stacktrace?.frames || []) {
      if (!f.in_app || !f.abs_path || !f.lineno) continue;
      const src = lines(f.abs_path);
      if (!src || f.lineno > src.length) continue;
      const i = f.lineno - 1;
      const clip = (s: string) => (s.length > 300 ? s.slice(0, 299) + "…" : s);
      f.pre_context = src.slice(Math.max(0, i - CONTEXT_LINES), i).map(clip);
      f.context_line = clip(src[i]);
      f.post_context = src.slice(i + 1, i + 1 + CONTEXT_LINES).map(clip);
      // Shorter, stable filenames relative to the working directory.
      const cwd = process.cwd();
      if (f.abs_path.startsWith(cwd + "/")) f.filename = f.abs_path.slice(cwd.length + 1);
    }
  }
}

export function nodeContexts(): Record<string, Record<string, unknown>> {
  return {
    runtime: { name: "node", version: process.version },
    os: { name: os.type(), version: os.release() },
    app: { app_memory: process.memoryUsage().rss },
  };
}
