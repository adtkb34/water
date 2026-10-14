import { connection, NextResponse } from "next/server";
import {
  createProvider,
  listProviders,
  type ProviderFailure,
} from "@/lib/server/providers";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function fail(result: ProviderFailure) {
  return json({ error: result.error }, result.status);
}

export async function GET() {
  await connection();
  try {
    return json(listProviders());
  } catch {
    return json({ error: "模型配置无法读取" }, 500);
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求体不是合法的 JSON" }, 400);
  }
  try {
    const result = createProvider(body);
    if (!result.ok) return fail(result);
    return json({ provider: result.provider }, 201);
  } catch {
    return json({ error: "模型配置无法保存" }, 500);
  }
}
