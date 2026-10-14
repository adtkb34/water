import { NextResponse } from "next/server";
import { setDefaultProvider } from "@/lib/server/providers";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求体不是合法的 JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "请求体必须是 JSON 对象" }, 422);
  }
  const id = (body as { id?: unknown }).id;
  if (id !== null && typeof id !== "string") {
    return json({ error: "请提供模型 id" }, 422);
  }
  try {
    const result = setDefaultProvider(id);
    if (!result.ok) return json({ error: result.error }, result.status);
    return json({ defaultId: result.defaultId });
  } catch {
    return json({ error: "模型配置无法保存" }, 500);
  }
}
