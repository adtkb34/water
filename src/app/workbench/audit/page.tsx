"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { InputFacts } from "@/components/workbench/input-facts";
import { EmptyBlock, ErrorBlock, messageOf, TableSkeleton } from "@/components/workbench/feedback";
import { PageHeader } from "@/components/workbench/page-header";
import { errorMessage, sendJson } from "@/lib/client/api";
import {
  actorLabel,
  directoryFrom,
  formatTime,
  inputFacts,
  revertBlockReason,
} from "@/lib/client/display";
import { useAudit, useStore } from "@/lib/client/use-store";
import type { AuditEntry, AuditOutcome } from "@/lib/contract/types";
import { cn } from "@/lib/utils";
import { ImpactBadge, StatusBadge } from "@/smart-ui";
import { statusLabel } from "@/smart-ui/labels";

const OUTCOMES: AuditOutcome[] = [
  "executed",
  "pending_approval",
  "rejected",
  "approved_executed",
  "approval_rejected",
  "reverted",
];

const outcomeItems = [
  { value: "all", label: "全部结果" },
  ...OUTCOMES.map((outcome) => ({
    value: outcome,
    label: statusLabel(outcome) ?? outcome,
  })),
];

const actorItems = [
  { value: "all", label: "全部来源" },
  { value: "human", label: "人工" },
  { value: "agent", label: "智能体" },
];

function titleOf(specs: { capabilityId: string; title: string }[], id: string): string {
  return specs.find((spec) => spec.capabilityId === id)?.title ?? id;
}

