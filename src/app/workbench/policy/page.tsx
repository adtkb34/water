"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ErrorBlock, messageOf, TableSkeleton } from "@/components/workbench/feedback";
import { PageHeader } from "@/components/workbench/page-header";
import { errorMessage, sendJson } from "@/lib/client/api";
import { agentNeedsReview } from "@/lib/client/policy-preview";
import { writeSpecs } from "@/lib/client/specs";
import { useStore } from "@/lib/client/use-store";
import type { Policy, UiSpec } from "@/lib/contract/types";
import { ImpactBadge } from "@/smart-ui";

const POLICY_SENTENCE =
  "人工提交视为已审核；智能体发起的操作按权重和下面的名单决定是否进入审批。";

function policyKey(policy: Policy): string {
  return `${policy.threshold}|${[...policy.alwaysReview].sort().join("\n")}`;
}

function isPolicy(value: unknown): value is Policy {
  if (!value || typeof value !== "object") return false;
  const record = value as { threshold?: unknown; alwaysReview?: unknown };
  return (
    typeof record.threshold === "number" &&
    Array.isArray(record.alwaysReview) &&
    record.alwaysReview.every((id) => typeof id === "string")
  );
}

function copyPolicy(policy: Policy): Policy {
  return { threshold: policy.threshold, alwaysReview: [...policy.alwaysReview] };
}

export default function PolicyPage() {
  const store = useStore();
  if (store.isLoading && !store.data) {
    return (
      <main className="space-y-4 px-4 py-6">
        <PageHeader title="策略设置" description={POLICY_SENTENCE} />
        <TableSkeleton rows={4} />
      </main>
    );
  }
  if ((store.error && !store.data) || !store.data) {
    return (
      <main className="space-y-4 px-4 py-6">
        <PageHeader title="策略设置" description={POLICY_SENTENCE} />
        <ErrorBlock message={messageOf(store.error)} onRetry={() => void store.refresh()} />
      </main>
    );
  }
  return (
    <PolicyEditor
      saved={store.data.policy}
      specs={writeSpecs(store.data.specs)}
      onSaved={() => store.refresh()}
    />
  );
}

function PolicyEditor({
  saved,
  specs,
  onSaved,
}: {
  saved: Policy;
  specs: UiSpec[];
  onSaved: () => Promise<unknown>;
}) {
  const [override, setOverride] = useState<Policy | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  if (override && policyKey(override) === policyKey(saved)) {
    setOverride(null);
  }
  const draft = override ?? saved;
  const dirty = policyKey(draft) !== policyKey(saved);

  function setThreshold(threshold: number) {
    setOverride({ threshold, alwaysReview: [...draft.alwaysReview] });
  }

  function setListed(id: string, listed: boolean) {
    const rest = draft.alwaysReview.filter((item) => item !== id);
    setOverride({
      threshold: draft.threshold,
      alwaysReview: listed ? [...rest, id] : rest,
    });
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const { status, data } = await sendJson("/api/policy", "PUT", {
        threshold: draft.threshold,
        alwaysReview: draft.alwaysReview,
      });
      if (status !== 200 || !isPolicy(data)) {
        const message = errorMessage(data, status);
        setError(message);
        toast.error(message);
        return;
      }
      setOverride(copyPolicy(data));
      toast.success("策略已保存");
      await onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="space-y-4 px-4 py-6">
      <PageHeader title="策略设置" description={POLICY_SENTENCE}>
        <Button
          type="button"
          variant="outline"
          disabled={!dirty || saving}
          onClick={() => {
            setOverride(null);
            setError("");
          }}
        >
          恢复已保存
        </Button>
        <Button type="button" disabled={!dirty || saving} onClick={() => void save()}>
          保存
        </Button>
      </PageHeader>
      {dirty ? (
        <p className="text-sm text-amber-800">预览已按未保存的设置更新，保存后才会生效。</p>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>没有保存</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="max-w-xl space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <Label id="policy-threshold-label">审核阈值</Label>
          <span className="text-sm tabular-nums">{draft.threshold}</span>
        </div>
        <Slider
          aria-labelledby="policy-threshold-label"
          min={0}
          max={10}
          step={1}
          value={[draft.threshold]}
          onValueChange={(value) => {
            const next = Array.isArray(value) ? value[0] : value;
            if (typeof next !== "number" || !Number.isFinite(next)) return;
            setThreshold(Math.round(next));
          }}
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>0</span>
          <span>10</span>
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>能力</TableHead>
            <TableHead>基础权重</TableHead>
            <TableHead>必须人工审核</TableHead>
            <TableHead>预览</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {specs.map((spec) => {
            const listed = draft.alwaysReview.includes(spec.capabilityId);
            const needsReview = agentNeedsReview({
              kind: "write",
              impact: spec.impact,
              capabilityId: spec.capabilityId,
              threshold: draft.threshold,
              alwaysReview: draft.alwaysReview,
            });
            return (
              <TableRow key={spec.capabilityId} data-capability={spec.capabilityId}>
                <TableCell>
                  <div className="font-medium">{spec.title}</div>
                  <div className="text-xs text-muted-foreground">{spec.moduleLabel}</div>
                </TableCell>
                <TableCell>
                  <ImpactBadge weight={spec.impact} prefix="基础" />
                </TableCell>
                <TableCell>
                  <Switch
                    id={`review-${spec.capabilityId}`}
                    checked={listed}
                    aria-label={`${spec.title}必须人工审核`}
                    onCheckedChange={(checked) => setListed(spec.capabilityId, checked)}
                  />
                </TableCell>
                <TableCell data-preview={spec.capabilityId}>
                  <span className={needsReview ? "text-amber-800" : "text-emerald-800"}>
                    {needsReview ? "需要审核" : "自动执行"}
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">
        预览只看基础权重和上面的未保存设置。业务校验的警告会在运行时每条再给权重 +2。
      </p>
    </main>
  );
}
