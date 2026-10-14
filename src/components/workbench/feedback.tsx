import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "加载失败，请重试";
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="正在加载">
      <Skeleton className="h-10 w-full" />
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  );
}

export function ErrorBlock({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4"
    >
      <p className="text-sm">{message}</p>
      <Button type="button" variant="outline" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

export function EmptyBlock({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="rounded-xl border border-dashed px-4 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {description ? (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}
