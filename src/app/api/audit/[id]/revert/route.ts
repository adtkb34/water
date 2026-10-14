import { NextResponse } from "next/server";
import { revertAudit } from "@/lib/server/governance";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const result = revertAudit(id);
  if (!result.ok) {
    return NextResponse.json(
      { message: result.message },
      { status: result.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { entry: result.entry, revertEntry: result.revertEntry },
    { headers: { "Cache-Control": "no-store" } },
  );
}
