import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { UiSpec } from "@/lib/contract/types";
import type { WidgetApp } from "@/widget/bridge";
import type { ToolPayload } from "@/widget/interpret";
import { SmartWidget } from "@/widget/SmartWidget";

afterEach(() => {
  cleanup();
});

const spec: UiSpec = {
  capabilityId: "inquiry.create",
  module: "inquiry",
  moduleLabel: "询价",
  title: "创建询价",
  description: "为产品创建一张草稿询价单。",
  kind: "write",
  impact: 3,
  fields: [
    { name: "name", label: "名称", type: "string", required: true },
    {
      name: "quantity",
      label: "数量",
      type: "number",
      required: true,
      min: 1,
      integer: true,
    },
    { name: "deadline", label: "截止日期", type: "date", required: true },
  ],
  submit: { tool: "inquiry.create", label: "提交" },
};

function formPayload(prefill: Record<string, unknown>): ToolPayload {
  return {
    content: [{ type: "text", text: "创建询价" }],
    structuredContent: {
      kind: "form",
      uiSpec: spec,
      prefill,
      mcpToolName: "inquiry_create",
      workbenchUrl: "http://127.0.0.1:4817",
    },
  };
}

function createFakeApp(next: ToolPayload) {
  let ontoolinput: WidgetApp["ontoolinput"];
  let ontoolresult: WidgetApp["ontoolresult"];
  let onhostcontextchanged: WidgetApp["onhostcontextchanged"];
  const calls: { name: string; arguments?: Record<string, unknown> }[] = [];
  const links: string[] = [];
  const app: WidgetApp = {
    get ontoolinput() {
      return ontoolinput;
    },
    set ontoolinput(handler) {
      ontoolinput = handler;
    },
    get ontoolresult() {
      return ontoolresult;
    },
    set ontoolresult(handler) {
      ontoolresult = handler;
    },
    get onhostcontextchanged() {
      return onhostcontextchanged;
    },
    set onhostcontextchanged(handler) {
      onhostcontextchanged = handler;
    },
    getHostContext: () => ({ theme: "light" }),
    callServerTool: async (params) => {
      calls.push(params);
      return next;
    },
    openLink: async ({ url }) => {
      links.push(url);
      return {};
    },
  };
  return {
    app,
    calls,
    links,
    emitResult(payload: ToolPayload) {
      ontoolresult?.(payload);
    },
    setNext(payload: ToolPayload) {
      next = payload;
    },
  };
}

describe("widget view", () => {
  it("renders a prefilled form and submits typed arguments to the capability tool", async () => {
    const user = userEvent.setup();
    const fake = createFakeApp({
      content: [{ type: "text", text: "已创建询价草稿 Q-009" }],
      structuredContent: {
        status: "executed",
        capabilityId: "inquiry.create",
        summary: "已创建询价草稿 Q-009",
        impact: 3,
        effectiveImpact: 3,
        issues: [],
        errors: [],
        data: { id: "Q-009" },
      },
    });
    render(<SmartWidget app={fake.app} />);
    expect(screen.getByText("正在等待宿主发送数据…")).toBeTruthy();
    act(() => {
      fake.emitResult(formPayload({ name: "垫片", deadline: "2026-12-31" }));
    });
    expect(screen.getByText("创建询价")).toBeTruthy();
    expect((screen.getByLabelText(/^名称/) as HTMLInputElement).value).toBe("垫片");
    await user.type(screen.getByLabelText(/^数量/), "12");
    await user.click(screen.getByRole("button", { name: "提交" }));
    expect(fake.calls).toEqual([
      {
        name: "inquiry_create",
        arguments: { name: "垫片", quantity: 12, deadline: "2026-12-31" },
      },
    ]);
    expect(screen.getByText("已创建询价草稿 Q-009")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "提交" })).toBeNull();
    expect((screen.getByLabelText(/^名称/) as HTMLInputElement).disabled).toBe(true);
  });

  it("keeps the form editable and shows Chinese issues when the tool rejects", async () => {
    const user = userEvent.setup();
    const fake = createFakeApp({
      isError: true,
      content: [{ type: "text", text: "截止日期 2020-01-01 不是未来日期" }],
      structuredContent: {
        status: "rejected",
        capabilityId: "inquiry.create",
        summary: "截止日期 2020-01-01 不是未来日期",
        impact: 3,
        effectiveImpact: 3,
        issues: [
          {
            level: "block",
            field: "deadline",
            message: "截止日期 2020-01-01 不是未来日期。请改为更晚的日期",
          },
        ],
        errors: [
          {
            field: "deadline",
            message: "截止日期 2020-01-01 不是未来日期。请改为更晚的日期",
          },
        ],
      },
    });
    render(<SmartWidget app={fake.app} />);
    act(() => {
      fake.emitResult(formPayload({ name: "垫片", quantity: 4, deadline: "2020-01-01" }));
    });
    await user.click(screen.getByRole("button", { name: "提交" }));
    expect(screen.getAllByText(/不是未来日期/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "提交" })).toBeTruthy();
    expect((screen.getByLabelText(/^截止日期/) as HTMLInputElement).disabled).toBe(false);
  });

  it("renders the approval note for a pending result", async () => {
    const user = userEvent.setup();
    const fake = createFakeApp({ content: [{ type: "text", text: "" }] });
    render(<SmartWidget app={fake.app} />);
    act(() => {
      fake.emitResult({
        content: [{ type: "text", text: "已提交人工审核" }],
        structuredContent: {
          status: "pending_approval",
          capabilityId: "inquiry.publish",
          summary: "发布询价已提交人工审核",
          impact: 6,
          effectiveImpact: 6,
          approvalId: "A-003",
          issues: [],
          errors: [],
        },
        _meta: { workbenchUrl: "http://127.0.0.1:4817" },
      });
    });
    expect(screen.getByText("已提交人工审核，请到工作台批准")).toBeTruthy();
    const link = screen.getByRole("link", { name: "打开审批页" });
    expect(link.getAttribute("href")).toBe("http://127.0.0.1:4817/workbench/approvals");
    await user.click(link);
    expect(fake.links).toEqual(["http://127.0.0.1:4817/workbench/approvals"]);
  });
});
