"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ErrorBlock, messageOf, TableSkeleton } from "@/components/workbench/feedback";
import { PageHeader } from "@/components/workbench/page-header";
import { SpecDialog, useSpecDialog } from "@/components/workbench/spec-dialog";
import type { Inquiry, UiSpec } from "@/lib/contract/types";
import { INQUIRY_STATUS_LABEL } from "@/lib/domain";
import { writeSpecs } from "@/lib/client/specs";
import { useAudit, useStore, useWorkbenchHost } from "@/lib/client/use-store";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/smart-ui";

function inquiryDetail(inquiries: Inquiry[]): string {
  const counts = { draft: 0, published: 0, awarded: 0 };
  for (const inquiry of inquiries) counts[inquiry.status] += 1;
  return (["draft", "published", "awarded"] as const)
    .map((status) => `${INQUIRY_STATUS_LABEL[status]} ${counts[status]}`)
    .join(" · ");
}

function groupedWrites(specs: UiSpec[]) {
  const order: string[] = [];
  const groups = new Map<string, UiSpec[]>();
  for (const spec of writeSpecs(specs)) {
    const list = groups.get(spec.moduleLabel);
    if (list) list.push(spec);
    else {
      groups.set(spec.moduleLabel, [spec]);
      order.push(spec.moduleLabel);
    }
  }
  return order.map((label) => ({ label, specs: groups.get(label) ?? [] }));
}

export default function WorkbenchPage() {
  const { data, error, isLoading, refresh } = useStore();
  const audit = useAudit();
  const host = useWorkbenchHost();
  const dialog = useSpecDialog();
  const liveSpec = dialog.active
    ? (data?.specs.find((spec) => spec.capabilityId === dialog.active?.spec.capabilityId) ??
      dialog.active.spec)
    : undefined;

  return (
    <main className="space-y-6 px-4 py-6">
      <PageHeader
        title="总览"
        description="产品、供应商、询价单和待审批的当前数量。"
      />
      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="min-h-28 rounded-xl border p-4">
              <TableSkeleton rows={1} />
            </div>
          ))}
        </div>
      ) : error ? (
        <ErrorBlock message={messageOf(error)} onRetry={() => void refresh()} />
      ) : data ? (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="min-h-28">
              <CardHeader>
                <CardDescription>产品数</CardDescription>
                <CardTitle className="text-2xl tabular-nums">{data.products.length}</CardTitle>
              </CardHeader>
            </Card>
            <Card className="min-h-28">
              <CardHeader>
                <CardDescription>供应商数</CardDescription>
                <CardTitle className="text-2xl tabular-nums">{data.suppliers.length}</CardTitle>
              </CardHeader>
            </Card>
            <Card className="min-h-28">
              <CardHeader>
                <CardDescription>询价单</CardDescription>
                <CardTitle className="text-2xl tabular-nums">{data.inquiries.length}</CardTitle>
                <p className="text-xs text-muted-foreground">{inquiryDetail(data.inquiries)}</p>
              </CardHeader>
            </Card>
            {data.pendingApprovals > 0 ? (
              <Link
                href="/workbench/approvals"
                className="block rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring"
              >
                <Card className="min-h-28 bg-amber-50 ring-amber-500">
                  <CardHeader>
                    <CardDescription>待审批数</CardDescription>
                    <CardTitle className="text-2xl tabular-nums">
                      {data.pendingApprovals}
                    </CardTitle>
                    <p className="text-xs text-amber-900">有操作等待审核，前往处理</p>
                  </CardHeader>
                </Card>
              </Link>
            ) : (
              <Card className="min-h-28">
                <CardHeader>
                  <CardDescription>待审批数</CardDescription>
                  <CardTitle className="text-2xl tabular-nums">0</CardTitle>
                </CardHeader>
              </Card>
            )}
          </section>
          <section className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>快捷操作</CardTitle>
                <CardDescription>打开任意写操作的表单。</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {groupedWrites(data.specs).map((group) => (
                  <div key={group.label} className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">{group.label}</p>
                    <div className="flex flex-wrap gap-2">
                      {group.specs.map((spec) => (
                        <Button
                          key={spec.capabilityId}
                          type="button"
                          variant="outline"
                          onClick={() => dialog.openSpec(spec)}
                        >
                          {spec.title}
                        </Button>
                      ))}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>最近动态</CardTitle>
                <CardDescription>最近 5 条审计记录，新的在前。</CardDescription>
                <CardAction>
                  <Link
                    href="/workbench/audit"
                    className="text-sm text-muted-foreground underline-offset-4 hover:underline"
                  >
                    全部
                  </Link>
                </CardAction>
              </CardHeader>
              <CardContent>
                {audit.isLoading ? (
                  <TableSkeleton rows={3} />
                ) : audit.error ? (
                  <ErrorBlock
                    message={messageOf(audit.error)}
                    onRetry={() => void audit.refresh()}
                  />
                ) : (audit.data?.entries.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    还没有操作记录。在工作台提交之后，这里会显示最近的结果。
                  </p>
                ) : (
                  <ul className="divide-y">
                    {audit.data?.entries.slice(0, 5).map((entry) => {
                      const title =
                        data.specs.find((spec) => spec.capabilityId === entry.capabilityId)
                          ?.title ?? entry.capabilityId;
                      return (
                        <li key={entry.id}>
                          <Link
                            href="/workbench/audit"
                            className={cn(
                              "flex flex-col gap-2 rounded-md py-3 outline-none sm:flex-row sm:items-center sm:justify-between",
                              "hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring",
                            )}
                          >
                            <div className="min-w-0">
                              <p className="text-sm break-words">{entry.summary}</p>
                              <p className="text-xs text-muted-foreground">
                                {title} ·{" "}
                                {new Date(entry.at).toLocaleString("zh-CN", { hour12: false })}
                              </p>
                            </div>
                            <StatusBadge status={entry.outcome} />
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>
          </section>
        </>
      ) : null}
      <SpecDialog
        active={
          dialog.active && liveSpec ? { ...dialog.active, spec: liveSpec } : dialog.active
        }
        onOpenChange={dialog.onOpenChange}
        host={host}
      />
    </main>
  );
}
