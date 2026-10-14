import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function impactTier(weight: number): { label: string; className: string } {
  if (weight <= 2) {
    return {
      label: "低",
      className: "border-emerald-200 bg-emerald-50 text-emerald-800",
    };
  }
  if (weight <= 5) {
    return {
      label: "中",
      className: "border-sky-200 bg-sky-50 text-sky-800",
    };
  }
  if (weight <= 8) {
    return {
      label: "较高",
      className: "border-amber-200 bg-amber-50 text-amber-950",
    };
  }
  return {
    label: "高",
    className: "border-red-200 bg-red-50 text-red-800",
  };
}

export function ImpactBadge({
  weight,
  prefix = "权重",
}: {
  weight: number;
  prefix?: string;
}) {
  const tier = impactTier(weight);
  return (
    <Badge
      variant="outline"
      className={cn("h-6 px-2", tier.className)}
      title={`影响权重 ${weight}（0-10），${tier.label}`}
    >
      {prefix} {weight} · {tier.label}
    </Badge>
  );
}
