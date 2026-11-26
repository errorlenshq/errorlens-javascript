/** console.* calls become breadcrumbs (and logs with consoleLogs: true). */
import { format } from "node:util";
import type { Level, LogLevel } from "@errorlenshq/core";
import { active } from "./util.js";

const PATCHED = Symbol.for("errorlens.patched");
const LEVELS: [string, Level, LogLevel][] = [
  ["debug", "debug", "debug"], ["log", "info", "info"], ["info", "info", "info"], ["warn", "warning", "warn"], ["error", "error", "error"],
];
let inside = false;

export function instrumentConsole(sendLogs: boolean): void {
  const con = console as unknown as Record<string, ((...a: unknown[]) => void) & { [PATCHED]?: boolean }>;
  for (const [method, level, logLevel] of LEVELS) {
    const orig = con[method];
    if (typeof orig !== "function" || orig[PATCHED]) continue;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const c = active();
      if (c && !inside) {
        inside = true; // the SDK's own warnings must not loop back here
        try {
          const message = format(...args).slice(0, 2048);
          c.addBreadcrumb({ category: "console", level, message });
          if (sendLogs) c.captureLog(logLevel, message, { "logger.name": "console" });
        } catch { /* never break console */ } finally { inside = false; }
      }
      return orig.apply(this, args);
    } as typeof orig;
    wrapped[PATCHED] = true;
    con[method] = wrapped;
  }
}
