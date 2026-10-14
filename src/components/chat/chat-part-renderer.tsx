"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai";
import { Suggestion } from "@/components/ai-elements/suggestion";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ApprovalCard } from "@/components/workbench/approval-card";
import {
  EMPTY_DIRECTORY,
  inputFacts,
  type RefDirectory,
} from "@/lib/client/display";
import {
  SHOW_FORM_TOOL,
  nextSteps,
  readInvokeResult,
  readMcpForm,
  readShowFormInput,
  readSubmittedValues,
  workbenchPath,
} from "@/lib/client/guided";
import { toolNameForCapability } from "@/lib/mcp/names";
import type { Approval, InvokeResult, UiSpec } from "@/lib/contract/types";
import { SmartForm, SmartResult, type SmartUiHost } from "@/smart-ui";
import { cn } from "@/lib/utils";

export type ChatActor = "human" | "agent";

const lockedHost: SmartUiHost = {
  async invoke(capabilityId) {
    return {
      status: "rejected",
      capabilityId,
      impact: 0,
      effectiveImpact: 0,
      summary: "这张表单已经提交",
    };
  },
};

export function ChatPartRenderer({
  part,
  specs,
  directory = EMPTY_DIRECTORY,
  approvals = [],
  onInvoke,
  onDecide,
  onStart,
  onResult,
  onFormFollowUp,
}: {
  part: ToolUIPart | DynamicToolUIPart;
  specs: UiSpec[];
  directory?: RefDirectory;
  approvals?: Approval[];
  onInvoke?: (
    capabilityId: string,
    input: Record<string, unknown>,
    actor: ChatActor,
  ) => Promise<InvokeResult>;
  onDecide?: (
    approval: Approval,
    decision: "approve" | "reject",
    note?: string,
  ) => Promise<{ ok: boolean; message?: string }>;
  onStart?: (spec: UiSpec, prefill?: Record<string, unknown>) => void;
  onResult?: (toolCallId: string, output: unknown) => void;
  onFormFollowUp?: (toolCallId: string, output: unknown, summary: string) => void;
}) {
  const toolName = getToolName(part);
  if (toolName === SHOW_FORM_TOOL) {
    return (
      <FormCard
        part={part}
        specs={specs}
        directory={directory}
        approvals={approvals}
        onInvoke={onInvoke}
        onDecide={onDecide}
        onStart={onStart}
        onResult={onResult}
        onFormFollowUp={onFormFollowUp}
      />
    );
  }

  const spec = specs.find((item) => toolNameForCapability(item.capabilityId) === toolName);
  if (part.state === "output-error") {
    return <p className="text-sm text-destructive">{part.errorText}</p>;
  }
  if (part.state !== "output-available") {
    return <p className="text-sm text-muted-foreground">正在准备结果…</p>;
  }
  const result = readInvokeResult(part.output);
  if (!result) {
    return <p className="text-sm text-muted-foreground">这个工具没有返回可展示的结果。</p>;
  }
  return (
    <ResultCard
      toolName={toolName}
      spec={spec}
      result={result}
      submitted={toolSubmitted(part)}
      specs={specs}
      directory={directory}
      approvals={approvals}
      onDecide={onDecide}
      onStart={onStart}
    />
  );
}

