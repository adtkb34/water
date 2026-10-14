import * as z from "zod";
import { zodIssuesToErrors } from "@/lib/contract/derive";
import { getCapability } from "@/lib/contract/registry";
import type {
  Approval,
  AuditEntry,
  FieldError,
  Policy,
} from "@/lib/contract/types";
import { getStore } from "@/lib/server/db";

export function clone<T>(value: T): T {
  if (value === undefined) return value;
  return structuredClone(value);
}

function nextId(kind: "approval" | "audit", prefix: "A" | "L"): string {
  const store = getStore();
  store.seq[kind] += 1;
  return `${prefix}-${String(store.seq[kind]).padStart(3, "0")}`;
}

export function getPolicy(): Policy {
  const policy = getStore().policy;
  return {
    threshold: policy.threshold,
    alwaysReview: [...policy.alwaysReview],
  };
}

const policySchema = z.object(
  {
    threshold: z
      .number({ error: "阈值必须是 0 到 10 的整数" })
      .int({ error: "阈值必须是 0 到 10 的整数" })
      .min(0, { error: "阈值必须是 0 到 10 的整数" })
      .max(10, { error: "阈值必须是 0 到 10 的整数" }),
    alwaysReview: z.array(
      z.string({ error: "必须人工审核列表里的每一项都必须是能力编号" }),
      { error: "必须人工审核列表必须是能力编号数组" },
    ),
  },
  {
    error: (issue: { path?: PropertyKey[] }) => {
      if ((issue.path?.length ?? 0) > 0) return undefined;
      return "策略必须是对象，包含 threshold 和 alwaysReview";
    },
  },
);

export function setPolicy(
  input: unknown,
):
  | { ok: true; policy: Policy }
  | { ok: false; message: string; errors: FieldError[] } {
  const parsed = policySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: "策略未通过校验",
      errors: zodIssuesToErrors(parsed.error),
    };
  }
  const unknown = parsed.data.alwaysReview.filter((id) => !getCapability(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      message: "策略未通过校验",
      errors: unknown.map((id) => ({
        field: "alwaysReview",
        message: `未知能力「${id}」，不能加入必须人工审核。请改用已有的能力编号`,
      })),
    };
  }
  const policy: Policy = {
    threshold: parsed.data.threshold,
    alwaysReview: [...new Set(parsed.data.alwaysReview)],
  };
  getStore().policy = policy;
  return { ok: true, policy: getPolicy() };
}

export function pendingApprovalCount(): number {
  return getStore().approvals.filter((item) => item.status === "pending").length;
}

export function listApprovals(): Approval[] {
  return [...getStore().approvals].reverse();
}

export function findApproval(id: string): Approval | undefined {
  return getStore().approvals.find((item) => item.id === id);
}

export function createApproval(
  draft: Omit<Approval, "id" | "status" | "createdAt">,
): Approval {
  const approval: Approval = {
    ...draft,
    input: clone(draft.input),
    issues: clone(draft.issues),
    reasons: [...draft.reasons],
    id: nextId("approval", "A"),
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  getStore().approvals.push(approval);
  return approval;
}

export function listAudit(): AuditEntry[] {
  return [...getStore().audit].reverse();
}

export function findAudit(id: string): AuditEntry | undefined {
  return getStore().audit.find((item) => item.id === id);
}

export function appendAudit(
  draft: Omit<AuditEntry, "id" | "at">,
): AuditEntry {
  const entry: AuditEntry = {
    ...draft,
    input: clone(draft.input),
    issues: clone(draft.issues),
    ...(draft.undoData === undefined ? {} : { undoData: clone(draft.undoData) }),
    id: nextId("audit", "L"),
    at: new Date().toISOString(),
  };
  getStore().audit.push(entry);
  return entry;
}

export function reviewAudit(
  id: string,
  mark: "ok" | "flagged",
  note?: string,
): { ok: true; entry: AuditEntry } | { ok: false; status: 404; message: string } {
  const entry = findAudit(id);
  if (!entry) {
    return { ok: false, status: 404, message: `找不到审计记录「${id}」` };
  }
  const trimmed = note?.trim();
  entry.review = {
    mark,
    at: new Date().toISOString(),
    ...(trimmed ? { note: trimmed } : {}),
  };
  return { ok: true, entry };
}

export function revertAudit(id: string):
  | { ok: true; entry: AuditEntry; revertEntry: AuditEntry }
  | { ok: false; status: 404 | 409; message: string } {
  const entry = findAudit(id);
  if (!entry) {
    return { ok: false, status: 404, message: `找不到审计记录「${id}」` };
  }
  if (entry.reverted) {
    return { ok: false, status: 409, message: "该记录已经撤销，不能重复撤销" };
  }
  if (entry.outcome !== "executed" && entry.outcome !== "approved_executed") {
    return { ok: false, status: 409, message: "只有已执行的操作可以撤销" };
  }
  const capability = getCapability(entry.capabilityId);
  if (!entry.undoable || !capability?.undo) {
    const name = capability?.title ?? "该操作";
    return { ok: false, status: 409, message: `${name}不可撤销` };
  }
  capability.undo(entry.undoData, { store: getStore(), actor: entry.actor });
  entry.reverted = true;
  const revertEntry = appendAudit({
    capabilityId: entry.capabilityId,
    input: entry.input,
    actor: entry.actor,
    effectiveImpact: entry.effectiveImpact,
    outcome: "reverted",
    issues: [],
    summary: `已撤销 ${entry.id}：${entry.summary}`,
    approvalId: entry.approvalId,
    undoable: false,
  });
  return { ok: true, entry, revertEntry };
}
