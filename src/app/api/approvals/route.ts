import { connection, NextResponse } from "next/server";
import { listApprovals } from "@/lib/server/governance";

export async function GET() {
  await connection();
  return NextResponse.json(
    { approvals: listApprovals() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
