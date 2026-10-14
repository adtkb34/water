"use client";

import { useEffect, useRef, useState } from "react";
import { AppBridge, getToolUiResourceUri, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { connectWithRetry } from "@/app/host-sim/connect-session";
import { Button } from "@/components/ui/button";
import { SANDBOX_PROXY_HTML } from "@/app/host-sim/proxy";

interface ToolInfo {
  name: string;
  title?: string;
  description?: string;
  _meta?: Record<string, unknown>;
}

interface ToolPayload {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

interface LogEntry {
  id: number;
  direction: "宿主 → 界面" | "界面 → 宿主";
  summary: string;
  body: string;
}

const PRESETS: { label: string; tool: string; arguments: Record<string, unknown> }[] = [
  { label: "表单：创建询价", tool: "show_form", arguments: { capabilityId: "inquiry.create" } },
  { label: "搜索产品", tool: "product_search", arguments: { keyword: "螺栓" } },
  { label: "查询价单", tool: "inquiry_list", arguments: {} },
  { label: "表单：确认中标", tool: "show_form", arguments: { capabilityId: "inquiry.award" } },
  { label: "表单：发布询价", tool: "show_form", arguments: { capabilityId: "inquiry.publish" } },
];

function textOf(result: ToolPayload | null): string {
  return (result?.content ?? []).map((item) => item.text ?? "").join("\n");
}

function asCallToolResult(value: unknown): CallToolResult {
  if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content)) {
    throw new Error("工具结果缺少 content");
  }
  return value as CallToolResult;
}

function summarize(message: unknown): string {
  if (!message || typeof message !== "object") return "消息";
  const record = message as { method?: string; id?: unknown; error?: unknown; result?: unknown };
  if (typeof record.method === "string") return record.method;
  if ("error" in record) return `响应错误 ${String(record.id ?? "")}`;
  if ("result" in record) return `响应 ${String(record.id ?? "")}`;
  return "消息";
}

class LoggingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];
  sessionId?: string;

  constructor(
    private inner: Transport,
    private log: (direction: "in" | "out", message: unknown) => void,
  ) {}

  async start() {
    this.inner.onmessage = (message, extra) => {
      this.log("in", message);
      this.onmessage?.(message, extra);
    };
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onclose = () => this.onclose?.();
    await this.inner.start();
  }

  async send(message: Parameters<Transport["send"]>[0], options?: Parameters<Transport["send"]>[1]) {
    this.log("out", message);
    await this.inner.send(message, options);
  }

  async close() {
    await this.inner.close();
  }

  setProtocolVersion(version: string) {
    this.inner.setProtocolVersion?.(version);
  }
}

