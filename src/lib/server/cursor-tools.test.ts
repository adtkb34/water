import { describe, expect, it } from "vitest";
import { matchKnownToolName, normalizeCursorToolCall, parseCursorToolResult } from "@/lib/server/cursor-tools";

const KEY = "cursor_test_KEY_should_not_leak_zz91";

describe("normalizeCursorToolCall", () => {
  it("matches each documented name variant", () => {
    expect(matchKnownToolName("inquiry_publish")).toBe("inquiry_publish");
    expect(matchKnownToolName("mcp__agent-native__inquiry_publish")).toBe("inquiry_publish");
    expect(matchKnownToolName("agent-native-inquiry_publish")).toBe("inquiry_publish");
    expect(matchKnownToolName("mcp")).toBeNull();
    expect(matchKnownToolName("shell")).toBeNull();

    expect(normalizeCursorToolCall({ name: "inquiry_publish", args: { inquiryId: "Q-001" } })).toEqual({
      toolName: "inquiry_publish",
      input: { inquiryId: "Q-001" },
    });
    expect(normalizeCursorToolCall({ name: "mcp__agent-native__list_capabilities", args: {} })).toEqual({
      toolName: "list_capabilities",
      input: {},
    });
    expect(normalizeCursorToolCall({ name: "agent-native-show_form", args: { capabilityId: "inquiry.create" } })).toEqual({
      toolName: "show_form",
      input: { capabilityId: "inquiry.create" },
    });
    expect(
      normalizeCursorToolCall({
        name: "mcp",
        args: { toolName: "get_ui_spec", args: { capabilityId: "product.search" } },
      }),
    ).toEqual({ toolName: "get_ui_spec", input: { capabilityId: "product.search" } });
    expect(
      normalizeCursorToolCall({
        name: "mcp",
        args: { type: "mcp", args: { toolName: "get_approval_status", providerIdentifier: "agent-native", args: { approvalId: "A-001" } } },
      }),
    ).toEqual({ toolName: "get_approval_status", input: { approvalId: "A-001" } });
    expect(normalizeCursorToolCall({ name: "shell", args: { command: "ls" } })).toBeNull();
  });
});

describe("parseCursorToolResult", () => {
  it("reads structured content, MCP content, SDK value wrappers, and JSON text", () => {
    expect(parseCursorToolResult({ kind: "form", uiSpec: { capabilityId: "inquiry.create" } }).output).toMatchObject({
      kind: "form",
    });
    expect(
      parseCursorToolResult({
        content: [{ type: "text", text: "plain" }],
        structuredContent: { status: "executed", summary: "已发布", capabilityId: "inquiry.publish" },
      }).output,
    ).toMatchObject({ status: "executed", summary: "已发布" });
    expect(
      parseCursorToolResult({
        status: "success",
        value: { content: [{ text: { text: JSON.stringify({ status: "pending_approval", summary: "待审" }) } }], isError: false },
      }).output,
    ).toMatchObject({ status: "pending_approval" });
    expect(parseCursorToolResult('{"summary":"找到 2 条"}').output).toMatchObject({ summary: "找到 2 条" });
    expect(parseCursorToolResult({ value: { summary: "包装" } }).output).toMatchObject({ summary: "包装" });
    expect(parseCursorToolResult("不是 JSON").output).toEqual({ status: "unknown", summary: "不是 JSON" });
    expect(parseCursorToolResult({ status: "error", message: `stack ${KEY}` }).errorText).toBe("工具执行失败");
    expect(parseCursorToolResult({ content: [{ type: "text", text: "failed" }], isError: true }).errorText).toBe("工具执行失败");
  });
});
