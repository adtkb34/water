import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { ChatPartRenderer } from "@/components/chat/chat-part-renderer";
import type { Approval, InvokeResult, UiSpec } from "@/lib/contract/types";

afterEach(() => {
  cleanup();
});

const formSpec: UiSpec = {
  capabilityId: "alpha.create",
  module: "product",
  moduleLabel: "示例",
  title: "示例写入",
  description: "写一条示例",
  kind: "write",
  impact: 2,
  fields: [
    {
      name: "name",
      label: "名称",
      type: "string",
      required: true,
    },
  ],
  submit: { tool: "alpha.create", label: "提交" },
};

const readSpec: UiSpec = {
  capabilityId: "alpha.search",
  module: "product",
  moduleLabel: "示例",
  title: "示例查询",
  description: "查示例",
  kind: "read",
  impact: 0,
  fields: [],
  submit: { tool: "alpha.search", label: "查询" },
};

const executed: InvokeResult = {
  status: "executed",
  capabilityId: "alpha.search",
  impact: 0,
  effectiveImpact: 0,
  summary: "找到 1 条",
  records: [{ id: "A-1", name: "螺栓" }],
};

const pending: InvokeResult = {
  status: "pending_approval",
  capabilityId: "alpha.create",
  impact: 6,
  effectiveImpact: 6,
  summary: "该操作需要人工审核",
  approvalId: "A-100",
  reasons: ["影响权重达到阈值"],
  actor: { kind: "agent", surface: "chat" },
};

const approval: Approval = {
  id: "A-100",
  capabilityId: "alpha.create",
  input: { name: "垫片" },
  actor: { kind: "agent", surface: "chat" },
  effectiveImpact: 6,
  reasons: ["影响权重达到阈值"],
  issues: [],
  status: "pending",
  createdAt: "2026-10-10T00:00:00.000Z",
};

