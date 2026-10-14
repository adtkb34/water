import type { InvokeResult, UiSpec } from "@/lib/contract/types";

export interface ToolContent {
  type: string;
  text?: string;
}

export interface ToolPayload {
  content?: ToolContent[];
  structuredContent?: Record<string, unknown> | null;
  isError?: boolean;
  _meta?: Record<string, unknown> | null;
}

export interface WidgetHostContext {
  theme?: "light" | "dark" | string;
  safeAreaInsets?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
}

export type WidgetView =
  | { kind: "waiting" }
  | { kind: "preparing" }
  | {
      kind: "form";
      spec: UiSpec;
      prefill: Record<string, unknown>;
      mcpToolName: string;
      workbenchUrl: string;
    }
  | { kind: "invoke"; result: InvokeResult; workbenchUrl: string }
  | {
      kind: "approval";
      approvalId: string;
      status: string;
      summary: string;
      capabilityId: string;
      workbenchUrl: string;
    }
  | { kind: "unknown"; message: string; text: string };

const INVOKE_STATUS = new Set(["executed", "pending_approval", "rejected"]);
const APPROVAL_STATUS = new Set(["pending", "approved", "rejected"]);

const APPROVAL_LABEL: Record<string, string> = {
  pending: "待审核",
  approved: "已通过",
  rejected: "已驳回",
};

export function textOf(payload: ToolPayload): string {
  return (payload.content ?? [])
    .map((item) => item.text ?? "")
    .filter((item) => item.length > 0)
    .join("\n");
}

export function workbenchUrlOf(
  payload: ToolPayload,
  structured?: Record<string, unknown>,
): string {
  const fromStructured = structured?.workbenchUrl;
  if (typeof fromStructured === "string") return fromStructured;
  const fromMeta = payload._meta?.workbenchUrl;
  if (typeof fromMeta === "string") return fromMeta;
  return "";
}

export function approvalsUrl(workbenchUrl: string): string {
  if (!workbenchUrl) return "";
  return `${workbenchUrl.replace(/\/$/, "")}/workbench/approvals`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUiSpec(value: unknown): value is UiSpec {
  if (!isRecord(value)) return false;
  const submit = value.submit;
  return (
    typeof value.capabilityId === "string" &&
    typeof value.title === "string" &&
    Array.isArray(value.fields) &&
    isRecord(submit) &&
    typeof submit.tool === "string" &&
    typeof submit.label === "string"
  );
}

function isInvokeResult(value: unknown): value is InvokeResult {
  if (!isRecord(value)) return false;
  return (
    typeof value.status === "string" &&
    INVOKE_STATUS.has(value.status) &&
    typeof value.capabilityId === "string" &&
    typeof value.summary === "string" &&
    typeof value.effectiveImpact === "number"
  );
}

function plainPrefill(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return value;
}

export function mcpToolNameFor(capabilityId: string, explicit?: unknown): string {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  return capabilityId.replaceAll(".", "_");
}

export function toInvokeResult(payload: ToolPayload, capabilityId: string): InvokeResult {
  if (isInvokeResult(payload.structuredContent)) return payload.structuredContent;
  const summary = textOf(payload) || (payload.isError ? "提交失败" : "已完成");
  return {
    status: payload.isError ? "rejected" : "executed",
    capabilityId,
    impact: 0,
    effectiveImpact: 0,
    summary,
    errors: payload.isError ? [{ message: summary }] : undefined,
  };
}

export function interpretToolResult(payload: ToolPayload): WidgetView {
  const structured = isRecord(payload.structuredContent)
    ? payload.structuredContent
    : undefined;
  const text = textOf(payload);
  const workbenchUrl = workbenchUrlOf(payload, structured);

  if (structured?.kind === "form") {
    if (!isUiSpec(structured.uiSpec)) {
      return {
        kind: "unknown",
        message: "表单数据不完整，无法渲染。",
        text,
      };
    }
    return {
      kind: "form",
      spec: structured.uiSpec,
      prefill: plainPrefill(structured.prefill),
      mcpToolName: mcpToolNameFor(structured.uiSpec.capabilityId, structured.mcpToolName),
      workbenchUrl,
    };
  }

  if (isInvokeResult(structured)) {
    return { kind: "invoke", result: structured, workbenchUrl };
  }

  if (
    structured &&
    typeof structured.approvalId === "string" &&
    typeof structured.status === "string" &&
    APPROVAL_STATUS.has(structured.status)
  ) {
    const label = APPROVAL_LABEL[structured.status] ?? structured.status;
    const resultSummary =
      typeof structured.resultSummary === "string" ? structured.resultSummary : "";
    const summary = resultSummary
      ? `审批 ${structured.approvalId}：${label}。${resultSummary}`
      : `审批 ${structured.approvalId}：${label}`;
    return {
      kind: "approval",
      approvalId: structured.approvalId,
      status: structured.status,
      summary,
      capabilityId: typeof structured.capabilityId === "string" ? structured.capabilityId : "",
      workbenchUrl,
    };
  }

  return {
    kind: "unknown",
    message: text
      ? "无法识别这份结果。请根据下面的文字继续。"
      : "无法识别这份结果。",
    text,
  };
}
