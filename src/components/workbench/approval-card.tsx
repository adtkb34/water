"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { InputFacts } from "@/components/workbench/input-facts";
import {
  actorLabel,
  approvalStatusText,
  formatTime,
  type InputFact,
} from "@/lib/client/display";
import type { Approval, Issue } from "@/lib/contract/types";
import { cn } from "@/lib/utils";
import { ImpactBadge } from "@/smart-ui";

export interface DecisionResult {
  ok: boolean;
  message?: string;
}

function IssueList({ issues }: { issues: Issue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-1">
      {issues.map((issue, index) => (
        <li
          key={`${issue.level}-${index}`}
          className={cn(
            "rounded-md px-2 py-1 text-sm",
            issue.level === "block" ? "bg-red-50 text-red-900" : "bg-amber-50 text-amber-950",
          )}
        >
          {`${issue.level === "block" ? "拦截" : "警告"}：${issue.message}`}
        </li>
      ))}
    </ul>
  );
}

function ApprovalStatusBadge({ status }: { status: Approval["status"] }) {
  const tone =
    status === "approved"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : status === "rejected"
        ? "border-red-200 bg-red-50 text-red-800"
        : "border-amber-200 bg-amber-50 text-amber-950";
  return (
    <Badge variant="outline" className={cn("h-6 px-2", tone)}>
      {approvalStatusText(status)}
    </Badge>
  );
}

export function ApprovalCard({
  approval,
  title,
  facts,
  onDecide,
}: {
  approval: Approval;
  title: string;
  facts: InputFact[];
  onDecide: (decision: "approve" | "reject", note?: string) => Promise<DecisionResult>;
}) {
  const [decision, setDecision] = useState<"approve" | "reject" | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = approval.status === "pending";
  const warnings = approval.issues.filter((issue) => issue.level === "warn");

  function open(next: "approve" | "reject") {
    setDecision(next);
    setNote("");
    setError("");
  }

  async function confirm() {
    if (!decision) return;
    setBusy(true);
    setError("");
    try {
      const result = await onDecide(decision, note.trim() || undefined);
      if (!result.ok) {
        setError(result.message || "操作失败");
        return;
      }
      setDecision(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-approval={approval.id}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle>{title}</CardTitle>
          {pending ? (
            <ImpactBadge weight={approval.effectiveImpact} prefix="有效权重" />
          ) : (
            <ApprovalStatusBadge status={approval.status} />
          )}
        </div>
        <p className="text-sm text-muted-foreground">{actorLabel(approval.actor)}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {pending ? (
          <>
            {approval.reasons.length > 0 ? (
              <div>
                <p className="text-xs font-medium text-muted-foreground">原因</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                  {approval.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {warnings.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">校验警告</p>
                <IssueList issues={warnings} />
              </div>
            ) : null}
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">请求内容</p>
              <InputFacts facts={facts} />
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              决定时间 {formatTime(approval.decidedAt)}
            </p>
            <p className="text-sm">{approval.resultSummary || "—"}</p>
            {approval.note ? (
              <p className="text-sm text-muted-foreground">备注 {approval.note}</p>
            ) : null}
          </>
        )}
      </CardContent>
      {pending ? (
        <CardFooter className="gap-2 border-t">
          <Button type="button" onClick={() => open("approve")}>
            批准
          </Button>
          <Button type="button" variant="outline" onClick={() => open("reject")}>
            驳回
          </Button>
        </CardFooter>
      ) : null}
      <Dialog
        open={decision !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDecision(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{decision === "reject" ? "驳回" : "批准"}</DialogTitle>
            <DialogDescription>
              {decision === "reject"
                ? "驳回后不会执行。备注可以留空。"
                : "批准时会按当前数据再校验一次。备注可以留空。"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`${approval.id}-note`}>备注</Label>
            <Textarea
              id={`${approval.id}-note`}
              value={note}
              placeholder="可选"
              onChange={(event) => setNote(event.target.value)}
            />
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setDecision(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant={decision === "reject" ? "destructive" : "default"}
              disabled={busy}
              onClick={() => void confirm()}
            >
              {decision === "reject" ? "确认驳回" : "确认批准"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
