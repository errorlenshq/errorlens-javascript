/** Uncaught exceptions and unhandled rejections, reported before Node's normal behaviour runs. */
import { getClient } from "@errorlenshq/core";
import { active } from "./util.js";

const FLUSH_MS = 2000;
let installed = false;

function rejectionMode(): string {
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS || "").split(/\s+/)];
  for (const f of flags) {
    const m = /^--unhandled-rejections=(\w[\w-]*)$/.exec(f);
    if (m) return m[1];
  }
  return "throw";
}

function die(error: unknown): void {
  // What Node prints for an uncaught error, then the same exit code.
  process.stderr.write(`${error instanceof Error ? error.stack || String(error) : `Uncaught ${String(error)}`}\n`);
  process.exit(1);
}

export function instrumentProcess(onFatal?: (error: unknown) => void): void {
  if (installed) return;
  installed = true;
  let dying = false;

  const onException = (error: unknown, origin: string) => {
    const c = active();
    const mechanism = { type: origin === "unhandledRejection" ? "onunhandledrejection" : "onuncaughtexception", handled: false };
    c?.captureException(error, {}, mechanism, "fatal");
    // Someone else handles uncaught errors: just report.
    if (process.listenerCount("uncaughtException") > 1) return;
    if (dying) return;
    dying = true;
    const end = () => (onFatal ? onFatal(error) : die(error));
    if (!c) return end();
    c.flush(FLUSH_MS).then(end, end);
  };
  process.on("uncaughtException", onException);

  process.on("unhandledRejection", (reason: unknown) => {
    const mode = rejectionMode();
    if (mode === "none") return;
    if (process.listenerCount("unhandledRejection") > 1 || mode === "warn" || mode === "warn-with-error-code") {
      active()?.captureException(reason, {}, { type: "onunhandledrejection", handled: false }, "error");
      if (mode === "warn-with-error-code") process.exitCode = 1;
      if (process.listenerCount("unhandledRejection") === 1) process.emitWarning(`Unhandled promise rejection: ${String((reason as Error)?.stack || reason)}`);
      return;
    }
    // Default (throw/strict): same as Node — it becomes a fatal uncaught error.
    onException(reason, "unhandledRejection");
  });

  // Send what is still queued when the event loop drains.
  process.on("beforeExit", () => {
    const c = getClient();
    if (c?.hasPending()) void c.flush(FLUSH_MS);
  });
}
