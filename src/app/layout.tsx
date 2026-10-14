import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import { Geist } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/shell/app-shell";
import { cn } from "@/lib/utils";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "能力契约",
  description: "对话优先的 Agent 原生软件原型。工作台表单由智能 UI 渲染器根据能力契约生成。",
};

function ShellFallback() {
  return (
    <div className="min-h-screen">
      <div className="h-14 border-b" />
    </div>
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" className={cn("font-sans", geist.variable)}>
      <body className="min-h-full antialiased">
        <TooltipProvider>
          <Suspense fallback={<ShellFallback />}>
            <AppShell>{children}</AppShell>
          </Suspense>
          <Toaster theme="light" position="top-center" />
        </TooltipProvider>
      </body>
    </html>
  );
}
