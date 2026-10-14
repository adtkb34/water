import { zodIssuesToErrors, toZod, validateValues } from "@/lib/contract/derive";
import { isDomainError } from "@/lib/contract/errors";
import { getCapability } from "@/lib/contract/registry";
import type {
  Actor,
  Approval,
  AuditStage,
  CapabilityDef,
  FieldError,
  InvokeResult,
  Issue,
} from "@/lib/contract/types";
import { getStore } from "@/lib/server/db";
import {
  appendAudit,
  clone,
  createApproval,
  findApproval,
  getPolicy,
} from "@/lib/server/governance";

export interface InvokeRequest {
  capabilityId: string;
  input?: unknown;
  actor: Actor;
}

interface InternalFlags {
  humanApproved?: boolean;
  approvalId?: string;
  auditRejection?: boolean;
}

export interface DecisionSuccess {
  ok: true;
  approval: Approval;
  result?: InvokeResult;
}

export interface DecisionFailure {
  ok: false;
  status: 404 | 409;
  message: string;
}

function errorsToIssues(errors: FieldError[]): Issue[] {
  return errors.map((error) => ({
    level: "block",
    ...(error.field ? { field: error.field } : {}),
    message: error.message,
  }));
}

function weight(impact: number, warns: number): number {
  return Math.min(10, impact + 2 * warns);
}

function shouldReview(
  capability: CapabilityDef,
  actor: Actor,
  effectiveImpact: number,
  humanApproved: boolean | undefined,
): boolean {
  if (humanApproved) return false;
  if (capability.kind !== "write") return false;
  if (actor.kind === "human") return false;
  const policy = getPolicy();
  return (
    effectiveImpact >= policy.threshold ||
    policy.alwaysReview.includes(capability.id)
  );
}

function gateReasons(capabilityId: string, effectiveImpact: number): string[] {
  const policy = getPolicy();
  const reasons: string[] = [];
  if (effectiveImpact >= policy.threshold) {
    reasons.push(`影响权重 ${effectiveImpact} 达到阈值 ${policy.threshold}`);
  }
  if (policy.alwaysReview.includes(capabilityId)) {
    reasons.push("该能力被设为必须人工审核");
  }
  return reasons;
}

function recordWrite(
  capability: CapabilityDef,
  draft: {
    input: unknown;
    actor: Actor;
    effectiveImpact: number;
    outcome: "executed" | "pending_approval" | "rejected" | "approved_executed";
    stage: AuditStage;
    issues: Issue[];
    summary: string;
    approvalId?: string;
    undoData?: unknown;
    undoable: boolean;
  },
  flags: InternalFlags,
): string | undefined {
  if (capability.kind !== "write") return undefined;
  if (draft.outcome === "rejected" && flags.auditRejection === false) {
    return undefined;
  }
  return appendAudit({
    capabilityId: capability.id,
    input: draft.input,
    actor: draft.actor,
    effectiveImpact: draft.effectiveImpact,
    outcome: draft.outcome,
    stage: draft.stage,
    issues: draft.issues,
    summary: draft.summary,
    ...(draft.approvalId ? { approvalId: draft.approvalId } : {}),
    ...(draft.undoData === undefined ? {} : { undoData: draft.undoData }),
    undoable: draft.undoable,
  }).id;
}

function rejectedResult(
  capability: CapabilityDef,
  actor: Actor,
  effectiveImpact: number,
  summary: string,
  stage: AuditStage,
  errors: FieldError[],
  issues: Issue[],
  auditId?: string,
): InvokeResult {
  return {
    status: "rejected",
    capabilityId: capability.id,
    impact: capability.impact,
    effectiveImpact,
    summary,
    errors,
    issues,
    stage,
    actor,
    ...(auditId ? { auditId } : {}),
  };
}

export function invoke(request: InvokeRequest): InvokeResult {
  return run(request, {});
}

