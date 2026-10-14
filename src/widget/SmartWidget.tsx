import { useEffect, useState } from "react";
import type { InvokeResult } from "@/lib/contract/types";
import { SmartForm, SmartResult, type SmartUiHost } from "@/smart-ui";
import { bindWidgetHandlers, type WidgetApp } from "@/widget/bridge";
import {
  approvalsUrl,
  interpretToolResult,
  toInvokeResult,
  type WidgetHostContext,
  type WidgetView,
} from "@/widget/interpret";

function applyTheme(context: WidgetHostContext | undefined) {
  document.documentElement.classList.toggle("dark", context?.theme === "dark");
  document.documentElement.dataset.theme = context?.theme === "dark" ? "dark" : "light";
}

function ApprovalNote({
  workbenchUrl,
  openLink,
}: {
  workbenchUrl: string;
  openLink?: WidgetApp["openLink"];
}) {
  const href = approvalsUrl(workbenchUrl);
  return (
    <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
      <p>已提交人工审核，请到工作台批准</p>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex font-medium underline"
          onClick={(event) => {
            if (!openLink) return;
            event.preventDefault();
            void openLink({ url: href }).then((result) => {
              if (result.isError) window.open(href, "_blank", "noopener,noreferrer");
            }).catch(() => {
              window.open(href, "_blank", "noopener,noreferrer");
            });
          }}
        >
          打开审批页
        </a>
      ) : null}
    </div>
  );
}

export function SmartWidget({
  app,
  autoConnect = false,
}: {
  app: WidgetApp;
  autoConnect?: boolean;
}) {
  const [view, setView] = useState<WidgetView>({ kind: "waiting" });
  const [context, setContext] = useState<WidgetHostContext | undefined>(() =>
    app.getHostContext?.(),
  );
  const [locked, setLocked] = useState(false);
  const [submission, setSubmission] = useState<InvokeResult | null>(null);
  const [token, setToken] = useState(0);

  useEffect(() => {
    applyTheme(app.getHostContext?.());
    bindWidgetHandlers(app, {
      ontoolinput: () => {
        setView((current) => (current.kind === "waiting" ? { kind: "preparing" } : current));
      },
      ontoolresult: (payload) => {
        setLocked(false);
        setSubmission(null);
        setToken((current) => current + 1);
        setView(interpretToolResult(payload));
      },
      onhostcontextchanged: (next) => {
        setContext((current) => ({ ...current, ...next }));
      },
    });
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const initial = app.getHostContext?.();
      if (initial) setContext(initial);
    });
    if (!autoConnect || !app.connect) {
      return () => {
        cancelled = true;
      };
    }
    void app.connect().catch((error: unknown) => {
      if (cancelled) return;
      const text = error instanceof Error ? error.message : "";
      setView({ kind: "unknown", message: "无法连接宿主。", text });
    });
    return () => {
      cancelled = true;
    };
  }, [app, autoConnect]);

  useEffect(() => {
    applyTheme(context);
  }, [context]);

  const insets = context?.safeAreaInsets;
  const pad = {
    paddingTop: insets?.top ?? 0,
    paddingRight: insets?.right ?? 0,
    paddingBottom: insets?.bottom ?? 0,
    paddingLeft: insets?.left ?? 0,
  };

  let body = null;
  if (view.kind === "waiting") {
    body = <p className="text-sm text-muted-foreground">正在等待宿主发送数据…</p>;
  } else if (view.kind === "preparing") {
    body = <p className="text-sm text-muted-foreground">正在准备界面…</p>;
  } else if (view.kind === "unknown") {
    body = (
      <div className="space-y-2 text-sm">
        <p>{view.message}</p>
        {view.text ? (
          <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs leading-relaxed whitespace-pre-wrap">
            {view.text}
          </pre>
        ) : null}
      </div>
    );
  } else if (view.kind === "form") {
    const host: SmartUiHost = {
      async invoke(capabilityId, input) {
        const raw = await app.callServerTool({
          name: view.mcpToolName,
          arguments: input,
        });
        const result = toInvokeResult(raw, capabilityId);
        setSubmission(result);
        if (result.status !== "rejected") setLocked(true);
        return result;
      },
    };
    const pending =
      submission?.status === "pending_approval" ? submission : null;
    body = (
      <div className="space-y-3">
        <SmartForm
          key={token}
          spec={view.spec}
          host={host}
          initialValues={view.prefill}
          readOnly={locked}
        />
        {pending ? (
          <ApprovalNote workbenchUrl={view.workbenchUrl} openLink={app.openLink} />
        ) : null}
      </div>
    );
  } else if (view.kind === "invoke") {
    body = (
      <div className="space-y-3">
        <SmartResult result={view.result} />
        {view.result.status === "pending_approval" ? (
          <ApprovalNote workbenchUrl={view.workbenchUrl} openLink={app.openLink} />
        ) : null}
      </div>
    );
  } else {
    body = (
      <div className="space-y-3">
        <p className="text-sm">{view.summary}</p>
        {view.status === "pending" ? (
          <ApprovalNote workbenchUrl={view.workbenchUrl} openLink={app.openLink} />
        ) : null}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl" style={pad}>
      {body}
    </div>
  );
}
