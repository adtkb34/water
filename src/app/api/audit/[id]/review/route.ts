import { NextResponse } from "next/server";
import { reviewAudit } from "@/lib/server/governance";

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
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ message: "请求体不是合法的 JSON" }, 422);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ message: "请求体必须是 JSON 对象" }, 422);
  }
  const payload = body as { mark?: unknown; note?: unknown };
  if (payload.mark !== "ok" && payload.mark !== "flagged") {
    return json({ message: "mark 必须是 ok 或 flagged" }, 422);
  }
  if (payload.note !== undefined && typeof payload.note !== "string") {
    return json({ message: "note 必须是文本" }, 422);
  }
  const result = reviewAudit(
    id,
    payload.mark,
    typeof payload.note === "string" ? payload.note : undefined,
  );
  if (!result.ok) return json({ message: result.message }, result.status);
  return json({ entry: result.entry });
}
