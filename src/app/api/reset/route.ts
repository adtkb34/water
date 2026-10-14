import { NextResponse } from "next/server";
import { reset } from "@/lib/server/db";

export async function POST() {
  reset();
  return NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
