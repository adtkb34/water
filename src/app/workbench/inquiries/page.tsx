"use client";

import { Fragment } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyBlock, ErrorBlock, messageOf, TableSkeleton } from "@/components/workbench/feedback";
import { AssistantLink } from "@/components/workbench/assistant-link";
import { PageHeader } from "@/components/workbench/page-header";
import { SpecDialog, useSpecDialog } from "@/components/workbench/spec-dialog";
import type { Inquiry, Product, Supplier } from "@/lib/contract/types";
import { inquiryCreateSpecs, inquiryRowSpecs, prefillRef } from "@/lib/client/specs";
import { useStore, useWorkbenchHost } from "@/lib/client/use-store";
import { SmartTable } from "@/smart-ui";

function productName(products: Product[], productId: string): string {
  return products.find((product) => product.id === productId)?.name ?? productId;
}

function supplierNames(suppliers: Supplier[], ids: string[]): string {
  return ids
    .map((id) => suppliers.find((supplier) => supplier.id === id)?.name ?? id)
    .join("、");
}

function toRecord(
  inquiry: Inquiry,
  products: Product[],
  suppliers: Supplier[],
): Record<string, unknown> {
  return {
    id: inquiry.id,
    productId: productName(products, inquiry.productId),
    quantity: inquiry.quantity,
    supplierIds: supplierNames(suppliers, inquiry.supplierIds),
    deadline: inquiry.deadline,
    status: inquiry.status,
  };
}

export default function InquiriesPage() {
  const { data, error, isLoading, refresh } = useStore();
  const host = useWorkbenchHost();
  const dialog = useSpecDialog();
  const specs = data?.specs ?? [];
  const creates = inquiryCreateSpecs(specs);
  const liveSpec = dialog.active
    ? (specs.find((spec) => spec.capabilityId === dialog.active?.spec.capabilityId) ??
      dialog.active.spec)
    : undefined;
  const records = (data?.inquiries ?? []).map((inquiry) =>
    toRecord(inquiry, data?.products ?? [], data?.suppliers ?? []),
  );

  return (
    <main className="space-y-4 px-4 py-6">
      <PageHeader title="询价单" description="草稿可以发布，已发布的可以确认中标。">
        {isLoading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          creates.map((spec) => (
            <Fragment key={spec.capabilityId}>
              <Button type="button" onClick={() => dialog.openSpec(spec)}>
                {spec.title}
              </Button>
              <AssistantLink capabilityId={spec.capabilityId} />
            </Fragment>
          ))
        )}
      </PageHeader>
      {isLoading ? (
        <TableSkeleton />
      ) : error ? (
        <ErrorBlock message={messageOf(error)} onRetry={() => void refresh()} />
      ) : records.length === 0 ? (
        <EmptyBlock title="还没有询价单" description="用上方的按钮创建一张草稿。" />
      ) : (
        <Card>
          <CardContent className="px-2">
            <SmartTable
              records={records}
              renderActions={(record) => {
                const status = typeof record.status === "string" ? record.status : "";
                const id = typeof record.id === "string" ? record.id : "";
                return inquiryRowSpecs(specs, status).map((spec) => {
                  const prefill = prefillRef(spec, "inquiry", id);
                  return (
                    <Fragment key={spec.capabilityId}>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => dialog.openSpec(spec, prefill)}
                      >
                        {spec.title}
                      </Button>
                      <AssistantLink capabilityId={spec.capabilityId} prefill={prefill} />
                    </Fragment>
                  );
                });
              }}
            />
          </CardContent>
        </Card>
      )}
      <SpecDialog
        active={dialog.active && liveSpec ? { ...dialog.active, spec: liveSpec } : dialog.active}
        onOpenChange={dialog.onOpenChange}
        host={host}
      />
    </main>
  );
}
