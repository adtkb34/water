import { connection, NextResponse } from "next/server";
import { listAudit } from "@/lib/server/governance";

export async function GET() {
  await connection();
  return NextResponse.json(
    { entries: listAudit() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
