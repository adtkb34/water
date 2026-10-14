import type { InvokeResult } from "@/lib/contract/types";
import { cn } from "@/lib/utils";
import { ImpactBadge } from "@/smart-ui/ImpactBadge";
import { SmartTable } from "@/smart-ui/SmartTable";
import { StatusBadge } from "@/smart-ui/StatusBadge";

export function SmartResult({ result }: { result: InvokeResult }) {
  const issues = result.issues ?? [];
  const issueText = issues.map((issue) => issue.message).join("；");
  const showSummary = result.summary.length > 0 && result.summary !== issueText;
  const issueMessages = new Set(issues.map((issue) => issue.message));
  const extraErrors = (result.errors ?? []).filter(
    (error) => !issueMessages.has(error.message),
  );

  return (
    <section
      aria-live="polite"
      className="space-y-3 rounded-lg border bg-muted/30 p-3"
      data-status={result.status}
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={result.status} />
        <ImpactBadge weight={result.effectiveImpact} prefix="有效权重" />
      </div>
      {showSummary ? <p className="text-sm leading-relaxed">{result.summary}</p> : null}
      {result.approvalId ? (
        <p className="text-sm">
          审批编号 <span className="font-medium">{result.approvalId}</span>
        </p>
      ) : null}
      {result.reasons && result.reasons.length > 0 ? (
        <div>
          <p className="text-xs font-medium text-muted-foreground">原因</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {result.reasons.map((reason, index) => (
              <li key={`${index}-${reason}`}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {issues.length > 0 ? (
        <ul className="space-y-2">
          {issues.map((issue, index) => (
            <li
              key={`${issue.level}-${index}`}
              className={cn(
                "rounded-md px-2 py-1.5 text-sm leading-relaxed font-medium break-words",
                issue.level === "block"
                  ? "bg-red-50 text-red-900"
                  : "bg-amber-50 text-amber-950",
              )}
            >
              {`${issue.level === "block" ? "拦截" : "警告"}：${issue.message}`}
            </li>
          ))}
        </ul>
      ) : null}
      {extraErrors.length > 0 ? (
        <ul className="space-y-1 text-sm text-destructive">
          {extraErrors.map((error, index) => (
            <li key={`${error.field ?? "form"}-${index}`}>{error.message}</li>
          ))}
        </ul>
      ) : null}
      {result.records && result.records.length > 0 ? (
        <SmartTable records={result.records} />
      ) : null}
    </section>
  );
}