describe("ChatPartRenderer", () => {
  it("renders a form card from a show_form tool part", () => {
    const part: ToolUIPart = {
      type: "tool-show_form",
      toolCallId: "call-form",
      state: "input-available",
      input: { capabilityId: "alpha.create" },
    };
    render(<ChatPartRenderer part={part} specs={[formSpec, readSpec]} />);
    expect(screen.getByText("示例写入")).toBeTruthy();
    expect(screen.getByLabelText(/名称/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "提交" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "我来提交" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "交给智能体提交" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "在工作台中打开" }).getAttribute("href")).toBe(
      "/workbench/products",
    );
  });

  it("renders a table from a capability tool result", () => {
    const part: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "alpha_search",
      toolCallId: "call-read",
      state: "output-available",
      input: {},
      output: executed,
    };
    render(<ChatPartRenderer part={part} specs={[formSpec, readSpec]} />);
    expect(screen.getByText("找到 1 条")).toBeTruthy();
    expect(screen.getByText("螺栓")).toBeTruthy();
    expect(screen.getByTestId("chat-result")).toBeTruthy();
  });

  it("locks a submitted show_form card", () => {
    const part: ToolUIPart = {
      type: "tool-show_form",
      toolCallId: "call-form-done",
      state: "output-available",
      input: { capabilityId: "alpha.create" },
      output: {
        status: "executed",
        capabilityId: "alpha.create",
        summary: "已创建示例",
        impact: 2,
        effectiveImpact: 2,
        submitted: { name: "垫片" },
      },
    };
    render(<ChatPartRenderer part={part} specs={[formSpec, readSpec]} />);
    expect(screen.getByText("已创建示例")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "提交" })).toBeNull();
    expect((screen.getByLabelText(/名称/) as HTMLInputElement).value).toBe("垫片");
  });

  it("renders dynamic-tool show_form while the form is open and after it is submitted", () => {
    const open: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "show_form",
      toolCallId: "call-dyn",
      state: "input-available",
      input: { capabilityId: "alpha.create", prefill: { name: "预填名" } },
    };
    const { rerender } = render(<ChatPartRenderer part={open} specs={[formSpec, readSpec]} />);
    expect(screen.getByRole("button", { name: "提交" })).toBeTruthy();
    expect((screen.getByLabelText(/名称/) as HTMLInputElement).value).toBe("预填名");

    const done: DynamicToolUIPart = {
      ...open,
      state: "output-available",
      output: {
        status: "executed",
        capabilityId: "alpha.create",
        summary: "动态表单已提交",
        impact: 2,
        effectiveImpact: 2,
        submitted: { name: "预填名" },
      },
    };
    rerender(<ChatPartRenderer part={done} specs={[formSpec, readSpec]} />);
    expect(screen.getByText("动态表单已提交")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "提交" })).toBeNull();
  });

  it("renders an approval card for a pending capability result", () => {
    const part: ToolUIPart = {
      type: "tool-alpha_create",
      toolCallId: "call-pending",
      state: "output-available",
      input: { name: "垫片" },
      output: pending,
    };
    render(
      <ChatPartRenderer
        part={part}
        specs={[formSpec, readSpec]}
        approvals={[approval]}
      />,
    );
    expect(screen.getByTestId("chat-approval")).toBeTruthy();
    expect(screen.getByRole("button", { name: "批准" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "驳回" })).toBeTruthy();
    expect(screen.getByText("影响权重达到阈值")).toBeTruthy();
  });

  it("keeps the model-path form on onResult", async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();
    const onFormFollowUp = vi.fn();
    const onInvoke = vi.fn(async () => ({
      status: "executed" as const,
      capabilityId: "alpha.create",
      impact: 2,
      effectiveImpact: 2,
      summary: "已创建示例",
    }));
    const part: ToolUIPart = {
      type: "tool-show_form",
      toolCallId: "call-model",
      state: "input-available",
      input: { capabilityId: "alpha.create", prefill: { name: "垫片" } },
    };
    render(
      <ChatPartRenderer
        part={part}
        specs={[formSpec, readSpec]}
        onInvoke={onInvoke}
        onResult={onResult}
        onFormFollowUp={onFormFollowUp}
      />,
    );
    await user.click(screen.getByRole("button", { name: "提交" }));
    expect(onInvoke).toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith("call-model", expect.objectContaining({ summary: "已创建示例" }));
    expect(onFormFollowUp).not.toHaveBeenCalled();
  });

  it("renders an MCP show_form result and sends a follow-up after submit", async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();
    const onFormFollowUp = vi.fn();
    const onInvoke = vi.fn(async () => ({
      status: "executed" as const,
      capabilityId: "alpha.create",
      impact: 2,
      effectiveImpact: 2,
      summary: "已创建示例",
    }));
    const part: ToolUIPart = {
      type: "tool-show_form",
      toolCallId: "call-mcp-form",
      state: "output-available",
      input: {},
      output: {
        structuredContent: {
          kind: "form",
          uiSpec: formSpec,
          prefill: { name: "螺栓" },
        },
      },
    };
    render(
      <ChatPartRenderer
        part={part}
        specs={[]}
        onInvoke={onInvoke}
        onResult={onResult}
        onFormFollowUp={onFormFollowUp}
      />,
    );
    expect(screen.getByText("示例写入")).toBeTruthy();
    expect((screen.getByLabelText(/名称/) as HTMLInputElement).value).toBe("螺栓");
    await user.click(screen.getByRole("radio", { name: "交给智能体提交" }));
    await user.click(screen.getByRole("button", { name: "提交" }));
    expect(onInvoke).toHaveBeenCalledWith("alpha.create", { name: "螺栓" }, "agent");
    expect(onFormFollowUp).toHaveBeenCalledWith(
      "call-mcp-form",
      expect.objectContaining({ summary: "已创建示例", submitted: { name: "螺栓" } }),
      "已创建示例",
    );
    expect(onResult).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "提交" })).toBeNull();
  });
});
