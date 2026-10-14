import { connection, NextResponse } from "next/server";
import { getUiSpecs } from "@/lib/contract/registry";
import { getStore } from "@/lib/server/db";
import { getPolicy, pendingApprovalCount } from "@/lib/server/governance";

export async function GET() {
  await connection();
  const store = getStore();
  return NextResponse.json(
    {
      products: store.products,
      suppliers: store.suppliers,
      inquiries: store.inquiries,
      specs: getUiSpecs(store),
      policy: getPolicy(),
      pendingApprovals: pendingApprovalCount(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