function FormCard({
  part,
  specs,
  directory,
  approvals,
  onInvoke,
  onDecide,
  onStart,
  onResult,
  onFormFollowUp,
}: {
  part: ToolUIPart | DynamicToolUIPart;
  specs: UiSpec[];
  directory: RefDirectory;
  approvals: Approval[];
  onInvoke?: (
    capabilityId: string,
    input: Record<string, unknown>,
    actor: ChatActor,
  ) => Promise<InvokeResult>;
  onDecide?: (
    approval: Approval,
    decision: "approve" | "reject",
    note?: string,
  ) => Promise<{ ok: boolean; message?: string }>;
  onStart?: (spec: UiSpec, prefill?: Record<string, unknown>) => void;
  onResult?: (toolCallId: string, output: unknown) => void;
  onFormFollowUp?: (toolCallId: string, output: unknown, summary: string) => void;
}) {
  const mcpForm = part.state === "output-available" ? readMcpForm(part.output) : null;
  const formInput =
    readShowFormInput(part.input) ??
    (mcpForm ? { capabilityId: mcpForm.capabilityId, ...(mcpForm.prefill ? { prefill: mcpForm.prefill } : {}) } : null);
  const spec = formInput
    ? specs.find((item) => item.capabilityId === formInput.capabilityId) ?? mcpForm?.uiSpec
    : undefined;
  const invokeOutput = part.state === "output-available" && !mcpForm ? readInvokeResult(part.output) : null;
  const [localFinished, setLocalFinished] = useState<InvokeResult | null>(null);
  const [localSubmitted, setLocalSubmitted] = useState<Record<string, unknown> | null>(null);
  const finished = localFinished ?? invokeOutput;
  const locked = Boolean(finished && finished.status !== "rejected");
  const [actor, setActor] = useState<ChatActor>("human");

  if (!formInput || !spec) {
    return <p className="text-sm text-muted-foreground">暂时找不到这个能力的表单。</p>;
  }

  const host: SmartUiHost = {
    async invoke(capabilityId, input) {
      if (!onInvoke) {
        throw new Error("提交没有接上");
      }
      const result = await onInvoke(capabilityId, input, actor);
      if (result.status !== "rejected") {
        const output = { ...result, submitted: input };
        if (mcpForm && onFormFollowUp) {
          setLocalFinished(result);
          setLocalSubmitted(input);
          onFormFollowUp(part.toolCallId, output, result.summary);
        } else {
          onResult?.(part.toolCallId, output);
        }
      }
      return result;
    },
  };

  return (
    <CardShell spec={spec} toolName={SHOW_FORM_TOOL} state={locked ? "locked" : part.state}>
      <SmartForm
        key={locked ? `${part.toolCallId}:locked` : part.toolCallId}
        spec={spec}
        host={locked ? lockedHost : host}
        initialValues={locked ? localSubmitted ?? readSubmittedValues(part.output) : formInput.prefill}
        hideHeading
        readOnly={locked}
        submitAccessory={<ActorToggle actor={actor} onChange={setActor} />}
      />
      {finished && locked ? (
        <ResultBody
          result={finished}
          submitted={localSubmitted ?? readSubmittedValues(part.output)}
          spec={spec}
          specs={specs}
          directory={directory}
          approvals={approvals}
          onDecide={onDecide}
          onStart={onStart}
        />
      ) : null}
    </CardShell>
  );
}

function ResultCard({
  toolName,
  spec,
  result,
  submitted,
  specs,
  directory,
  approvals,
  onDecide,
  onStart,
}: {
  toolName: string;
  spec: UiSpec | undefined;
  result: InvokeResult;
  submitted: Record<string, unknown>;
  specs: UiSpec[];
  directory: RefDirectory;
  approvals: Approval[];
  onDecide?: (
    approval: Approval,
    decision: "approve" | "reject",
    note?: string,
  ) => Promise<{ ok: boolean; message?: string }>;
  onStart?: (spec: UiSpec, prefill?: Record<string, unknown>) => void;
}) {
  return (
    <CardShell spec={spec} toolName={toolName} state="result">
      <ResultBody
        result={result}
        submitted={submitted}
        spec={spec}
        specs={specs}
        directory={directory}
        approvals={approvals}
        onDecide={onDecide}
        onStart={onStart}
      />
    </CardShell>
  );
}

