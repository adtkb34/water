export interface ChatFailure {
  message: string;
  missingProvider: boolean;
}

const GENERIC = "模型请求失败，请稍后重试";

export function parseChatFailure(error: unknown): ChatFailure {
  const raw = error instanceof Error ? error.message : "";
  let message = raw.trim();
  let missingProvider = false;
  if (message.startsWith("{")) {
    try {
      const parsed = JSON.parse(message) as { error?: unknown; code?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim()) message = parsed.error.trim();
      if (parsed.code === "provider_missing") missingProvider = true;
    } catch {
      message = GENERIC;
    }
  }
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) {
    message = "无法连接对话服务，请检查网络后重试";
  }
  if (!message || message.length > 300 || /bearer|authorization|api[_-]?key/i.test(message)) {
    message = missingProvider ? "所选模型不存在，已切换到引导模式。" : GENERIC;
  }
  return { message, missingProvider };
}
