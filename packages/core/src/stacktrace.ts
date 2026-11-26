/** Parsing Error.stack (V8, SpiderMonkey and JavaScriptCore formats) into frames. */

import type { StackFrame } from "./types.js";

const MAX_FRAMES = 100;
// "    at fn (file:line:col)", "    at file:line:col", "    at async fn (file:line:col)"
const V8 = /^\s*at (?:(.+?) )?\(?((?:file|https?|blob|chrome-extension|moz-extension|webpack|node|data|app|[A-Za-z]:|\/|<anonymous>|native)[^)]*?)(?::(\d+))?(?::(\d+))?\)?\s*$/;
// "    at fn (eval at caller (file:line:col), <anonymous>:line:col)" – code run by eval / new Function
const V8_EVAL = /^\s*at (?:(.+?) )?\(eval at .*\),\s*(.+?):(\d+):(\d+)\)\s*$/;
// "fn@file:line:col" (Firefox, Safari)
const GECKO = /^\s*(.*?)(?:\((.*?)\))?(?:^|@)((?:file|https?|blob|chrome|webpack|resource|moz-extension|safari-extension|app|capacitor|\/|\[native).*?|[^@]*bundle)(?::(\d+))?(?::(\d+))?\s*$/i;

export function parseStack(stack: string | undefined, inApp: (filename: string) => boolean): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const raw of stack.split("\n").slice(0, 200)) {
    const line = raw.trimEnd();
    const ev = V8_EVAL.exec(line);
    if (ev) {
      const fn = cleanFunction(ev[1]?.replace(/^eval$/, ""));
      if (/^(https?|file|blob):/.test(ev[2])) frames.push(frame(fn, ev[2], ev[3], ev[4], inApp)); // //# sourceURL names it
      else frames.push({ filename: "<anonymous>", function: fn || "?", in_app: false, lineno: +ev[3], colno: +ev[4] });
      continue;
    }
    let m = V8.exec(line);
    if (m && line.trimStart().startsWith("at ")) {
      const file = m[2];
      if (file === "native") continue;
      // code without a file (eval, new Function, injected scripts): keep the function name, not the app's own code
      if (file === "<anonymous>") {
        frames.push({ filename: "<anonymous>", function: cleanFunction(m[1]) || "?", in_app: false, ...(m[3] ? { lineno: +m[3] } : {}), ...(m[4] ? { colno: +m[4] } : {}) });
        continue;
      }
      frames.push(frame(cleanFunction(m[1]), file, m[3], m[4], inApp));
      continue;
    }
    m = GECKO.exec(line);
    if (m && m[3]) {
      frames.push(frame(m[1] || undefined, m[3], m[4], m[5], inApp));
    }
  }
  frames.reverse(); // oldest first, like every other platform
  return frames.length > MAX_FRAMES ? frames.slice(-MAX_FRAMES) : frames;
}

function cleanFunction(fn: string | undefined): string | undefined {
  if (!fn) return undefined;
  return fn.replace(/^async /, "").replace(/^new /, "").replace(/ \[as [^\]]+\]$/, "") || undefined;
}

function frame(fn: string | undefined, file: string, line?: string, col?: string, inApp?: (f: string) => boolean): StackFrame {
  const abs = file.replace(/^file:\/\//, "");
  const f: StackFrame = { filename: abs, abs_path: abs, function: fn || "?" };
  if (line) f.lineno = parseInt(line, 10);
  if (col) f.colno = parseInt(col, 10);
  f.in_app = inApp ? inApp(abs) : true;
  return f;
}
