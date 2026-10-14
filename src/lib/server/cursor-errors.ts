import { redactSecrets } from "@/lib/server/redact";

export type CursorFailureKind = "auth" | "rate" | "network" | "timeout" | "other";

export interface CursorFailure {
  kind: CursorFailureKind;
  isRetryable: boolean;
  message: string;
}

interface ErrorInfo {
  name: string;
  message: string;
  code: string;
  status: number;
  isRetryable: boolean;
}

function readError(error: unknown): ErrorInfo {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const name = error instanceof Error ? error.name : typeof record.name === "string" ? record.name : "";
  const message =
    error instanceof Error ? error.message : typeof record.message === "string" ? record.message : "";
  const code = typeof record.code === "string" ? record.code : "";
  const status = typeof record.status === "number" ? record.status : 0;
  return {
    name,
    message,
    code,
    status,
    isRetryable: record.isRetryable === true,
  };
}

export function isUnknownCursorAgent(error: unknown): boolean {
  const info = readError(error);
  if (info.name === "AgentNotFoundError" || info.code === "agent_not_found") return true;
  const text = `${info.name} ${info.message}`.toLowerCase();
  return /agent/.test(text) && /not found|unknown|no such/.test(text);
}

export function classifyCursorFailure(error: unknown): { kind: Exclude<CursorFailureKind, "timeout">; isRetryable: boolean } {
  const info = readError(error);
  const haystack = `${info.name} ${info.code} ${info.message}`.toLowerCase();
  if (
    info.name === "AuthenticationError" ||
    info.status === 401 ||
    info.code === "unauthenticated" ||
    info.code === "BAD_USER_API_KEY" ||
    /invalid api key|api key invalid|api key.*expired|expired api key|unauthenticated|not authenticated/.test(haystack)
  ) {
    return { kind: "auth", isRetryable: info.isRetryable };
  }
  if (
    info.name === "RateLimitError" ||
    info.status === 429 ||
    info.code === "resource_exhausted" ||
    /rate limit|too many requests|quota|usage limit|resource exhausted/.test(haystack)
  ) {
    return { kind: "rate", isRetryable: true };
  }
  if (
    info.name === "NetworkError" ||
    info.status === 503 ||
    info.status === 504 ||
    /econnreset|econnrefused|fetch failed|network error|socket hang up/.test(haystack)
  ) {
    return { kind: "network", isRetryable: info.isRetryable || info.name === "NetworkError" };
  }
  return { kind: "other", isRetryable: info.isRetryable };
}

export function cursorFailureMessage(kind: CursorFailureKind, isRetryable: boolean): string {
  if (kind === "auth") return "Cursor API Key 无效或已过期，请到 模型设置 更新";
  if (kind === "rate") return "Cursor 额度或频率受限，请稍后重试";
  if (kind === "timeout") return "Cursor 智能体超时，已取消本次运行";
  if (isRetryable) return "Cursor 暂时不可用，请稍后重试";
  return "Cursor 运行失败，请检查配置后重试";
}

export function cursorErrorText(error: unknown, secrets: readonly string[]): string {
  const classified = classifyCursorFailure(error);
  return redactSecrets(cursorFailureMessage(classified.kind, classified.isRetryable), secrets);
}

export function maskCursorAccount(account: {
  userEmail?: string;
  userFirstName?: string;
  userLastName?: string;
  apiKeyName?: string;
}): string {
  const email = account.userEmail?.trim() ?? "";
  if (email.includes("@")) {
    const [local, domain] = email.split("@");
    const head = local ? local.slice(0, 1) : "*";
    return `${head}***@${domain}`;
  }
  const name = [account.userFirstName, account.userLastName].filter(Boolean).join("");
  if (name) return `${name.slice(0, 1)}***`;
  if (account.apiKeyName?.trim()) return `${account.apiKeyName.trim().slice(0, 1)}***`;
  return "已登录";
}
