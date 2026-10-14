"use client";

import { Card, CardContent } from "@/components/ui/card";
import { EmptyBlock, ErrorBlock, messageOf, TableSkeleton } from "@/components/workbench/feedback";
import { PageHeader } from "@/components/workbench/page-header";
import { useStore } from "@/lib/client/use-store";
import { SmartTable } from "@/smart-ui";

export default function SuppliersPage() {
  const { data, error, isLoading, refresh } = useStore();
  const suppliers = data?.suppliers ?? [];

  return (
    <main className="space-y-4 px-4 py-6">
      <PageHeader title="供应商" description="品类和评分来自参考数据，此页只读。" />
      {isLoading ? (
        <TableSkeleton />
      ) : error ? (
        <ErrorBlock message={messageOf(error)} onRetry={() => void refresh()} />
      ) : suppliers.length === 0 ? (
        <EmptyBlock title="还没有供应商" />
      ) : (
        <Card>
          <CardContent className="px-2">
            <SmartTable records={suppliers.map((supplier) => ({ ...supplier }))} />
          </CardContent>
        </Card>
      )}
    </main>
  );
}
