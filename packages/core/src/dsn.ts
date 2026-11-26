export interface Dsn {
  protocol: string;
  publicKey: string;
  host: string; // host[:port]
  path: string;
  projectId: string;
}

/** Parses https://<key>@host[/path]/<project-id>; returns undefined when invalid. */
export function parseDsn(value: string): Dsn | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (!url.username) return undefined;
  const parts = url.pathname.replace(/\/+$/, "").split("/");
  const projectId = parts.pop() || "";
  if (!/^\d+$/.test(projectId)) return undefined;
  return { protocol: url.protocol.slice(0, -1), publicKey: decodeURIComponent(url.username), host: url.host, path: parts.join("/"), projectId };
}

export function envelopeUrl(dsn: Dsn): string {
  return `${dsn.protocol}://${dsn.host}${dsn.path}/api/${dsn.projectId}/envelope/`;
}