function ResultBody({
  result,
  submitted,
  spec,
  specs,
  directory,
  approvals,
  onDecide,
  onStart,
}: {
  result: InvokeResult;
  submitted: Record<string, unknown>;
  spec: UiSpec | undefined;
  specs: UiSpec[];
  directory: RefDirectory;
  approvals: Approval[];
  onDecide?: (
    approval: Approval,
    decision: "approve" | "reject",
    note?: string,
  ) => Promise<{ ok: boolean; message?: string }>;
  onStart?: (spec: UiSpec, prefill?: Record<string, unknown>) => void;
}) {
  const steps = onStart ? nextSteps(specs, result) : [];
  const approvalId = result.approvalId;
  const live = approvalId ? approvals.find((item) => item.id === approvalId) : undefined;
  const showApproval = result.status === "pending_approval" && Boolean(approvalId);
  return (
    <div className="space-y-3">
      {showApproval && approvalId ? (
        <div data-testid="chat-approval">
          <ApprovalCard
            approval={
              live ?? {
                id: approvalId,
                capabilityId: result.capabilityId,
                input: submitted,
                actor: result.actor ?? { kind: "agent", surface: "llm" },
                effectiveImpact: result.effectiveImpact,
                reasons: result.reasons ?? [],
                issues: result.issues ?? [],
                status: "pending",
                createdAt: "",
              }
            }
            title={spec?.title ?? result.capabilityId}
            facts={inputFacts(spec, live?.input ?? submitted, directory)}
            onDecide={(decision, note) => {
              const approval = live ?? {
                id: approvalId,
                capabilityId: result.capabilityId,
                input: submitted,
                actor: result.actor ?? { kind: "agent", surface: "llm" },
                effectiveImpact: result.effectiveImpact,
                reasons: result.reasons ?? [],
                issues: result.issues ?? [],
                status: "pending" as const,
                createdAt: "",
              };
              if (!onDecide) return Promise.resolve({ ok: false, message: "暂时不能审批" });
              return onDecide(approval, decision, note);
            }}
          />
        </div>
      ) : (
        <div data-testid="chat-result">
          <SmartResult result={result} />
        </div>
      )}
      {steps.length > 0 && onStart ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">接下来</p>
          <div className="flex flex-wrap gap-2">
            {steps.map((step) => (
              <Suggestion
                key={step.spec.capabilityId}
                suggestion={step.spec.title}
                onClick={() => onStart(step.spec, step.prefill)}
              >
                {step.spec.title}
              </Suggestion>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CardShell({
  spec,
  toolName,
  state,
  children,
}: {
  spec?: UiSpec;
  toolName: string;
  state: string;
  children: ReactNode;
}) {
  return (
    <Card className="w-full" data-tool={toolName} data-state={state} data-testid="chat-card">
      {spec ? (
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <CardTitle>{spec.title}</CardTitle>
            <Link
              href={workbenchPath(spec)}
              className={cn(buttonVariants({ variant: "link", size: "sm" }), "h-auto px-0")}
            >
              在工作台中打开
            </Link>
          </div>
          {spec.description ? <CardDescription>{spec.description}</CardDescription> : null}
        </CardHeader>
      ) : null}
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

function toolSubmitted(part: ToolUIPart | DynamicToolUIPart): Record<string, unknown> {
  const fromOutput = readSubmittedValues(part.output);
  if (Object.keys(fromOutput).length > 0) return fromOutput;
  if (!part.input || typeof part.input !== "object" || Array.isArray(part.input)) return {};
  const record = { ...(part.input as Record<string, unknown>) };
  delete record.actor;
  return record;
}

function ActorToggle({
  actor,
  onChange,
}: {
  actor: ChatActor;
  onChange: (actor: ChatActor) => void;
}) {
  const options = [
    ["human", "我来提交"],
    ["agent", "交给智能体提交"],
  ] as const;
  return (
    <div className="space-y-1">
      <div role="radiogroup" aria-label="提交身份" className="inline-flex rounded-lg bg-muted p-0.5">
        {options.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={actor === value}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs",
              actor === value ? "bg-background font-medium shadow-sm" : "text-muted-foreground",
            )}
            onClick={() => onChange(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {actor === "agent" ? (
        <p className="text-xs text-muted-foreground">将以智能体身份提交，可能进入人工审核。</p>
      ) : null}
    </div>
  );
}
