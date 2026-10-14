import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { buildUiSpec } from "@/lib/contract/derive";
import { capabilities, getCapability } from "@/lib/contract/registry";
import type { CapabilityDef, Policy, UiSpec } from "@/lib/contract/types";
import { getStore } from "@/lib/server/db";
import { findApproval, getPolicy } from "@/lib/server/governance";
import { invoke } from "@/lib/server/invoke";
import { describeForm } from "@/lib/mcp/form-text";
import {
  toolNameForCapability,
  UI_SPEC_INDEX_URI,
  uiSpecUri,
  WIDGET_RESOURCE_URI,
} from "@/lib/mcp/names";
import { originFromRequestInfo, type OriginRequestInfo } from "@/lib/mcp/origin";
import {
  approvalToolResult,
  errorToolResult,
  invokeToolResult,
  type ToolCallContent,
  uiSpecToolResult,
} from "@/lib/mcp/results";
import { capabilityInputSchema, capabilityToolDescription } from "@/lib/mcp/schema";
import { EMPTY_UI_CSP, widgetToolMeta } from "@/lib/mcp/ui-meta";
import { readWidgetHtml, WIDGET_HTML_PATH } from "@/lib/mcp/widget-file";

export const MCP_SERVER_NAME = "agent-native-prototype";
export const MCP_SERVER_VERSION = "0.1.0";
export const MCP_INSTRUCTIONS =
  "请先调用 list_capabilities 了解可用能力。需要向用户收集字段时，优先调用 show_form，把可交互界面交给用户；没有界面的客户端可以阅读 show_form 返回的字段说明，或调用 get_ui_spec。写操作可能返回 pending_approval，这表示必须由人工审核后才会执行，请告知用户等待，并用 get_approval_status 查询进度。批准与驳回只能由人工在工作台完成。";

const MCP_ACTOR = { kind: "agent", surface: "mcp" } as const;

const RESERVED_TOOL_NAMES = new Set([
  "list_capabilities",
  "get_ui_spec",
  "get_approval_status",
  "show_form",
]);

const capabilityIdInput = z.object({
  capabilityId: z.string().describe("能力编号，例如 inquiry.create"),
});

const approvalIdInput = z.object({
  approvalId: z.string().describe("审批号，例如 A-001"),
});

const showFormInput = z.object({
  capabilityId: z.string().describe("能力编号，例如 inquiry.create"),
  prefill: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("可选。要预填的字段，键是字段名"),
});

export interface McpServerOptions {
  widgetHtmlPath?: string;
}

function requiresApprovalForAgents(
  capability: CapabilityDef,
  policy: Policy,
): boolean {
  if (capability.kind !== "write") return false;
  return (
    capability.impact >= policy.threshold ||
    policy.alwaysReview.includes(capability.id)
  );
}

function capabilitySummaries() {
  const policy = getPolicy();
  return capabilities.map((capability) => ({
    id: capability.id,
    toolName: toolNameForCapability(capability.id),
    module: capability.module,
    moduleLabel: capability.moduleLabel,
    title: capability.title,
    description: capability.description,
    kind: capability.kind,
    impact: capability.impact,
    alwaysReview: policy.alwaysReview.includes(capability.id),
    requiresApprovalForAgents: requiresApprovalForAgents(capability, policy),
    hasUi: true,
    uiResourceUri: WIDGET_RESOURCE_URI,
  }));
}

function uiToolNames(): string[] {
  return [
    "show_form",
    "get_approval_status",
    ...capabilities.map((capability) => toolNameForCapability(capability.id)),
  ];
}

function withoutActor(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return args ?? {};
  }
  const record = { ...(args as Record<string, unknown>) };
  delete record.actor;
  return record;
}

function plainPrefill(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = { ...(value as Record<string, unknown>) };
  delete record.actor;
  return record;
}

function uiSpecDocument(capability: CapabilityDef) {
  return buildUiSpec(capability, getStore());
}

function indexDocument() {
  return {
    resources: capabilities.map((capability) => ({
      uri: uiSpecUri(capability.id),
      capabilityId: capability.id,
      title: capability.title,
      mimeType: "application/json",
    })),
  };
}

function requestOrigin(extra: { requestInfo?: OriginRequestInfo }): string {
  return originFromRequestInfo(extra.requestInfo);
}

function withWorkbench(payload: ToolCallContent, workbenchUrl: string): ToolCallContent {
  if (!workbenchUrl) return payload;
  return { ...payload, _meta: { workbenchUrl } };
}

