"use client";

import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApprovalCard } from "@/components/workbench/approval-card";
import { EmptyBlock, ErrorBlock, messageOf } from "@/components/workbench/feedback";
import { PageHeader } from "@/components/workbench/page-header";
import { errorMessage, sendJson } from "@/lib/client/api";
import { directoryFrom, inputFacts, type InputFact } from "@/lib/client/display";
import { useApprovals, useAudit, useStore } from "@/lib/client/use-store";
import type { Approval, InvokeResult, UiSpec } from "@/lib/contract/types";
import { toast } from "sonner";

interface DecisionBody {
  approval?: Approval;
  result?: InvokeResult;
}

function failureText(body: DecisionBody): string {
  const summary = body.approval?.resultSummary || body.result?.summary || "";
  const extra = (body.result?.issues ?? [])
    .filter((issue) => issue.level === "block")
    .map((issue) => issue.message)
    .filter((message) => message && !summary.includes(message));
  const text = [summary, ...extra].filter(Boolean).join("；");
  return text || "当前数据已变化，这次批准没有执行";
}

function factsFor(
  approval: Approval,
  specs: UiSpec[],
  directory: ReturnType<typeof directoryFrom>,
): InputFact[] {
  const spec = specs.find((item) => item.capabilityId === approval.capabilityId);
  return inputFacts(spec, approval.input, directory);
}

export default function ApprovalsPage() {
  const store = useStore();
  const approvals = useApprovals();
  const audit = useAudit();
  const [tab, setTab] = useState("pending");
  const [notice, setNotice] = useState<{ title: string; text: string } | null>(null);
  const specs = store.data?.specs ?? [];
  const directory = store.data ? directoryFrom(store.data) : directoryFrom({
    products: [],
    suppliers: [],
    inquiries: [],
  });
  const items = approvals.data?.approvals ?? [];
  const pending = items.filter((item) => item.status === "pending");
  const handled = items.filter((item) => item.status !== "pending");

  async function refreshAll() {
    await Promise.all([store.refresh(), approvals.refresh(), audit.refresh()]);
  }

  async function decide(approval: Approval, decision: "approve" | "reject", note?: string) {
    const { status, data } = await sendJson(`/api/approvals/${approval.id}`, "POST", {
      decision,
      ...(note ? { note } : {}),
    });
    await refreshAll();
    if (status >= 400) {
      const message = errorMessage(data, status);
      setNotice({ title: "操作没有完成", text: message });
      return { ok: false, message };
    }
    const body = (data ?? {}) as DecisionBody;
    if (decision === "approve" && body.approval?.status === "rejected") {
      const text = `${failureText(body)}。该审批已记为已驳回，数据没有改动。`;
      setNotice({ title: "批准未执行", text });
      return { ok: true };
    }
    setNotice(null);
    toast.success(decision === "approve" ? "已批准并执行" : "已驳回");
    if (decision === "reject") setTab("done");
    return { ok: true };
  }

  return (
    <main className="space-y-4 px-4 py-6">
      <PageHeader
        title="审批"
        description="智能体发起、需要人工确认的操作。批准后才会执行。"
      />
      {notice ? (
        <Alert variant="destructive">
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      ) : null}
      {approvals.isLoading && !approvals.data ? (
        <div className="space-y-3" aria-busy="true" aria-label="正在加载">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-36 w-full" />
        </div>
      ) : approvals.error && !approvals.data ? (
        <ErrorBlock message={messageOf(approvals.error)} onRetry={() => void approvals.refresh()} />
      ) : (
        <Tabs
          value={tab}
          onValueChange={(value) => {
            if (value === "pending" || value === "done") setTab(value);
          }}
        >
          <TabsList>
            <TabsTrigger value="pending">待审批</TabsTrigger>
            <TabsTrigger value="done">已处理</TabsTrigger>
          </TabsList>
          <TabsContent value="pending" className="space-y-3">
            {pending.length === 0 ? (
              <EmptyBlock
                title="没有待审批的操作"
                description="智能体发起且达到审核条件的写操作会出现在这里。"
              />
            ) : (
              pending.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  title={
                    specs.find((spec) => spec.capabilityId === approval.capabilityId)?.title ??
                    approval.capabilityId
                  }
                  facts={factsFor(approval, specs, directory)}
                  onDecide={(decision, note) => decide(approval, decision, note)}
                />
              ))
            )}
          </TabsContent>
          <TabsContent value="done" className="space-y-3">
            {handled.length === 0 ? (
              <EmptyBlock title="还没有处理过的审批" description="批准或驳回之后会列在这里。" />
            ) : (
              handled.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  title={
                    specs.find((spec) => spec.capabilityId === approval.capabilityId)?.title ??
                    approval.capabilityId
                  }
                  facts={factsFor(approval, specs, directory)}
                  onDecide={(decision, note) => decide(approval, decision, note)}
                />
              ))
            )}
          </TabsContent>
        </Tabs>
      )}
    </main>
  );
}
