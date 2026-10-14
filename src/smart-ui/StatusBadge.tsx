import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { statusLabel } from "@/smart-ui/labels";

const TONE: Record<string, string> = {
  executed: "border-emerald-200 bg-emerald-50 text-emerald-800",
  approved: "border-emerald-200 bg-emerald-50 text-emerald-800",
  approved_executed: "border-emerald-200 bg-emerald-50 text-emerald-800",
  awarded: "border-emerald-200 bg-emerald-50 text-emerald-800",
  published: "border-sky-200 bg-sky-50 text-sky-800",
  pending: "border-amber-200 bg-amber-50 text-amber-950",
  pending_approval: "border-amber-200 bg-amber-50 text-amber-950",
  draft: "border-border bg-muted text-muted-foreground",
  rejected: "border-red-200 bg-red-50 text-red-800",
  approval_rejected: "border-red-200 bg-red-50 text-red-800",
  reverted: "border-border bg-muted text-muted-foreground",
};

export function StatusBadge({ status }: { status: string }) {
  const label = statusLabel(status) ?? status;
  return (
    <Badge variant="outline" className={cn("h-6 px-2", TONE[status])}>
      {label}
    </Badge>
  );
}