export default function AuditPage() {
  const store = useStore();
  const audit = useAudit();
  const [outcome, setOutcome] = useState("all");
  const [actor, setActor] = useState("all");
  const [unreviewed, setUnreviewed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [revertError, setRevertError] = useState("");
  const [busy, setBusy] = useState(false);
  const specs = store.data?.specs ?? [];
  const directory = store.data
    ? directoryFrom(store.data)
    : directoryFrom({ products: [], suppliers: [], inquiries: [] });
  const entries = audit.data?.entries ?? [];
  const visible = entries.filter((entry) => {
    if (outcome !== "all" && entry.outcome !== outcome) return false;
    if (actor !== "all" && entry.actor.kind !== actor) return false;
    if (unreviewed && entry.review) return false;
    return true;
  });
  const selected = entries.find((entry) => entry.id === selectedId) ?? null;

  function openEntry(entry: AuditEntry) {
    setSelectedId(entry.id);
    setNote("");
    setConfirming(false);
    setRevertError("");
  }

  async function refreshAll() {
    await Promise.all([store.refresh(), audit.refresh()]);
  }

  async function mark(entry: AuditEntry, mark: "ok" | "flagged") {
    setBusy(true);
    try {
      const trimmed = note.trim();
      const { status, data } = await sendJson(`/api/audit/${entry.id}/review`, "POST", {
        mark,
        ...(trimmed ? { note: trimmed } : {}),
      });
      if (status !== 200) {
        toast.error(errorMessage(data, status));
        return;
      }
      toast.success(mark === "ok" ? "已标记为正常" : "已标记为有误");
      await audit.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function revert(entry: AuditEntry) {
    setBusy(true);
    setRevertError("");
    try {
      const { status, data } = await sendJson(`/api/audit/${entry.id}/revert`, "POST");
      if (status === 409 || status >= 400) {
        setRevertError(errorMessage(data, status));
        return;
      }
      toast.success("已回滚");
      setConfirming(false);
      await refreshAll();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="space-y-4 px-4 py-6">
      <PageHeader title="审计日志" description="新的记录在前。可以抽查，也可以回滚支持撤销的操作。" />
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="space-y-1">
          <Label htmlFor="audit-outcome">结果</Label>
          <Select
            value={outcome}
            items={outcomeItems}
            onValueChange={(value) => {
              if (typeof value === "string") setOutcome(value);
            }}
          >
            <SelectTrigger id="audit-outcome" className="w-full sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {outcomeItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="audit-actor">来源</Label>
          <Select
            value={actor}
            items={actorItems}
            onValueChange={(value) => {
              if (typeof value === "string") setActor(value);
            }}
          >
            <SelectTrigger id="audit-actor" className="w-full sm:w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {actorItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="flex h-8 items-center gap-2 text-sm">
          <Checkbox
            checked={unreviewed}
            onCheckedChange={(checked) => setUnreviewed(checked)}
          />
          只看未抽查
        </label>
      </div>
      {audit.isLoading && !audit.data ? (
        <TableSkeleton />
      ) : audit.error && !audit.data ? (
        <ErrorBlock message={messageOf(audit.error)} onRetry={() => void audit.refresh()} />
      ) : entries.length === 0 ? (
        <EmptyBlock title="还没有审计记录" description="工作台或智能体的写操作会出现在这里。" />
      ) : visible.length === 0 ? (
        <EmptyBlock title="没有符合筛选条件的记录" description="换一组筛选再看。" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>时间</TableHead>
              <TableHead>能力</TableHead>
              <TableHead>来源</TableHead>
              <TableHead>结果</TableHead>
              <TableHead>有效权重</TableHead>
              <TableHead>摘要</TableHead>
              <TableHead>问题</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell>{formatTime(entry.at)}</TableCell>
                <TableCell>{titleOf(specs, entry.capabilityId)}</TableCell>
                <TableCell>{actorLabel(entry.actor)}</TableCell>
                <TableCell>
                  <StatusBadge status={entry.outcome} />
                </TableCell>
                <TableCell>
                  <ImpactBadge weight={entry.effectiveImpact} prefix="权重" />
                </TableCell>
                <TableCell className="max-w-xs whitespace-normal">{entry.summary}</TableCell>
                <TableCell className="tabular-nums">{entry.issues.length}</TableCell>
                <TableCell>
                  <Button type="button" size="sm" variant="outline" onClick={() => openEntry(entry)}>
                    详情
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setSelectedId(null);
            setConfirming(false);
          }
        }}
      >
        <DialogContent className="max-h-[min(85vh,44rem)] overflow-y-auto sm:max-w-lg">
          {selected ? (
            <AuditDetail
              entry={selected}
              title={titleOf(specs, selected.capabilityId)}
              facts={inputFacts(
                specs.find((spec) => spec.capabilityId === selected.capabilityId),
                selected.input,
                directory,
              )}
              note={note}
              onNote={setNote}
              confirming={confirming}
              revertError={revertError}
              busy={busy}
              onMark={(value) => void mark(selected, value)}
              onAskRevert={() => {
                setRevertError("");
                setConfirming(true);
              }}
              onCancelRevert={() => {
                setConfirming(false);
                setRevertError("");
              }}
              onRevert={() => void revert(selected)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </main>
  );
}

function AuditDetail({
  entry,
  title,
  facts,
  note,
  onNote,
  confirming,
  revertError,
  busy,
  onMark,
  onAskRevert,
  onCancelRevert,
  onRevert,
}: {
  entry: AuditEntry;
  title: string;
  facts: ReturnType<typeof inputFacts>;
  note: string;
  onNote: (value: string) => void;
  confirming: boolean;
  revertError: string;
  busy: boolean;
  onMark: (mark: "ok" | "flagged") => void;
  onAskRevert: () => void;
  onCancelRevert: () => void;
  onRevert: () => void;
}) {
  const blocked = revertBlockReason(entry, title);
  return (
    <>
      <DialogHeader className="pr-8">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {formatTime(entry.at)} · {actorLabel(entry.actor)} · {entry.id}
        </DialogDescription>
      </DialogHeader>
      <ScrollArea className="h-72 w-full pr-3">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={entry.outcome} />
            <ImpactBadge weight={entry.effectiveImpact} prefix="有效权重" />
          </div>
          <p className="text-sm">{entry.summary}</p>
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">输入</p>
            <InputFacts facts={facts} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">校验问题</p>
            {entry.issues.length === 0 ? (
              <p className="text-sm text-muted-foreground">没有校验问题</p>
            ) : (
              <ul className="space-y-1">
                {entry.issues.map((issue, index) => (
                  <li
                    key={`${issue.level}-${index}`}
                    className={cn(
                      "rounded-md px-2 py-1 text-sm",
                      issue.level === "block"
                        ? "bg-red-50 text-red-900"
                        : "bg-amber-50 text-amber-950",
                    )}
                  >
                    {`${issue.level === "block" ? "拦截" : "警告"}：${issue.message}`}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="text-sm">
            撤销：{blocked ?? "这条已执行的记录可以回滚"}
          </p>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">抽查</p>
            {entry.review ? (
              <p className="text-sm">
                {entry.review.mark === "ok" ? "正常" : "有误"}
                {entry.review.note ? ` · ${entry.review.note}` : ""} · {formatTime(entry.review.at)}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">还没有抽查</p>
            )}
            <Label htmlFor={`review-${entry.id}`}>抽查备注</Label>
            <Textarea
              id={`review-${entry.id}`}
              value={note}
              placeholder="可选"
              onChange={(event) => onNote(event.target.value)}
            />
          </div>
        </div>
      </ScrollArea>
      {confirming ? (
        <Alert>
          <AlertTitle>确认回滚</AlertTitle>
          <AlertDescription>将撤销这次已执行的操作，数据恢复到执行前。</AlertDescription>
        </Alert>
      ) : null}
      {revertError ? (
        <Alert variant="destructive">
          <AlertTitle>没有回滚</AlertTitle>
          <AlertDescription>{revertError}</AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter className="sm:flex-wrap">
        <Button type="button" variant="outline" disabled={busy} onClick={() => onMark("ok")}>
          标记抽查「正常」
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => onMark("flagged")}>
          标记抽查「有误」
        </Button>
        {confirming ? (
          <>
            <Button type="button" variant="outline" disabled={busy} onClick={onCancelRevert}>
              取消
            </Button>
            <Button type="button" disabled={busy} onClick={onRevert}>
              确认回滚
            </Button>
          </>
        ) : blocked ? (
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" tabIndex={0} />}>
              <Button type="button" disabled>
                回滚
              </Button>
            </TooltipTrigger>
            <TooltipContent>{blocked}</TooltipContent>
          </Tooltip>
        ) : (
          <Button type="button" disabled={busy} onClick={onAskRevert}>
            回滚
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
