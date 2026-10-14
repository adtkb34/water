import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from "ai";
import { NextResponse } from "next/server";
import { runCursorChat } from "@/lib/server/cursor-engine";
import { buildLlmTools, chineseToolInputHint } from "@/lib/server/llm-tools";
import { getStoredProvider, providerKind, providerSecrets } from "@/lib/server/providers";
import { redactSecrets } from "@/lib/server/redact";
import { MODEL_UNAVAILABLE, SYSTEM_PROMPT } from "@/lib/server/system-prompt";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function isMessageArray(value: unknown): value is UIMessage[] {
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    if (!item || typeof item !== "object") return false;
    const message = item as { role?: unknown; parts?: unknown };
    return (
      (message.role === "user" || message.role === "assistant" || message.role === "system") &&
      Array.isArray(message.parts)
    );
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求体不是合法的 JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "请求体必须是 JSON 对象" }, 422);
  }
  const payload = body as { providerId?: unknown; messages?: unknown; chatId?: unknown; id?: unknown };
  if (typeof payload.providerId !== "string" || !payload.providerId.trim()) {
    return json({ error: "请选择一个模型", code: "provider_missing" }, 404);
  }
  if (!isMessageArray(payload.messages) || payload.messages.length === 0) {
    return json({ error: "请提供对话消息" }, 422);
  }

  const provider = getStoredProvider(payload.providerId);
  if (!provider) {
    return json(
      { error: "所选模型不存在，已切换到引导模式。", code: "provider_missing" },
      404,
    );
  }

  const chatId =
    typeof payload.chatId === "string" && payload.chatId.trim()
      ? payload.chatId
      : typeof payload.id === "string"
        ? payload.id
        : "";
  if (providerKind(provider) === "cursor") {
    return runCursorChat({
      request,
      provider,
      messages: payload.messages,
      chatId,
    });
  }

  const secrets = providerSecrets(provider);
  const safeError = (error: unknown) => {
    const hint = chineseToolInputHint(error);
    const text = hint ?? MODEL_UNAVAILABLE;
    const hidden = hint ? secrets : [...secrets, error instanceof Error ? error.message : ""];
    return redactSecrets(text, hidden);
  };

  try {
    const tools = buildLlmTools();
    const model = createOpenAICompatible({
      name: provider.name,
      baseURL: provider.baseUrl,
      apiKey: provider.apiKey || undefined,
      headers: provider.headers,
    })(provider.model);
    const messages = await convertToModelMessages(payload.messages, {
      tools,
      ignoreIncompleteToolCalls: true,
    });
    const result = streamText({
      model,
      system: SYSTEM_PROMPT,
      messages,
      tools,
      stopWhen: stepCountIs(8),
      abortSignal: request.signal,
      maxRetries: 0,
      onError: () => {},
    });
    return result.toUIMessageStreamResponse({
      onError: (error) => safeError(error),
    });
  } catch (error) {
    return json({ error: safeError(error) }, 502);
  }
}
