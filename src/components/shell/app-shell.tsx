"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/client/use-store";
import { cn } from "@/lib/utils";

const NAV: { href: string; label: string; exact?: boolean; badge?: boolean }[] = [
  { href: "/workbench", label: "总览", exact: true },
  { href: "/workbench/products", label: "产品" },
  { href: "/workbench/inquiries", label: "询价单" },
  { href: "/workbench/suppliers", label: "供应商" },
  { href: "/workbench/approvals", label: "审批", badge: true },
  { href: "/workbench/audit", label: "审计" },
  { href: "/workbench/policy", label: "策略" },
  { href: "/workbench/connect", label: "接入" },
  { href: "/settings/models", label: "模型设置" },
];

function isActive(pathname: string, href: string, exact?: boolean) {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function segmentClass(active: boolean) {
  return cn(
    "rounded-md px-3 py-1 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring",
    active ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground",
  );
}

function navClass(active: boolean) {
  return cn(
    "flex items-center gap-2 rounded-md px-3 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring",
    active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/70",
  );
}

function NavLinks({
  pathname,
  pending,
  onNavigate,
}: {
  pathname: string;
  pending: number;
  onNavigate?: () => void;
}) {
  return (
    <>
      {NAV.map((item) => {
        const active = isActive(pathname, item.href, item.exact);
        const showBadge = Boolean(item.badge) && pending > 0;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            aria-label={showBadge ? `${item.label}，${pending} 条待处理` : undefined}
            className={navClass(active)}
            onClick={onNavigate}
          >
            <span>{item.label}</span>
            {showBadge ? (
              <Badge className="ml-auto h-5 min-w-5 border-transparent bg-amber-600 px-1 text-white tabular-nums">
                {pending}
              </Badge>
            ) : null}
          </Link>
        );
      })}
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const onWorkbench = pathname.startsWith("/workbench");
  const onChat = pathname.startsWith("/chat");
  const [navOpen, setNavOpen] = useState(false);
  const [workbenchHref, setWorkbenchHref] = useState("/workbench");
  const { data } = useStore();
  const pending = data?.pendingApprovals ?? 0;
  if (onWorkbench && workbenchHref !== pathname) {
    setWorkbenchHref(pathname);
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4">
          {onWorkbench ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="md:hidden"
              aria-label={navOpen ? "收起菜单" : "打开菜单"}
              aria-expanded={navOpen}
              aria-controls="workbench-nav"
              onClick={() => setNavOpen((open) => !open)}
            >
              <Menu />
            </Button>
          ) : null}
          <Link
            href={workbenchHref}
            className="font-semibold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring"
          >
            能力契约
          </Link>
          <div className="ml-auto flex items-center gap-3">
          <Link
            href="/settings/models"
            aria-current={pathname.startsWith("/settings") ? "page" : undefined}
            className={cn(
              "text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring",
              pathname.startsWith("/settings") ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            模型设置
          </Link>
          <nav aria-label="模式">
            <div className="inline-flex rounded-lg bg-muted p-0.5">
              <Link
                href="/chat"
                aria-current={onChat ? "page" : undefined}
                className={segmentClass(onChat)}
              >
                对话
              </Link>
              <Link
                href={workbenchHref}
                aria-current={onWorkbench ? "page" : undefined}
                className={segmentClass(onWorkbench)}
              >
                工作台
              </Link>
            </div>
          </nav>
          </div>
        </div>
        {onWorkbench && navOpen ? (
          <nav
            id="workbench-nav"
            aria-label="工作台"
            className="space-y-1 border-t px-4 py-2 md:hidden"
          >
            <NavLinks
              pathname={pathname}
              pending={pending}
              onNavigate={() => setNavOpen(false)}
            />
          </nav>
        ) : null}
      </header>
      <div className="mx-auto flex w-full max-w-6xl flex-1">
        {onWorkbench ? (
          <aside className="hidden w-48 shrink-0 border-r md:block">
            <nav aria-label="工作台" className="sticky top-14 space-y-1 p-3">
              <NavLinks pathname={pathname} pending={pending} />
            </nav>
          </aside>
        ) : null}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
