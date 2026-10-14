"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import { useCapabilities, type CapabilityTool } from "@/lib/client/use-store";
import { buttonVariants } from "@/components/ui/button";
import { ImpactBadge } from "@/smart-ui";
import { cn } from "@/lib/utils";

function reviewText(tool: CapabilityTool): string {
  if (tool.kind !== "write") return "只读";
  return tool.requiresReview ? "需要审核" : "自动执行";
}

function subscribeOrigin() {
  return () => {};
}

function readOrigin() {
  return window.location.origin;
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success("已复制");
  } catch {
    toast.error("复制失败");
  }
}

export default function ConnectPage() {
  const capabilities = useCapabilities();
  const origin = useSyncExternalStore(subscribeOrigin, readOrigin, () => "");
  const endpoint = origin ? `${origin}/api/mcp` : "";
  const snippet = endpoint
    ? JSON.stringify(
        { mcpServers: { "agent-native-prototype": { url: endpoint } } },
        null,
        2,
      )
    : "";
  const tools = capabilities.data?.tools ?? [];

  return (
    <main className="space-y-4 px-4 py-6">
      <PageHeader
        title="接入说明"
        description="外部智能体通过 MCP 调用同一套能力。批准不在 MCP 里。"
      />
      <Alert>
        <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <span>
            能力工具、show_form 和审批查询都绑定了同一份智能界面。外部宿主按 MCP Apps 渲染；不支持界面的客户端仍可读文字结果。
          </span>
          <Link href="/host-sim" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            宿主模拟
          </Link>
        </AlertDescription>
      </Alert>
      <Card>
        <CardHeader>
          <CardTitle>MCP 地址</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {endpoint ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <code className="min-w-0 flex-1 break-all rounded-lg bg-muted px-3 py-2 text-sm">
                {endpoint}
              </code>
              <Button type="button" variant="outline" onClick={() => void copyText(endpoint)}>
                复制
              </Button>
            </div>
          ) : (
            <TableSkeleton rows={1} />
          )}
          {snippet ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">客户端配置</p>
                <Button type="button" size="sm" variant="outline" onClick={() => void copyText(snippet)}>
                  复制
                </Button>
              </div>
              <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs leading-relaxed">
                {snippet}
              </pre>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>审批怎么走</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>智能体只能提交，不能自己批准或驳回。</li>
            <li>写操作按当前策略决定直接执行还是进入待审批；读操作不进审批。</li>
            <li>批准只能由人在工作台完成。</li>
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>工具</CardTitle>
        </CardHeader>
        <CardContent>
          {capabilities.isLoading && !capabilities.data ? (
            <TableSkeleton rows={4} />
          ) : capabilities.error && !capabilities.data ? (
            <ErrorBlock
              message={messageOf(capabilities.error)}
              onRetry={() => void capabilities.refresh()}
            />
          ) : tools.length === 0 ? (
            <p className="text-sm text-muted-foreground">没有可用工具。</p>
          ) : (
            <ScrollArea className="h-80 w-full">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>工具名</TableHead>
                    <TableHead>能力</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>权重</TableHead>
                    <TableHead>智能体</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tools.map((tool) => (
                    <TableRow key={tool.id}>
                      <TableCell className="font-mono text-xs">{tool.toolName}</TableCell>
                      <TableCell>{tool.title}</TableCell>
                      <TableCell>{tool.kind === "write" ? "写" : "读"}</TableCell>
                      <TableCell>
                        <ImpactBadge weight={tool.impact} prefix="权重" />
                      </TableCell>
                      <TableCell>{reviewText(tool)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
