"use client";

import useSWR from "swr";
import { toast } from "sonner";
import type {
  Approval,
  AuditEntry,
  CapabilityKind,
  Inquiry,
  Policy,
  Product,
  Supplier,
  UiSpec,
} from "@/lib/contract/types";
import type { SmartUiHost } from "@/smart-ui";
import { fetchJson, invokeAsHuman } from "@/lib/client/api";

export interface AppState {
  products: Product[];
  suppliers: Supplier[];
  inquiries: Inquiry[];
  specs: UiSpec[];
  policy: Policy;
  pendingApprovals: number;
}

export interface AuditResponse {
  entries: AuditEntry[];
}

export interface ApprovalsResponse {
  approvals: Approval[];
}

export interface CapabilityTool {
  id: string;
  toolName: string;
  title: string;
  kind: CapabilityKind;
  impact: number;
  requiresReview: boolean;
}

export interface CapabilitiesResponse {
  tools: CapabilityTool[];
}

const refresh = {
  refreshInterval: 2500,
  revalidateOnFocus: true,
};

export function useStore() {
  const { data, error, isLoading, mutate } = useSWR<AppState>(
    "/api/state",
    fetchJson,
    refresh,
  );
  return {
    data,
    error,
    isLoading,
    refresh: () => mutate(),
  };
}

export function useApprovals() {
  const { data, error, isLoading, mutate } = useSWR<ApprovalsResponse>(
    "/api/approvals",
    fetchJson,
    refresh,
  );
  return {
    data,
    error,
    isLoading,
    refresh: () => mutate(),
  };
}

export function useCapabilities() {
  const { data, error, isLoading, mutate } = useSWR<CapabilitiesResponse>(
    "/api/capabilities",
    fetchJson,
    refresh,
  );
  return {
    data,
    error,
    isLoading,
    refresh: () => mutate(),
  };
}

export function useAudit() {
  const { data, error, isLoading, mutate } = useSWR<AuditResponse>(
    "/api/audit",
    fetchJson,
    refresh,
  );
  return {
    data,
    error,
    isLoading,
    refresh: () => mutate(),
  };
}

export function useWorkbenchHost(): SmartUiHost {
  const { refresh: refreshStore } = useStore();
  const { refresh: refreshAudit } = useAudit();
  return {
    async invoke(capabilityId, input) {
      const result = await invokeAsHuman(capabilityId, input);
      await Promise.all([refreshStore(), refreshAudit()]);
      if (result.status === "executed") {
        toast.success(result.summary);
      } else if (result.status === "pending_approval") {
        toast.message("待人工审核", { description: result.summary });
      } else {
        toast.error("已拦截", { description: result.summary });
      }
      return result;
    },
    notify(message) {
      toast.message(message);
    },
  };
}
