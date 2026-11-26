/** Client-side scrubbing: secrets never leave the app (the server scrubs again). */

export const FILTERED = "[Filtered]";

const DEFAULT_KEYS = ["password", "passwd", "pwd", "secret", "token", "apikey", "accesskey", "auth", "credential",
  "cookie", "session", "csrf", "xsrf", "privatekey", "creditcard", "cardnumber", "cvv", "cvc", "ssn", "iban", "signature"];

const VALUE_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
  /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g,
  /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
];
const URL_PASSWORD = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/g;
const KV_SECRET = /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&,;]+)/gi;

const norm = (k: string) => k.toLowerCase().replace(/[-_]/g, "");

export class Scrubber {
  private keys: string[];
  private safe: Set<string>;

  constructor(extra: string[] = [], safe: string[] = []) {
    this.keys = DEFAULT_KEYS.concat(extra.map(norm));
    this.safe = new Set(safe.map((s) => s.toLowerCase()));
  }

  sensitiveKey(key: string): boolean {
    if (this.safe.has(key.toLowerCase())) return false;
    const n = norm(key);
    return this.keys.some((k) => n.includes(k));
  }

  string(text: string): string {
    if (text.length < 8) return text;
    for (const p of VALUE_PATTERNS) text = text.replace(p, FILTERED);
    text = text.replace(URL_PASSWORD, `$1${FILTERED}$3`);
    return text.replace(KV_SECRET, `$1$2${FILTERED}`);
  }

  /** Scrubs objects and arrays in place; returns the scrubbed value. */
  value<T>(value: T, depth = 0): T {
    if (depth > 12) return value;
    if (typeof value === "string") return this.string(value) as unknown as T;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) value[i] = this.value(value[i], depth + 1);
      return value;
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        if (this.sensitiveKey(k)) {
          if (obj[k] !== null && obj[k] !== "" && obj[k] !== undefined) obj[k] = FILTERED;
        } else {
          obj[k] = this.value(obj[k], depth + 1);
        }
      }
    }
    return value;
  }
}
