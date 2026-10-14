import { NextResponse } from "next/server";
import { decideApproval } from "@/lib/server/invoke";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function parseDecision(
  body: unknown,
):
  | { ok: true; decision: "approve" | "reject"; note?: string }
  | { ok: false; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "请求体必须是 JSON 对象" };
  }
  const payload = body as { decision?: unknown; note?: unknown };
  if (payload.decision !== "approve" && payload.decision !== "reject") {
    return { ok: false, message: "decision 必须是 approve 或 reject" };
  }
  if (payload.note !== undefined && typeof payload.note !== "string") {
    return { ok: false, message: "note 必须是文本" };
  }
  return {
    ok: true,
    decision: payload.decision,
    ...(typeof payload.note === "string" ? { note: payload.note } : {}),
  };
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
  const parsed = parseDecision(body);
  if (!parsed.ok) return json({ message: parsed.message }, 422);
  const result = decideApproval(id, parsed.decision, parsed.note);
  if (!result.ok) return json({ message: result.message }, result.status);
  return json({
    approval: result.approval,
    ...(result.result ? { result: result.result } : {}),
  });
}
