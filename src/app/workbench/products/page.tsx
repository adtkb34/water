"use client";

import { Fragment, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyBlock, ErrorBlock, messageOf, TableSkeleton } from "@/components/workbench/feedback";
import { AssistantLink } from "@/components/workbench/assistant-link";
import { PageHeader } from "@/components/workbench/page-header";
import { SpecDialog, useSpecDialog } from "@/components/workbench/spec-dialog";
import { moduleWriteSpecs } from "@/lib/client/specs";
import { useStore, useWorkbenchHost } from "@/lib/client/use-store";
import { SmartTable } from "@/smart-ui";

export default function ProductsPage() {
  const { data, error, isLoading, refresh } = useStore();
  const host = useWorkbenchHost();
  const dialog = useSpecDialog();
  const [query, setQuery] = useState("");
  const creates = moduleWriteSpecs(data?.specs ?? [], "product");
  const liveSpec = dialog.active
    ? (data?.specs.find((spec) => spec.capabilityId === dialog.active?.spec.capabilityId) ??
      dialog.active.spec)
    : undefined;
  const keyword = query.trim().toLowerCase();
  const products = (data?.products ?? []).filter((product) => {
    if (!keyword) return true;
    return [product.id, product.name, product.category, product.unit, String(product.referencePrice)]
      .join(" ")
      .toLowerCase()
      .includes(keyword);
  });

  return (
    <main className="space-y-4 px-4 py-6">
      <PageHeader title="产品" description="按名称、编号、品类或单位筛选。">
        <div className="w-full sm:w-56">
          <Label htmlFor="product-search" className="sr-only">
            搜索产品
          </Label>
          <Input
            id="product-search"
            value={query}
            placeholder="搜索产品"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {isLoading
          ? <Skeleton className="h-8 w-24" />
          : creates.map((spec) => (
              <Fragment key={spec.capabilityId}>
                <Button type="button" onClick={() => dialog.openSpec(spec)}>
                  {spec.title}
                </Button>
                <AssistantLink capabilityId={spec.capabilityId} />
              </Fragment>
            ))}
      </PageHeader>
      {isLoading ? (
        <TableSkeleton />
      ) : error ? (
        <ErrorBlock message={messageOf(error)} onRetry={() => void refresh()} />
      ) : (data?.products.length ?? 0) === 0 ? (
        <EmptyBlock title="还没有产品" description="用右上角的按钮新建一条。" />
      ) : products.length === 0 ? (
        <EmptyBlock title="没有匹配的产品" description="换一个关键词试试。" />
      ) : (
        <Card>
          <CardContent className="px-2">
            <SmartTable records={products.map((product) => ({ ...product }))} />
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
