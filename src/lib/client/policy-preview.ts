import type { CapabilityKind } from "@/lib/contract/types";

export interface AgentGateInput {
  kind: CapabilityKind;
  impact: number;
  capabilityId: string;
  threshold: number;
  alwaysReview: readonly string[];
}

export function agentNeedsReview(input: AgentGateInput): boolean {
  if (input.kind !== "write") return false;
  return (
    input.impact >= input.threshold ||
    input.alwaysReview.includes(input.capabilityId)
  );
}
