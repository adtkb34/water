import type { Approval, InvokeResult } from "@/lib/contract/types";

export interface ToolCallContent {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: true;
}

const APPROVAL_STATUS_LABEL = {
  pending: "待审核",
  approved: "已通过",
  rejected: "已驳回",
} as const;

function textResult(
  summary: string,
  structured: Record<string, unknown>,
  isError?: true,
): ToolCallContent {
  return {
    content: [{ type: "text", text: `${summary}\n${JSON.stringify(structured)}` }],
    structuredContent: structured,
    ...(isError ? { isError } : {}),
  };
}

function executedNextStep(result: InvokeResult): string {
  const data = result.data;
  if (
    result.records &&
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    "total" in data
  ) {
    return "查询已完成，结果在 records 中";
  }
  return "操作已执行，关键结果在 data 中。如需继续，请调用下一步能力";
}

export function nextStepFor(result: InvokeResult): string {
  if (result.status === "pending_approval") {
    return `已提交人工审核（审批号 ${result.approvalId ?? ""}），请告知用户等待审核通过；可用 get_approval_status 查询`;
  }
  if (result.status === "rejected") {
    const hints = (result.errors ?? [])
      .map((error) => error.message)
      .filter((message) => message.length > 0);
    return hints.length > 0
      ? `请根据 errors 修正参数后重试。${hints.join("；")}`
      : "请根据 errors 修正参数后重试";
  }
  return executedNextStep(result);
}

export function invokeToolResult(result: InvokeResult): ToolCallContent {
  const structured: Record<string, unknown> = {
    status: result.status,
    capabilityId: result.capabilityId,
    summary: result.summary,
    effectiveImpact: result.effectiveImpact,
    impact: result.impact,
    issues: result.issues ?? [],
    reasons: result.reasons ?? [],
    approvalId: result.approvalId ?? null,
    errors: result.errors ?? [],
    data: result.data ?? null,
    records: result.records ?? null,
    nextStep: nextStepFor(result),
  };
  return textResult(
    result.summary,
    structured,
    result.status === "rejected" ? true : undefined,
  );
}

export function errorToolResult(
  summary: string,
  ids: { capabilityId?: string; approvalId?: string } = {},
): ToolCallContent {
  const structured: Record<string, unknown> = {
    status: "rejected",
    summary,
    effectiveImpact: 0,
    impact: 0,
    issues: [],
    reasons: [],
    approvalId: ids.approvalId ?? null,
    errors: [{ message: summary }],
    data: null,
    records: null,
    nextStep: `请根据 errors 修正参数后重试。${summary}`,
    ...(ids.capabilityId ? { capabilityId: ids.capabilityId } : {}),
  };
  return textResult(summary, structured, true);
}

export function approvalToolResult(approval: Approval): ToolCallContent {
  const label = APPROVAL_STATUS_LABEL[approval.status];
  const resultSummary = approval.resultSummary ?? "";
  const summary = resultSummary
    ? `审批 ${approval.id}：${label}。${resultSummary}`
    : `审批 ${approval.id}：${label}`;
  const structured: Record<string, unknown> = {
    approvalId: approval.id,
    status: approval.status,
    resultSummary,
    capabilityId: approval.capabilityId,
  };
  return textResult(summary, structured);
}

export function listToolResult(items: readonly object[]): ToolCallContent {
  const summary = `共 ${items.length} 个能力`;
  return textResult(summary, { capabilities: [...items] });
}

export function uiSpecToolResult(spec: {
  title: string;
  description: string;
}): ToolCallContent {
  const summary = `${spec.title}。${spec.description}`;
  return textResult(summary, spec as unknown as Record<string, unknown>);
}
