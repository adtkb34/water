import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalCard } from "@/components/workbench/approval-card";
import type { Approval } from "@/lib/contract/types";

afterEach(() => {
  cleanup();
});

const rejected: Approval = {
  id: "A-009",
  capabilityId: "inquiry.award",
  input: { inquiryId: "Q-001" },
  actor: { kind: "agent", surface: "mcp" },
  effectiveImpact: 9,
  reasons: ["该能力被设为必须人工审核"],
  issues: [],
  status: "rejected",
  createdAt: "2026-10-10T00:00:00.000Z",
  decidedAt: "2026-10-10T01:00:00.000Z",
  resultSummary: "已驳回，未执行",
};

describe("ApprovalCard", () => {
  it("shows 已驳回 for a rejected approval", () => {
    render(
      <ApprovalCard
        approval={rejected}
        title="确认中标"
        facts={[]}
        onDecide={async () => ({ ok: true })}
      />,
    );
    expect(screen.getByText("已驳回")).toBeTruthy();
    expect(screen.queryByText("已拦截")).toBeNull();
    expect(screen.getByText("智能体 · MCP")).toBeTruthy();
    expect(screen.getByText("已驳回，未执行")).toBeTruthy();
  });
});
