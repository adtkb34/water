const SAFE_HOST =
  /^(?:localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])(?::\d{1,5})?$/i;

export interface OriginRequestInfo {
  url?: URL;
  headers?: Record<string, string | string[] | undefined>;
}

function firstHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.split(",")[0]?.trim() ?? "";
}

function isSafeHost(host: string): boolean {
  return host.length > 0 && host.length <= 255 && SAFE_HOST.test(host);
}

export function originFromRequestInfo(info?: OriginRequestInfo): string {
  const urlOrigin =
    info?.url && info.url.origin !== "null" ? info.url.origin : "";
  const headers = info?.headers ?? {};
  const forwardedHost = firstHeader(headers, "x-forwarded-host");
  const forwardedProto = firstHeader(headers, "x-forwarded-proto");
  if (
    isSafeHost(forwardedHost) &&
    (forwardedProto === "http" || forwardedProto === "https")
  ) {
    return `${forwardedProto}://${forwardedHost}`;
  }
  return urlOrigin;
}
