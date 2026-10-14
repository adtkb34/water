import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvokeResult, UiSpec } from "@/lib/contract/types";
import { SmartForm, SmartResult, type SmartUiHost } from "@/smart-ui";

afterEach(() => {
  cleanup();
});

const spec: UiSpec = {
  capabilityId: "sample.write",
  module: "product",
  moduleLabel: "产品",
  title: "示例写入",
  description: "覆盖全部字段类型",
  kind: "write",
  impact: 6,
  fields: [
    {
      name: "name",
      label: "名称",
      type: "string",
      required: true,
      description: "产品名称",
    },
    {
      name: "quantity",
      label: "数量",
      type: "number",
      required: true,
      min: 1,
      integer: true,
    },
    {
      name: "deadline",
      label: "截止日期",
      type: "date",
      required: true,
    },
    {
      name: "note",
      label: "备注",
      type: "string",
      required: false,
    },
    {
      name: "category",
      label: "品类",
      type: "enum",
      required: true,
      options: [
        { value: "五金", label: "五金" },
        { value: "电子", label: "电子" },
      ],
    },
    {
      name: "productId",
      label: "产品",
      type: "ref",
      required: true,
      refKind: "product",
      options: [{ value: "P-001", label: "不锈钢螺栓" }],
    },
    {
      name: "supplierIds",
      label: "供应商",
      type: "multiref",
      required: true,
      refKind: "supplier",
      options: [
        { value: "S-001", label: "沪上紧固件" },
        { value: "S-002", label: "芯联电子" },
      ],
    },
  ],
  submit: { tool: "sample.write", label: "提交示例" },
};

function hostWith(invoke: SmartUiHost["invoke"]): SmartUiHost {
  return { invoke };
}

const executed: InvokeResult = {
  status: "executed",
  capabilityId: "sample.write",
  impact: 6,
  effectiveImpact: 6,
  summary: "已创建示例",
  records: [{ id: "P-008", name: "验收垫片", status: "draft" }],
};

describe("SmartForm", () => {
  it("renders every field type, required markers, and the impact hint", () => {
    render(<SmartForm spec={spec} host={hostWith(vi.fn())} />);
    expect(screen.getByLabelText(/^名称/)).toBeTruthy();
    expect(screen.getByLabelText(/^数量/)).toBeTruthy();
    expect(screen.getByLabelText(/^截止日期/)).toBeTruthy();
    expect(screen.getByLabelText(/^备注/)).toBeTruthy();
    expect(screen.getByLabelText(/^品类/)).toBeTruthy();
    expect(screen.getByLabelText(/^产品/)).toBeTruthy();
    expect(screen.getByRole("group", { name: /供应商/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "沪上紧固件" })).toBeTruthy();
    expect(screen.getAllByText("*").length).toBeGreaterThanOrEqual(5);
    expect(screen.getByText("权重 6 · 较高")).toBeTruthy();
    expect(screen.getByText(/影响权重为 6/)).toBeTruthy();
  });

  it("shows required and validation errors without calling the host", async () => {
    const user = userEvent.setup();
    const invoke = vi.fn();
    render(
      <SmartForm
        spec={spec}
        host={hostWith(invoke)}
        initialValues={{ deadline: "2026-13-40", quantity: "0" }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "提交示例" }));
    expect(screen.getByText("请填写名称")).toBeTruthy();
    expect(screen.getByText("数量必须是不小于1的整数")).toBeTruthy();
    expect(screen.getByText(/截止日期必须是 YYYY-MM-DD/)).toBeTruthy();
    expect(screen.getByText("请选择品类")).toBeTruthy();
    expect(screen.getByText("请至少选择一个供应商")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("calls host.invoke with numbers and multiref arrays", async () => {
    const user = userEvent.setup();
    const invoke = vi.fn(async () => executed);
    render(
      <SmartForm
        spec={spec}
        host={hostWith(invoke)}
        initialValues={{
          deadline: "2026-12-31",
          category: "五金",
          productId: "P-001",
          note: "  ",
        }}
      />,
    );
    await user.type(screen.getByLabelText(/^名称/), "  验收垫片  ");
    await user.type(screen.getByLabelText(/^数量/), "12");
    await user.click(screen.getByRole("checkbox", { name: "沪上紧固件" }));
    await user.click(screen.getByRole("checkbox", { name: "芯联电子" }));
    await user.click(screen.getByRole("button", { name: "提交示例" }));
    expect(invoke).toHaveBeenCalledWith("sample.write", {
      name: "验收垫片",
      quantity: 12,
      deadline: "2026-12-31",
      category: "五金",
      productId: "P-001",
      supplierIds: ["S-001", "S-002"],
    });
    expect(screen.getByText("已执行")).toBeTruthy();
    expect(screen.getByText("已创建示例")).toBeTruthy();
  });

  it("supports controlled values", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [values, setValues] = useState<Record<string, unknown>>({ name: "" });
      return (
        <>
          <SmartForm
            spec={{
              ...spec,
              fields: [spec.fields[0]],
              kind: "read",
              impact: 0,
            }}
            host={hostWith(vi.fn())}
            values={values}
            onChange={setValues}
          />
          <output>{String(values.name)}</output>
        </>
      );
    }
    render(<Harness />);
    await user.type(screen.getByLabelText(/^名称/), "螺栓");
    expect(screen.getByRole("status").textContent).toBe("螺栓");
    expect(screen.getByLabelText(/^名称/)).toHaveProperty("value", "螺栓");
  });
});

describe("SmartResult", () => {
  it("renders executed, pending approval, and rejected variants", () => {
    const { rerender } = render(<SmartResult result={executed} />);
    expect(screen.getByText("已执行")).toBeTruthy();
    expect(screen.getByText("有效权重 6 · 较高")).toBeTruthy();
    expect(screen.getByText("编号")).toBeTruthy();
    expect(screen.getByText("验收垫片")).toBeTruthy();
    expect(screen.getByText("草稿")).toBeTruthy();

    rerender(
      <SmartResult
        result={{
          status: "pending_approval",
          capabilityId: "inquiry.award",
          impact: 9,
          effectiveImpact: 9,
          summary: "等待人工确认中标",
          approvalId: "A-001",
          reasons: ["该能力被设为必须人工审核"],
        }}
      />,
    );
    expect(screen.getByText("待人工审核")).toBeTruthy();
    expect(screen.getByText("A-001")).toBeTruthy();
    expect(screen.getByText("该能力被设为必须人工审核")).toBeTruthy();
    expect(screen.getByText("有效权重 9 · 高")).toBeTruthy();

    rerender(
      <SmartResult
        result={{
          status: "rejected",
          capabilityId: "inquiry.create",
          impact: 3,
          effectiveImpact: 5,
          summary: "截止日期不是未来日期",
          issues: [
            { level: "block", field: "deadline", message: "请改为明天或更晚的日期" },
            { level: "warn", field: "quantity", message: "数量异常偏大" },
          ],
        }}
      />,
    );
    expect(screen.getByText("已拦截")).toBeTruthy();
    expect(screen.getByText("拦截：请改为明天或更晚的日期")).toBeTruthy();
    expect(screen.getByText("警告：数量异常偏大")).toBeTruthy();
  });
});
