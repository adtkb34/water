import { NextResponse } from "next/server";
import { probeCursorAccount } from "@/lib/server/cursor-engine";
import { probeProvider } from "@/lib/server/provider-probe";
import { getStoredProvider, providerKind, providerSecrets } from "@/lib/server/providers";
import { redactSecrets } from "@/lib/server/redact";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const stored = getStoredProvider(id);
  if (!stored) return json({ error: "找不到这个模型配置" }, 404);

  let override: Record<string, unknown> = {};
  const text = await request.text();
  if (text.trim()) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return json({ error: "请求体必须是 JSON 对象" }, 422);
      }
      override = parsed as Record<string, unknown>;
    } catch {
      return json({ error: "请求体不是合法的 JSON" }, 400);
    }
  }

  const apiKey =
    typeof override.apiKey === "string" && override.apiKey.trim()
      ? override.apiKey
      : stored.apiKey;
  const baseUrl = typeof override.baseUrl === "string" && override.baseUrl.trim()
    ? override.baseUrl.trim()
    : stored.baseUrl;
  const model = typeof override.model === "string" && override.model.trim()
    ? override.model.trim()
    : stored.model;
  const headers =
    override.headers && typeof override.headers === "object" && !Array.isArray(override.headers)
      ? Object.fromEntries(
          Object.entries(override.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        )
      : stored.headers;

  const secrets = [...providerSecrets(stored), apiKey, ...Object.values(headers ?? {})];
  try {
    if (providerKind(stored) === "cursor") {
      const result = await probeCursorAccount(apiKey);
      return json({
        ok: result.ok,
        message: redactSecrets(result.message, secrets),
        latencyMs: result.latencyMs,
        ...(result.models ? { models: result.models } : {}),
      });
    }
    const result = await probeProvider({ baseUrl, apiKey, model, headers });
    return json({
      ok: result.ok,
      message: redactSecrets(result.message, secrets),
      latencyMs: result.latencyMs,
    });
  } catch {
    return json({
      ok: false,
      message: redactSecrets("无法连接到模型服务", secrets),
      latencyMs: 0,
    }, 200);
  }
}