export function HostSim() {
  const [status, setStatus] = useState("正在连接 MCP…");
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [toolName, setToolName] = useState("show_form");
  const [argsText, setArgsText] = useState(
    JSON.stringify({ capabilityId: "inquiry.create" }, null, 2),
  );
  const [textOnly, setTextOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<ToolPayload | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [frameHeight, setFrameHeight] = useState(640);
  const clientRef = useRef<Client | null>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const proxyReady = useRef(false);
  const runRef = useRef(0);
  const logId = useRef(0);

  function pushLog(direction: "in" | "out", message: unknown) {
    const entry: LogEntry = {
      id: ++logId.current,
      direction: direction === "out" ? "宿主 → 界面" : "界面 → 宿主",
      summary: summarize(message),
      body: JSON.stringify(message, null, 2),
    };
    setLogs((current) => [...current.slice(-79), entry]);
  }

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data as { method?: string } | null;
      if (data?.method === "ui/notifications/sandbox-proxy-ready") {
        proxyReady.current = true;
      }
    }
    window.addEventListener("message", onMessage);
    const ping = window.setInterval(() => {
      if (proxyReady.current) return;
      iframeRef.current?.contentWindow?.postMessage(
        { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ping", params: {} },
        "*",
      );
    }, 200);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(ping);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let current: Client | null = null;
    void connectWithRetry({
      isCancelled: () => cancelled,
      open: () => {
        const client = new Client({ name: "宿主模拟", version: "0.1.0" });
        const transport = new StreamableHTTPClientTransport(
          new URL("/api/mcp", window.location.origin),
        );
        current = client;
        return {
          run: async () => {
            await client.connect(transport);
            const listed = await client.listTools();
            return listed.tools as ToolInfo[];
          },
          close: async () => {
            await client.close().catch(() => undefined);
            if (current === client) current = null;
          },
        };
      },
    })
      .then((tools) => {
        if (cancelled) {
          void current?.close().catch(() => undefined);
          return;
        }
        clientRef.current = current;
        setTools(tools);
        setStatus("已连接");
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setStatus("连接失败");
        setError(caught instanceof Error ? caught.message : "无法连接 MCP");
      });
    return () => {
      cancelled = true;
      void bridgeRef.current?.close().catch(() => undefined);
      void current?.close().catch(() => undefined);
      void clientRef.current?.close().catch(() => undefined);
      clientRef.current = null;
    };
  }, []);

  async function showWidget(html: string, args: Record<string, unknown>, payload: ToolPayload) {
    const frame = iframeRef.current;
    const client = clientRef.current;
    const ready = await new Promise<Window | null>((resolve) => {
      const started = Date.now();
      const tick = () => {
        const win = iframeRef.current?.contentWindow ?? null;
        if (win && proxyReady.current) {
          resolve(win);
          return;
        }
        if (Date.now() - started > 3000) {
          resolve(null);
          return;
        }
        window.setTimeout(tick, 50);
      };
      tick();
    });
    if (!frame || !ready || !client) {
      throw new Error("沙箱还没准备好");
    }
    const win = ready;
    await bridgeRef.current?.close().catch(() => undefined);
    const bridge = new AppBridge(
      null,
      { name: "宿主模拟", version: "0.1.0" },
      { openLinks: {}, serverTools: {}, logging: {} },
    );
    bridge.oncalltool = async (params) => asCallToolResult(await client.callTool(params));
    bridge.onopenlink = async ({ url }) => {
      window.open(url, "_blank", "noopener,noreferrer");
      return {};
    };
    bridge.onsizechange = ({ height }) => {
      if (typeof height === "number" && height > 80) {
        setFrameHeight(Math.min(Math.ceil(height), 2400));
      }
    };
    bridge.oninitialized = () => {
      void bridge.sendToolInput({ arguments: args });
      void bridge.sendToolResult(asCallToolResult(payload));
    };
    bridgeRef.current = bridge;
    const transport = new LoggingTransport(
      new PostMessageTransport(win, win),
      pushLog,
    );
    const handshake = bridge.connect(transport);
    try {
      bridge.setHostContext({
        theme: "light",
        locale: "zh-CN",
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      });
    } catch {
      void handshake.then(() => {
        bridge.setHostContext({
          theme: "light",
          locale: "zh-CN",
          safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        });
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    win.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/sandbox-resource-ready",
        params: { html, sandbox: "allow-scripts allow-forms" },
      },
      "*",
    );
    await Promise.race([
      handshake,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("界面没有连上宿主")), 8000);
      }),
    ]);
  }

  async function runTool() {
    const client = clientRef.current;
    if (!client) return;
    const id = ++runRef.current;
    setBusy(true);
    setError("");
    setNotice("");
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(argsText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("参数需要是 JSON 对象");
      }
      args = parsed as Record<string, unknown>;
    } catch (caught) {
      setBusy(false);
      setError(caught instanceof Error ? caught.message : "参数不是合法的 JSON");
      return;
    }
    try {
      const payload = (await client.callTool({
        name: toolName,
        arguments: args,
      })) as ToolPayload;
      if (id !== runRef.current) return;
      setResult(payload);
      if (textOnly) {
        await bridgeRef.current?.close().catch(() => undefined);
        bridgeRef.current = null;
        return;
      }
      const tool = tools.find((item) => item.name === toolName);
      let uri: string | undefined;
      try {
        uri = tool ? getToolUiResourceUri(tool) : undefined;
      } catch (caught) {
        throw new Error(caught instanceof Error ? caught.message : "界面地址无效");
      }
      if (!uri) {
        setNotice("这个工具没有绑定界面，下面只显示文字结果。");
        return;
      }
      const read = await client.readResource({ uri });
      const content = read.contents[0];
      const html = content && "text" in content ? content.text : "";
      if (!html) throw new Error("界面资源是空的");
      if (id !== runRef.current) return;
      await showWidget(html, args, payload);
    } catch (caught) {
      if (id !== runRef.current) return;
      setError(caught instanceof Error ? caught.message : "调用失败");
    } finally {
      if (id === runRef.current) setBusy(false);
    }
  }

  const showText = textOnly || Boolean(notice);

  return (
    <main className="space-y-4 px-4 py-6" data-testid="host-sim">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">宿主模拟</h1>
        <p className="text-sm text-muted-foreground">
          浏览器扮演支持 MCP Apps 的宿主：连接 /api/mcp，把智能界面放进沙箱 iframe。
          当前状态：{status}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((preset) => (
          <Button
            key={preset.label}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setToolName(preset.tool);
              setArgsText(JSON.stringify(preset.arguments, null, 2));
            }}
          >
            {preset.label}
          </Button>
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-[16rem_1fr]">
        <label className="space-y-1 text-sm">
          <span>工具</span>
          <select
            className="h-9 w-full rounded-lg border bg-background px-2"
            value={toolName}
            onChange={(event) => setToolName(event.target.value)}
          >
            {tools.length === 0 ? <option value={toolName}>{toolName}</option> : null}
            {tools.map((tool) => (
              <option key={tool.name} value={tool.name}>
                {tool.title ? `${tool.title}（${tool.name}）` : tool.name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span>参数（JSON）</span>
          <textarea
            className="min-h-28 w-full rounded-lg border bg-background p-2 font-mono text-xs"
            value={argsText}
            onChange={(event) => setArgsText(event.target.value)}
            spellCheck={false}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={busy || status !== "已连接"} onClick={() => void runTool()}>
          {busy ? "调用中…" : "调用"}
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={textOnly}
            onChange={(event) => setTextOnly(event.target.checked)}
          />
          模拟不支持 UI 的宿主
        </label>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
      {showText && result ? (
        <section className="space-y-2" data-testid="host-sim-text">
          <h2 className="text-sm font-medium">文字结果</h2>
          <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs leading-relaxed whitespace-pre-wrap">
            {textOf(result)}
          </pre>
          <h2 className="text-sm font-medium">structuredContent</h2>
          <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs leading-relaxed whitespace-pre-wrap">
            {JSON.stringify(result.structuredContent ?? null, null, 2)}
          </pre>
        </section>
      ) : null}
      <iframe
        ref={iframeRef}
        title="智能界面沙箱"
        sandbox="allow-scripts allow-forms"
        srcDoc={SANDBOX_PROXY_HTML}
        onLoad={() => {
          proxyReady.current = true;
        }}
        className={textOnly ? "hidden" : "w-full rounded-lg border bg-white"}
        style={{ height: frameHeight }}
        data-testid="host-sim-frame"
      />
      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer text-sm font-medium">桥接日志（{logs.length}）</summary>
        <div className="mt-3 max-h-80 space-y-3 overflow-auto">
          {logs.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有桥接消息。</p>
          ) : (
            logs.map((entry) => (
              <pre key={entry.id} className="overflow-x-auto rounded-md bg-muted p-2 text-xs leading-relaxed whitespace-pre-wrap">
                {`${entry.direction} ${entry.summary}\n${entry.body}`}
              </pre>
            ))
          )}
        </div>
      </details>
    </main>
  );
}