function formToolResult(
  spec: UiSpec,
  mcpToolName: string,
  prefill: Record<string, unknown>,
  workbenchUrl: string,
): ToolCallContent {
  const structured: Record<string, unknown> = {
    kind: "form",
    uiSpec: spec,
    prefill,
    mcpToolName,
    workbenchUrl,
  };
  const summary = describeForm(spec, mcpToolName);
  return {
    content: [{ type: "text", text: `${summary}\n${JSON.stringify(structured)}` }],
    structuredContent: structured,
  };
}

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const widgetHtmlPath = options.widgetHtmlPath ?? WIDGET_HTML_PATH;
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: MCP_INSTRUCTIONS },
  );

  const used = new Set<string>();
  for (const capability of capabilities) {
    const name = toolNameForCapability(capability.id);
    if (RESERVED_TOOL_NAMES.has(name) || used.has(name)) {
      throw new Error(
        `Capability ${capability.id} cannot use tool name ${name}`,
      );
    }
    used.add(name);
    registerAppTool(
      server,
      name,
      {
        title: capability.title,
        description: capabilityToolDescription(capability),
        inputSchema: capabilityInputSchema(capability),
        annotations: {
          readOnlyHint: capability.kind === "read",
          destructiveHint:
            capability.kind === "write" && capability.impact >= 8,
        },
        _meta: widgetToolMeta(),
      },
      async (args, extra) => {
        const result = invoke({
          capabilityId: capability.id,
          input: withoutActor(args),
          actor: MCP_ACTOR,
        });
        return withWorkbench(invokeToolResult(result), requestOrigin(extra));
      },
    );
  }

  server.registerTool(
    "list_capabilities",
    {
      title: "能力列表",
      description:
        "列出全部能力、对应工具名、哪些工具带智能界面，以及按当前策略是否需要人工审核。",
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const items = capabilitySummaries();
      const names = uiToolNames();
      const structured: Record<string, unknown> = {
        capabilities: items,
        uiResourceUri: WIDGET_RESOURCE_URI,
        uiTools: names,
      };
      const summary = `共 ${items.length} 个能力。带智能界面的工具：${names.join("、")}。界面资源 ${WIDGET_RESOURCE_URI}`;
      return {
        content: [{ type: "text" as const, text: `${summary}\n${JSON.stringify(structured)}` }],
        structuredContent: structured,
      };
    },
  );

  server.registerTool(
    "get_ui_spec",
    {
      title: "界面配置",
      description:
        "返回某个能力的声明式界面配置，选项来自当前数据。需要向用户收集字段时优先使用 show_form；没有界面时再用本工具。参数 capabilityId 是能力编号，例如 inquiry.create。",
      inputSchema: capabilityIdInput,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ capabilityId }) => {
      const capability = getCapability(capabilityId);
      if (!capability) {
        const ids = capabilities.map((item) => item.id).join("、");
        return errorToolResult(
          `未知能力：${capabilityId}。可用能力：${ids}`,
          { capabilityId },
        );
      }
      return uiSpecToolResult(uiSpecDocument(capability));
    },
  );

  registerAppTool(
    server,
    "get_approval_status",
    {
      title: "审批状态",
      description:
        "查询一张审批的状态（pending、approved 或 rejected）和结果摘要。不能代替人工批准或驳回。",
      inputSchema: approvalIdInput,
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: widgetToolMeta(),
    },
    async ({ approvalId }, extra) => {
      const approval = findApproval(approvalId);
      if (!approval) {
        return errorToolResult(`找不到审批「${approvalId}」`, { approvalId });
      }
      return withWorkbench(approvalToolResult(approval), requestOrigin(extra));
    },
  );

  registerAppTool(
    server,
    "show_form",
    {
      title: "展示表单",
      description:
        "把某个能力的表单交给用户填写。capabilityId 是能力编号，例如 inquiry.create。prefill 可选，用来预填已经知道的字段。用户可以在界面里提交，也可以由你直接调用该能力对应的工具。这个工具本身不执行写入。",
      inputSchema: showFormInput,
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: widgetToolMeta(),
    },
    async ({ capabilityId, prefill }, extra) => {
      const capability = getCapability(capabilityId);
      if (!capability) {
        const ids = capabilities.map((item) => item.id).join("、");
        return errorToolResult(
          `未知能力：${capabilityId}。可用能力：${ids}`,
          { capabilityId },
        );
      }
      const spec = uiSpecDocument(capability);
      return formToolResult(
        spec,
        toolNameForCapability(capability.id),
        plainPrefill(prefill),
        requestOrigin(extra),
      );
    },
  );

  server.registerResource(
    "index",
    UI_SPEC_INDEX_URI,
    {
      title: "界面配置索引",
      description: "全部能力的声明式界面配置",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/json",
          text: JSON.stringify(indexDocument()),
        },
      ],
    }),
  );

  for (const capability of capabilities) {
    server.registerResource(
      capability.id,
      uiSpecUri(capability.id),
      {
        title: capability.title,
        description: capability.description,
        mimeType: "application/json",
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify(uiSpecDocument(capability)),
          },
        ],
      }),
    );
  }

  registerAppResource(
    server,
    "smart-ui",
    WIDGET_RESOURCE_URI,
    {
      description:
        "通用智能界面。根据工具结果渲染表单、表格和执行结果，不请求外部域名。",
      _meta: { ui: { csp: EMPTY_UI_CSP } },
    },
    async (uri) => {
      const html = readWidgetHtml(widgetHtmlPath);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: { ui: { csp: EMPTY_UI_CSP } },
          },
        ],
      };
    },
  );

  return server;
}
