import { connection, NextResponse } from "next/server";
import { agentNeedsReview } from "@/lib/client/policy-preview";
import { capabilities } from "@/lib/contract/registry";
import { toolNameForCapability } from "@/lib/mcp/names";
import { getPolicy } from "@/lib/server/governance";

export async function GET() {
  await connection();
  const policy = getPolicy();
  const tools = capabilities.map((capability) => ({
    id: capability.id,
    toolName: toolNameForCapability(capability.id),
    title: capability.title,
    kind: capability.kind,
    impact: capability.impact,
    requiresReview: agentNeedsReview({
      kind: capability.kind,
      impact: capability.impact,
      capabilityId: capability.id,
      threshold: policy.threshold,
      alwaysReview: policy.alwaysReview,
    }),
  }));
  return NextResponse.json(
    { tools },
    { headers: { "Cache-Control": "no-store" } },
  );
}