function run(request: InvokeRequest, flags: InternalFlags): InvokeResult {
  const actor = request.actor;
  const capability = getCapability(request.capabilityId);
  if (!capability) {
    return {
      status: "rejected",
      capabilityId: request.capabilityId,
      impact: 0,
      effectiveImpact: 0,
      summary: `未知能力：${request.capabilityId}`,
      errors: [{ message: `未知能力：${request.capabilityId}` }],
      actor,
    };
  }

  const raw = request.input === undefined ? {} : request.input;
  const parsed = toZod(capability.fields).safeParse(raw);
  if (!parsed.success) {
    const errors = zodIssuesToErrors(parsed.error);
    const issues = errorsToIssues(errors);
    const auditId = recordWrite(
      capability,
      {
        input: raw,
        actor,
        effectiveImpact: capability.impact,
        outcome: "rejected",
        stage: "schema",
        issues,
        summary: "输入未通过校验",
        undoable: false,
      },
      flags,
    );
    return rejectedResult(
      capability,
      actor,
      capability.impact,
      "输入未通过校验",
      "schema",
      errors,
      issues,
      auditId,
    );
  }

  const input = parsed.data as Record<string, unknown>;
  const valueErrors = validateValues(capability.fields, input, getStore());
  if (valueErrors.length > 0) {
    const issues = errorsToIssues(valueErrors);
    const auditId = recordWrite(
      capability,
      {
        input,
        actor,
        effectiveImpact: capability.impact,
        outcome: "rejected",
        stage: "schema",
        issues,
        summary: "输入未通过校验",
        undoable: false,
      },
      flags,
    );
    return rejectedResult(
      capability,
      actor,
      capability.impact,
      "输入未通过校验",
      "schema",
      valueErrors,
      issues,
      auditId,
    );
  }

  const issues =
    capability.verify?.(input, { store: getStore(), actor }) ?? [];
  const warns = issues.filter((issue) => issue.level === "warn");
  const blocks = issues.filter((issue) => issue.level === "block");
  const effectiveImpact = weight(capability.impact, warns.length);

  if (blocks.length > 0) {
    const summary = blocks.map((issue) => issue.message).join("；");
    const errors = blocks.map((issue) => ({
      field: issue.field,
      message: issue.message,
    }));
    const auditId = recordWrite(
      capability,
      {
        input,
        actor,
        effectiveImpact,
        outcome: "rejected",
        stage: "verifier",
        issues,
        summary,
        undoable: false,
      },
      flags,
    );
    return rejectedResult(
      capability,
      actor,
      effectiveImpact,
      summary,
      "verifier",
      errors,
      issues,
      auditId,
    );
  }

  if (shouldReview(capability, actor, effectiveImpact, flags.humanApproved)) {
    const reasons = gateReasons(capability.id, effectiveImpact);
    const approval = createApproval({
      capabilityId: capability.id,
      input,
      actor,
      effectiveImpact,
      reasons,
      issues: warns,
    });
    const auditId = recordWrite(
      capability,
      {
        input,
        actor,
        effectiveImpact,
        outcome: "pending_approval",
        stage: "gate",
        issues: warns,
        summary: "该操作需要人工审核",
        approvalId: approval.id,
        undoable: false,
      },
      flags,
    );
    return {
      status: "pending_approval",
      capabilityId: capability.id,
      impact: capability.impact,
      effectiveImpact,
      summary: "该操作需要人工审核",
      issues: warns,
      approvalId: approval.id,
      reasons,
      stage: "gate",
      actor,
      ...(auditId ? { auditId } : {}),
    };
  }

  try {
    const inputSnapshot = clone(input);
    const executed = capability.execute(input, { store: getStore(), actor });
    const outcome = flags.approvalId ? "approved_executed" : "executed";
    const auditId = recordWrite(
      capability,
      {
        input: inputSnapshot,
        actor,
        effectiveImpact,
        outcome,
        stage: "execute",
        issues: warns,
        summary: executed.summary,
        approvalId: flags.approvalId,
        undoData: executed.undoData,
        undoable: typeof capability.undo === "function",
      },
      flags,
    );
    return {
      status: "executed",
      capabilityId: capability.id,
      impact: capability.impact,
      effectiveImpact,
      summary: executed.summary,
      ...(executed.data === undefined ? {} : { data: clone(executed.data) }),
      ...(executed.records === undefined
        ? {}
        : { records: clone(executed.records) }),
      issues: warns,
      stage: "execute",
      actor,
      ...(flags.approvalId ? { approvalId: flags.approvalId } : {}),
      ...(auditId ? { auditId } : {}),
    };
  } catch (error) {
    if (!isDomainError(error)) throw error;
    const errors: FieldError[] = [
      error.field
        ? { field: error.field, message: error.message }
        : { message: error.message },
    ];
    const executeIssues: Issue[] = [
      ...warns,
      {
        level: "block",
        ...(error.field ? { field: error.field } : {}),
        message: error.message,
      },
    ];
    const auditId = recordWrite(
      capability,
      {
        input,
        actor,
        effectiveImpact,
        outcome: "rejected",
        stage: "execute",
        issues: executeIssues,
        summary: error.message,
        undoable: false,
      },
      flags,
    );
    return rejectedResult(
      capability,
      actor,
      effectiveImpact,
      error.message,
      "execute",
      errors,
      executeIssues,
      auditId,
    );
  }
}

export function decideApproval(
  id: string,
  decision: "approve" | "reject",
  note?: string,
): DecisionSuccess | DecisionFailure {
  const approval = findApproval(id);
  if (!approval) {
    return { ok: false, status: 404, message: `找不到审批「${id}」` };
  }
  if (approval.status !== "pending") {
    const state = approval.status === "approved" ? "通过" : "驳回";
    return {
      ok: false,
      status: 409,
      message: `审批 ${id} 已${state}，不能重复决定`,
    };
  }

  const trimmed = note?.trim();
  approval.decidedAt = new Date().toISOString();
  if (trimmed) approval.note = trimmed;

  if (decision === "reject") {
    approval.status = "rejected";
    approval.resultSummary = trimmed || "已驳回，未执行";
    appendAudit({
      capabilityId: approval.capabilityId,
      input: approval.input,
      actor: approval.actor,
      effectiveImpact: approval.effectiveImpact,
      outcome: "approval_rejected",
      stage: "gate",
      issues: approval.issues,
      summary: `审批 ${approval.id} 已驳回，未执行`,
      approvalId: approval.id,
      undoable: false,
    });
    return { ok: true, approval };
  }

  const result = run(
    {
      capabilityId: approval.capabilityId,
      input: approval.input,
      actor: approval.actor,
    },
    { humanApproved: true, approvalId: approval.id, auditRejection: false },
  );
  approval.resultSummary = result.summary;
  if (result.status === "executed") {
    approval.status = "approved";
    return { ok: true, approval, result };
  }

  approval.status = "rejected";
  const entry = appendAudit({
    capabilityId: approval.capabilityId,
    input: approval.input,
    actor: approval.actor,
    effectiveImpact: result.effectiveImpact,
    outcome: "approval_rejected",
    stage: result.stage,
    issues: result.issues ?? [],
    summary: `审批 ${approval.id} 未执行：${result.summary}`,
    approvalId: approval.id,
    undoable: false,
  });
  return { ok: true, approval, result: { ...result, auditId: entry.id } };
}
