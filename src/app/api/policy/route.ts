import { connection, NextResponse } from "next/server";
import { getPolicy, setPolicy } from "@/lib/server/governance";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET() {
  await connection();
  return json(getPolicy());
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(
      {
        message: "请求体不是合法的 JSON",
        errors: [{ message: "请求体不是合法的 JSON" }],
      },
      422,
    );
  }
  const result = setPolicy(body);
  if (!result.ok) {
    return json({ message: result.message, errors: result.errors }, 422);
  }
  return json(result.policy);
}
