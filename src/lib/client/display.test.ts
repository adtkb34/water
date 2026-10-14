import { describe, expect, it } from "vitest";
import { inputFacts, approvalStatusText, actorLabel, revertBlockReason } from "@/lib/client/display";
import type { UiSpec } from "@/lib/contract/types";

const directory = {
  products: [{ id: "P-001", name: "不锈钢螺栓" }],
  suppliers: [{ id: "S-001", name: "沪上紧固件" }],
  inquiries: [{ id: "Q-001", productId: "P-001", quantity: 2000 }],
};

function spec(): UiSpec {
  return {
    capabilityId: "inquiry.award",
    module: "procurement",
    moduleLabel: "采购",
    title: "确认中标",
    description: "",
    kind: "write",
    impact: 9,
    fields: [
      {
        name: "inquiryId",
        label: "询价单",
        type: "ref",
        required: true,
        refKind: "inquiry",
      },
      {
        name: "supplierId",
        label: "供应商",
        type: "ref",
        required: true,
        refKind: "supplier",
      },
      {
        name: "price",
        label: "中标价",
        type: "number",
        required: true,
      },
    ],
    submit: { tool: "inquiry.award", label: "提交" },
  };
}

describe("display helpers", () => {
  it("labels actors in Chinese", () => {
    expect(actorLabel({ kind: "agent", surface: "mcp" })).toBe("智能体 · MCP");
    expect(actorLabel({ kind: "human", surface: "workbench" })).toBe("人工 · 工作台");
  });

  it("uses 已驳回 for a rejected approval", () => {
    expect(approvalStatusText("approved")).toBe("已批准");
    expect(approvalStatusText("rejected")).toBe("已驳回");
    expect(approvalStatusText("rejected")).not.toBe("已拦截");
  });

  it("explains why a revert control is disabled", () => {
    expect(
      revertBlockReason(
        { outcome: "executed", undoable: false, reverted: false },
        "确认中标",
      ),
    ).toBe("确认中标不可撤销");
    expect(
      revertBlockReason(
        { outcome: "executed", undoable: true, reverted: true },
        "新建产品",
      ),
    ).toBe("该记录已经撤销，不能重复撤销");
    expect(
      revertBlockReason({ outcome: "rejected", undoable: false }, "发布询价"),
    ).toBe("只有已执行的操作可以撤销");
    expect(
      revertBlockReason({ outcome: "executed", undoable: true }, "新建产品"),
    ).toBeNull();
  });

  it("resolves ref ids to names from store data", () => {
    expect(
      inputFacts(
        spec(),
        { inquiryId: "Q-001", supplierId: "S-001", price: 0.9 },
        directory,
      ),
    ).toEqual([
      { key: "inquiryId", label: "询价单", value: "Q-001 · 不锈钢螺栓 × 2000" },
      { key: "supplierId", label: "供应商", value: "沪上紧固件" },
      { key: "price", label: "中标价", value: "0.9" },
    ]);
  });
});
