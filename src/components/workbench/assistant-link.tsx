import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function assistantChatHref(
  capabilityId: string,
  prefill?: Record<string, unknown>,
): string {
  const params = new URLSearchParams({ cap: capabilityId });
  if (prefill && Object.keys(prefill).length > 0) {
    params.set("prefill", JSON.stringify(prefill));
  }
  return `/chat?${params.toString()}`;
}

export function AssistantLink({
  capabilityId,
  prefill,
}: {
  capabilityId: string;
  prefill?: Record<string, unknown>;
}) {
  return (
    <Link
      href={assistantChatHref(capabilityId, prefill)}
      className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
    >
      让助手帮我
    </Link>
  );
}
