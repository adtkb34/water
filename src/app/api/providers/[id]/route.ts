import { NextResponse } from "next/server";
import { deleteProvider, updateProvider, type ProviderFailure } from "@/lib/server/providers";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function fail(result: ProviderFailure) {
  return json({ error: result.error }, result.status);
}

// 省略 headers 保留已保存的请求头；传入对象（含 {}）则整组替换。响应只有 headerNames。
export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求体不是合法的 JSON" }, 400);
  }
  try {
    const result = updateProvider(id, body);
    if (!result.ok) return fail(result);
    return json({ provider: result.provider });
  } catch {
    return json({ error: "模型配置无法保存" }, 500);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  try {
    const result = deleteProvider(id);
    if (!result.ok) return fail(result);
    return json({ id: result.id });
  } catch {
    return json({ error: "模型配置无法保存" }, 500);
  }
}
