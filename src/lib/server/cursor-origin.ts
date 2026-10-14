import { originFromRequestInfo } from "@/lib/mcp/origin";

export function cursorMcpUrl(request: Request): string {
  return `${publicOrigin(request)}/api/mcp`;
}

export function publicOrigin(request: Request): string {
  const override = process.env.PUBLIC_BASE_URL?.trim();
  if (override) return originFromOverride(override);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  let url: URL | undefined;
  try {
    url = new URL(request.url);
  } catch {
    url = undefined;
  }
  const origin = originFromRequestInfo({ url, headers });
  if (!origin) throw new Error("无法确定本服务地址，请设置 PUBLIC_BASE_URL");
  return origin;
}

function originFromOverride(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PUBLIC_BASE_URL 不是合法的地址");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL 必须是 http 或 https 地址");
  }
  if (url.username || url.password) {
    throw new Error("PUBLIC_BASE_URL 不能包含账号或密码");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path && path !== "/") return `${url.origin}${path}`;
  return url.origin;
}
