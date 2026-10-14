import type { InvokeResult } from "@/lib/contract/types";

export interface SmartUiHost {
  invoke(
    capabilityId: string,
    input: Record<string, unknown>,
  ): Promise<InvokeResult>;
  notify?(message: string): void;
}
