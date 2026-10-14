import { collectSecrets, redactSecrets } from "@/lib/server/redact";

export interface ProbeTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
}

export interface ProbeResult {
  ok: boolean;
  message: string;
  latencyMs: number;
}

const TIMEOUT_MS = 8000;

function endpoint(baseUrl: string, suffix: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(suffix, base).toString();
}

function authHeaders(target: ProbeTarget): Record<string, string> {
  const headers: Record<string, string> = {};
  if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`;
  return { ...headers, ...(target.headers ?? {}) };
}

function failureMessage(status: number): string {
  if (status === 401 || status === 403) return "密钥被拒绝，请检查 API Key";
  if (status === 404) return "这个地址没有可用的模型接口";
  return `连接失败（HTTP ${status}）`;
}

function safeMessage(message: string, target: ProbeTarget): string {
  return redactSecrets(message, collectSecrets(target.apiKey, Object.values(target.headers ?? {})));
}

async function discard(response: Response) {
  try {
    await response.arrayBuffer();
  } catch {
    // The status is enough; the body is never shown.
  }
}

export async function probeProvider(target: ProbeTarget): Promise<ProbeResult> {
  const started = Date.now();
  const headers = authHeaders(target);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  try {
    let response = await fetch(endpoint(target.baseUrl, "models"), {
      method: "GET",
      headers,
      signal: timeout,
    });
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      await discard(response);
      response = await fetch(endpoint(target.baseUrl, "chat/completions"), {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          model: target.model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
        signal: timeout,
      });
    }
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      await discard(response);
      return {
        ok: false,
        message: safeMessage(failureMessage(response.status), target),
        latencyMs,
      };
    }
    await discard(response);
    return { ok: true, message: "连接成功", latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    const message = timedOut ? "连接超时" : "无法连接到模型服务";
    return { ok: false, message: safeMessage(message, target), latencyMs };
  }
}
