import { beforeEach, describe, expect, it } from "vitest";
import { POST as decideApprovalRoute } from "@/app/api/approvals/[id]/route";
import { POST as reviewRoute } from "@/app/api/audit/[id]/review/route";
import { POST as revertRoute } from "@/app/api/audit/[id]/revert/route";
import { POST as invokeRoute } from "@/app/api/invoke/route";
import { PUT as putPolicy } from "@/app/api/policy/route";
import { DomainError } from "@/lib/contract/errors";
import { capabilities, getCapability } from "@/lib/contract/registry";
import { defineCapability } from "@/lib/contract/types";
import type {
  Actor,
  Inquiry,
  InvokeResult,
  Product,
  Store,
} from "@/lib/contract/types";
import { daysFromToday } from "@/lib/dates";
import { getStore, reset } from "@/lib/server/db";
import {
  findAudit,
  getPolicy,
  listAudit,
  pendingApprovalCount,
  revertAudit,
  reviewAudit,
  setPolicy,
} from "@/lib/server/governance";
import { decideApproval, invoke } from "@/lib/server/invoke";

const human: Actor = { kind: "human", surface: "workbench" };
const agent: Actor = { kind: "agent", surface: "llm" };
const later = daysFromToday(14);

function businessOf(store: Store) {
  return {
    products: store.products,
    suppliers: store.suppliers,
    inquiries: store.inquiries,
    counters: { ...store.counters },
  };
}

function expectBusinessUnchanged(before: ReturnType<typeof businessOf>) {
  expect(businessOf(getStore())).toEqual(before);
}

function productInput(name: string, referencePrice = 10) {
  return {
    name,
    category: "五金",
    unit: "件",
    referencePrice,
  };
}

function inquiryInput(
  productId: string,
  extra: { quantity?: number; supplierIds?: string[]; deadline?: string } = {},
) {
  return {
    productId,
    quantity: extra.quantity ?? 10,
    deadline: extra.deadline ?? later,
    supplierIds: extra.supplierIds ?? ["S-001"],
  };
}

function blocks(result: InvokeResult, pattern: RegExp) {
  expect(result.status).toBe("rejected");
  expect(result.stage).toBe("verifier");
  expect(
    result.issues?.some(
      (issue) => issue.level === "block" && pattern.test(issue.message),
    ),
  ).toBe(true);
  expect(
    result.errors?.some((error) => pattern.test(error.message)),
  ).toBe(true);
  const entry = findAudit(result.auditId ?? "");
  expect(entry).toMatchObject({ outcome: "rejected", stage: "verifier" });
}

beforeEach(() => {
  reset();
});

describe("stage 1 verifier", () => {
  it("blocks product.create when the name already exists and leaves the store unchanged", () => {
    const before = businessOf(getStore());
    const result = invoke({
      capabilityId: "product.create",
      input: productInput("不锈钢螺栓"),
      actor: agent,
    });
    blocks(result, /已存在同名产品「不锈钢螺栓」（P-001）。请更换名称/);
    expectBusinessUnchanged(before);
    expect(getStore().products).toHaveLength(6);
  });

  it("blocks inquiry.create when the deadline is today or in the past", () => {
    for (const deadline of [daysFromToday(0), daysFromToday(-3)]) {
      reset();
      const before = businessOf(getStore());
      const result = invoke({
        capabilityId: "inquiry.create",
        input: inquiryInput("P-004", { deadline, supplierIds: ["S-002"] }),
        actor: human,
      });
      blocks(result, /不是未来日期/);
      expect(result.summary).toMatch(/请改为/);
      expectBusinessUnchanged(before);
    }
  });

  it("blocks inquiry.create when quantity is above 100000 and warns above 5000", () => {
    const blocked = invoke({
      capabilityId: "inquiry.create",
      input: inquiryInput("P-004", { quantity: 100001, supplierIds: ["S-002"] }),
      actor: human,
    });
    blocks(blocked, /超过上限 100000/);
    expect(blocked.issues?.some((issue) => issue.message.includes("数量异常偏大"))).toBe(
      true,
    );
    expect(getStore().inquiries).toHaveLength(2);

    reset();
    const warned = invoke({
      capabilityId: "inquiry.create",
      input: inquiryInput("P-004", { quantity: 5001, supplierIds: ["S-002"] }),
      actor: human,
    });
    expect(warned.status).toBe("executed");
    expect(warned.issues?.map((issue) => issue.message).join("\n")).toMatch(
      /数量异常偏大/,
    );
    expect(warned.issues?.some((issue) => issue.level === "block")).toBe(false);

    reset();
    const borderline = invoke({
      capabilityId: "inquiry.create",
      input: inquiryInput("P-004", { quantity: 5000, supplierIds: ["S-002"] }),
      actor: human,
    });
    expect(borderline.status).toBe("executed");
    expect(borderline.issues).toEqual([]);

    reset();
    const atCap = invoke({
      capabilityId: "inquiry.create",
      input: inquiryInput("P-004", { quantity: 100000, supplierIds: ["S-002"] }),
      actor: human,
    });
    expect(atCap.status).toBe("executed");
    expect(atCap.issues?.some((issue) => issue.level === "block")).toBe(false);
    expect(atCap.issues?.some((issue) => issue.message.includes("数量异常偏大"))).toBe(
      true,
    );
  });

  it("warns once per supplier whose categories miss the product category", () => {
    const created = invoke({
      capabilityId: "product.create",
      input: productInput("品类隔离件"),
      actor: human,
    });
    const productId = (created.data as Product).id;
    const result = invoke({
      capabilityId: "inquiry.create",
      input: inquiryInput(productId, { supplierIds: ["S-002", "S-003"] }),
      actor: human,
    });
    expect(result.status).toBe("executed");
    const supplierWarns =
      result.issues?.filter((issue) => issue.field === "supplierIds") ?? [];
    expect(supplierWarns).toHaveLength(2);
    expect(supplierWarns[0]?.message).toMatch(/S-002 芯联电子/);
    expect(supplierWarns[0]?.message).toMatch(/五金/);
    expect(supplierWarns[1]?.message).toMatch(/S-003 包装通/);
    expect(result.issues?.some((issue) => issue.level === "block")).toBe(false);
  });

  it("warns when the product already has a draft or published inquiry, not an awarded one", () => {
    const draft = invoke({
      capabilityId: "inquiry.create",
      input: inquiryInput("P-001"),
      actor: human,
    });
    expect(draft.status).toBe("executed");
    expect(draft.issues?.map((issue) => issue.message).join("\n")).toMatch(
      /Q-001（草稿）/,
    );

    const published = invoke({
      capabilityId: "inquiry.create",
      input: inquiryInput("P-003", { supplierIds: ["S-002"] }),
      actor: human,
    });
    expect(published.issues?.map((issue) => issue.message).join("\n")).toMatch(
      /Q-002（已发布）/,
    );

    const created = invoke({
      capabilityId: "product.create",
      input: productInput("只中标一次"),
      actor: human,
    });
    const productId = (created.data as Product).id;
    const drafted = invoke({
      capabilityId: "inquiry.create",
      input: inquiryInput(productId),
      actor: human,
    });
    const inquiryId = (drafted.data as Inquiry).id;
    invoke({
      capabilityId: "inquiry.publish",
      input: { inquiryId },
      actor: human,
    });
    invoke({
      capabilityId: "inquiry.award",
      input: { inquiryId, supplierId: "S-001", price: 10 },
      actor: human,
    });
    const afterAward = invoke({
      capabilityId: "inquiry.create",
      input: inquiryInput(productId),
      actor: human,
    });
    expect(afterAward.issues ?? []).toEqual([]);
    expect(getStore().inquiries.find((item) => item.id === inquiryId)?.status).toBe(
      "awarded",
    );
  });

  it("blocks inquiry.publish when it is not a draft, has no suppliers, or the deadline is not in the future", () => {
    const published = invoke({
      capabilityId: "inquiry.publish",
      input: { inquiryId: "Q-002" },
      actor: human,
    });
    blocks(published, /只能发布草稿/);
    expect(getStore().inquiries.find((item) => item.id === "Q-002")?.status).toBe(
      "published",
    );

    reset();
    const draft = getStore().inquiries.find((item) => item.id === "Q-001");
    if (!draft) throw new Error("missing Q-001");
    draft.supplierIds = [];
    const beforeEmpty = businessOf(getStore());
    const empty = invoke({
      capabilityId: "inquiry.publish",
      input: { inquiryId: "Q-001" },
      actor: agent,
    });
    blocks(empty, /没有供应商/);
    expectBusinessUnchanged(beforeEmpty);

    reset();
    const stale = getStore().inquiries.find((item) => item.id === "Q-001");
    if (!stale) throw new Error("missing Q-001");
    stale.deadline = daysFromToday(-1);
    const beforeStale = businessOf(getStore());
    const past = invoke({
      capabilityId: "inquiry.publish",
      input: { inquiryId: "Q-001" },
      actor: agent,
    });
    blocks(past, /不是未来日期/);
    expectBusinessUnchanged(beforeStale);
  });

  it("blocks inquiry.award for status, uninvited suppliers, non-positive price, and price above 1.3x", () => {
    const draft = invoke({
      capabilityId: "inquiry.award",
      input: { inquiryId: "Q-001", supplierId: "S-001", price: 0.85 },
      actor: human,
    });
    blocks(draft, /只能对已发布的询价单确认中标/);
    expect(getStore().inquiries.find((item) => item.id === "Q-001")?.status).toBe(
      "draft",
    );

    const outsider = invoke({
      capabilityId: "inquiry.award",
      input: { inquiryId: "Q-002", supplierId: "S-001", price: 0.15 },
      actor: human,
    });
    blocks(outsider, /供应商名单/);
    expect(outsider.summary).toContain("S-002 芯联电子");
    expect(outsider.summary).toContain("S-005 联采商行");
    expect(getStore().inquiries.find((item) => item.id === "Q-002")?.award).toBeUndefined();

    const free = invoke({
      capabilityId: "inquiry.award",
      input: { inquiryId: "Q-002", supplierId: "S-002", price: 0 },
      actor: human,
    });
    blocks(free, /中标价必须大于 0/);

    const expensive = invoke({
      capabilityId: "inquiry.award",
      input: { inquiryId: "Q-002", supplierId: "S-002", price: 0.2 },
      actor: agent,
    });
    blocks(expensive, /30%/);
    expect(expensive.summary).toMatch(/请把 price 改为不高于/);
    expect(getStore().inquiries.find((item) => item.id === "Q-002")?.status).toBe(
      "published",
    );
  });

  it("warns when the award price is above 1.1x and at or below 1.3x of the reference price", () => {
    const created = invoke({
      capabilityId: "product.create",
      input: productInput("标价件", 100),
      actor: human,
    });
    const productId = (created.data as Product).id;
    const drafted = invoke({
      capabilityId: "inquiry.create",
      input: inquiryInput(productId),
      actor: human,
    });
    const inquiryId = (drafted.data as Inquiry).id;
    invoke({
      capabilityId: "inquiry.publish",
      input: { inquiryId },
      actor: human,
    });

    const exactWarnLine = invoke({
      capabilityId: "inquiry.award",
      input: { inquiryId, supplierId: "S-001", price: 110 },
      actor: human,
    });
    expect(exactWarnLine.status).toBe("executed");
    expect(exactWarnLine.issues).toEqual([]);
    expect(exactWarnLine.effectiveImpact).toBe(9);

    reset();
    const again = invoke({
      capabilityId: "product.create",
      input: productInput("标价件", 100),
      actor: human,
    });
    const productAgain = (again.data as Product).id;
    const draftAgain = invoke({
      capabilityId: "inquiry.create",
      input: inquiryInput(productAgain),
      actor: human,
    });
    const inquiryAgain = (draftAgain.data as Inquiry).id;
    invoke({
      capabilityId: "inquiry.publish",
      input: { inquiryId: inquiryAgain },
      actor: human,
    });

    const warned = invoke({
      capabilityId: "inquiry.award",
      input: { inquiryId: inquiryAgain, supplierId: "S-001", price: 110.01 },
      actor: human,
    });
    expect(warned.status).toBe("executed");
    expect(
      warned.issues?.some((issue) => issue.level === "warn" && /10%/.test(issue.message)),
    ).toBe(true);
    expect(warned.effectiveImpact).toBe(10);

    const third = invoke({
      capabilityId: "inquiry.create",
      input: inquiryInput(productAgain),
      actor: human,
    });
    const topId = (third.data as Inquiry).id;
    invoke({
      capabilityId: "inquiry.publish",
      input: { inquiryId: topId },
      actor: human,
    });
    const over = invoke({
      capabilityId: "inquiry.award",
      input: { inquiryId: topId, supplierId: "S-001", price: 130.01 },
      actor: human,
    });
    expect(over.status).toBe("rejected");
    expect(over.stage).toBe("verifier");
    expect(over.summary).toMatch(/30%/);
    expect(getStore().inquiries.find((item) => item.id === topId)?.status).toBe(
      "published",
    );

    const atLimit = invoke({
      capabilityId: "inquiry.award",
      input: { inquiryId: topId, supplierId: "S-001", price: 130 },
      actor: human,
    });
    expect(atLimit.status).toBe("executed");
    expect(atLimit.issues?.some((issue) => issue.level === "warn")).toBe(true);
    expect(atLimit.issues?.some((issue) => issue.level === "block")).toBe(false);
  });
});

describe("stage 1 weights", () => {
  it("adds 2 per warn and caps effective impact at 10", () => {
    const none = invoke({
      capabilityId: "inquiry.create",
      input: inquiryInput("P-005", { supplierIds: ["S-003"] }),
      actor: human,
    });
    expect(none.impact).toBe(3);
    expect(none.issues).toEqual([]);
    expect(none.effectiveImpact).toBe(3);

    const one = invoke({
      capabilityId: "inquiry.create",
      input: inquiryInput("P-006", { quantity: 6000, supplierIds: ["S-004"] }),
      actor: human,
    });
    expect(one.issues?.filter((issue) => issue.level === "warn")).toHaveLength(1);
    expect(one.effectiveImpact).toBe(5);

    const two = invoke({
      capabilityId: "inquiry.create",
      input: inquiryInput("P-001", { quantity: 6000 }),
      actor: human,
    });
    expect(two.issues?.filter((issue) => issue.level === "warn")).toHaveLength(2);
    expect(two.effectiveImpact).toBe(7);
    expect(findAudit(two.auditId ?? "")?.effectiveImpact).toBe(7);

    const capped = invoke({
      capabilityId: "inquiry.create",
      input: inquiryInput("P-001", {
        quantity: 6000,
        supplierIds: ["S-002", "S-003", "S-004"],
      }),
      actor: human,
    });
    expect(capped.issues?.filter((issue) => issue.level === "warn")).toHaveLength(5);
    expect(capped.effectiveImpact).toBe(10);
    expect(capped.status).toBe("executed");
  });
});

describe("stage 1 gate", () => {
  it("lets a human skip the gate and sends an agent to review at the threshold", () => {
    const byHuman = invoke({
      capabilityId: "inquiry.publish",
      input: { inquiryId: "Q-001" },
      actor: human,
    });
    expect(byHuman.status).toBe("executed");
    expect(byHuman.effectiveImpact).toBe(6);
    expect(findAudit(byHuman.auditId ?? "")).toMatchObject({
      outcome: "executed",
      actor: human,
    });
    expect(getStore().inquiries.find((item) => item.id === "Q-001")?.status).toBe(
      "published",
    );

    reset();
    const byAgent = invoke({
      capabilityId: "inquiry.publish",
      input: { inquiryId: "Q-001" },
      actor: agent,
    });
    expect(byAgent.status).toBe("pending_approval");
    expect(byAgent.stage).toBe("gate");
    expect(byAgent.approvalId).toBe("A-001");
    expect(byAgent.reasons).toEqual(["影响权重 6 达到阈值 6"]);
    expect(getStore().inquiries.find((item) => item.id === "Q-001")?.status).toBe(
      "draft",
    );
    expect(findAudit(byAgent.auditId ?? "")?.outcome).toBe("pending_approval");
    expect(pendingApprovalCount()).toBe(1);
  });

  it("flips agent inquiry.publish when the threshold moves from 6 to 7", () => {
    expect(
      invoke({
        capabilityId: "inquiry.publish",
        input: { inquiryId: "Q-001" },
        actor: agent,
      }).status,
    ).toBe("pending_approval");

    reset();
    expect(setPolicy({ threshold: 7, alwaysReview: ["inquiry.award"] }).ok).toBe(
      true,
    );
    const released = invoke({
      capabilityId: "inquiry.publish",
      input: { inquiryId: "Q-001" },
      actor: agent,
    });
    expect(released.status).toBe("executed");
    expect(released.effectiveImpact).toBe(6);
    expect(getStore().inquiries.find((item) => item.id === "Q-001")?.status).toBe(
      "published",
    );

    reset();
    setPolicy({ threshold: 10, alwaysReview: ["inquiry.award"] });
    expect(
      invoke({
        capabilityId: "inquiry.publish",
        input: { inquiryId: "Q-001" },
        actor: agent,
      }).status,
    ).toBe("executed");
  });

  it("forces review for a low-impact capability listed in alwaysReview", () => {
    setPolicy({ threshold: 10, alwaysReview: ["product.create"] });
    const pending = invoke({
      capabilityId: "product.create",
      input: productInput("必须审核的产品"),
      actor: agent,
    });
    expect(pending.status).toBe("pending_approval");
    expect(pending.effectiveImpact).toBe(2);
    expect(pending.reasons).toEqual(["该能力被设为必须人工审核"]);
    expect(getStore().products.some((item) => item.name === "必须审核的产品")).toBe(
      false,
    );

    const byHuman = invoke({
      capabilityId: "product.create",
      input: productInput("人工直接创建"),
      actor: human,
    });
    expect(byHuman.status).toBe("executed");
  });

  it("executes a clean award only after award leaves alwaysReview and the threshold is above its weight", () => {
    const held = invoke({
      capabilityId: "inquiry.award",
      input: { inquiryId: "Q-002", supplierId: "S-002", price: 0.15 },
      actor: agent,
    });
    expect(held.status).toBe("pending_approval");
    expect(held.reasons).toEqual([
      "影响权重 9 达到阈值 6",
      "该能力被设为必须人工审核",
    ]);
    expect(getStore().inquiries.find((item) => item.id === "Q-002")?.status).toBe(
      "published",
    );

    reset();
    setPolicy({ threshold: 10, alwaysReview: [] });
    const released = invoke({
      capabilityId: "inquiry.award",
      input: { inquiryId: "Q-002", supplierId: "S-002", price: 0.15 },
      actor: agent,
    });
    expect(released.status).toBe("executed");
    expect(released.effectiveImpact).toBe(9);
    expect(released.issues).toEqual([]);

    reset();
    setPolicy({ threshold: 6, alwaysReview: [] });
    const byWeight = invoke({
      capabilityId: "inquiry.award",
      input: { inquiryId: "Q-002", supplierId: "S-002", price: 0.15 },
      actor: agent,
    });
    expect(byWeight.status).toBe("pending_approval");
    expect(byWeight.reasons).toEqual(["影响权重 9 达到阈值 6"]);
  });

  it("does not gate or audit reads, even when the threshold is 0", () => {
    setPolicy({ threshold: 0, alwaysReview: ["product.search"] });
    const before = getStore().audit.length;
    const result = invoke({
      capabilityId: "product.search",
      input: { keyword: "螺栓" },
      actor: agent,
    });
    expect(result.status).toBe("executed");
    expect(result.auditId).toBeUndefined();
    expect(getStore().audit).toHaveLength(before);
  });
});

describe("stage 1 approvals", () => {
  it("executes exactly once on approve and refuses a second decision", () => {
    const pending = invoke({
      capabilityId: "inquiry.publish",
      input: { inquiryId: "Q-001" },
      actor: agent,
    });
    const approved = decideApproval(pending.approvalId ?? "", "approve");
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.approval.status).toBe("approved");
    expect(approved.result?.status).toBe("executed");
    expect(approved.result?.stage).toBe("execute");
    expect(getStore().inquiries.find((item) => item.id === "Q-001")?.status).toBe(
      "published",
    );
    expect(listAudit().filter((entry) => entry.outcome === "approved_executed")).toHaveLength(
      1,
    );

    const again = decideApproval(pending.approvalId ?? "", "approve");
    expect(again).toMatchObject({ ok: false, status: 409 });
    expect(getStore().inquiries.find((item) => item.id === "Q-001")?.status).toBe(
      "published",
    );
  });

  it("rejects without executing and then refuses another decision", () => {
    const pending = invoke({
      capabilityId: "inquiry.publish",
      input: { inquiryId: "Q-001" },
      actor: agent,
    });
    const rejected = decideApproval(pending.approvalId ?? "", "reject", "先不要发");
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.approval.status).toBe("rejected");
    expect(rejected.approval.note).toBe("先不要发");
    expect(getStore().inquiries.find((item) => item.id === "Q-001")?.status).toBe(
      "draft",
    );
    expect(listAudit().some((entry) => entry.outcome === "executed")).toBe(false);
    expect(listAudit().some((entry) => entry.outcome === "approved_executed")).toBe(
      false,
    );
    expect(listAudit().some((entry) => entry.outcome === "approval_rejected")).toBe(
      true,
    );

    const again = decideApproval(pending.approvalId ?? "", "reject");
    expect(again).toMatchObject({ ok: false, status: 409 });
  });

  it("re-verifies an approval against the current state and rejects it when a block appears", () => {
    const pending = invoke({
      capabilityId: "inquiry.publish",
      input: { inquiryId: "Q-001" },
      actor: agent,
    });
    invoke({
      capabilityId: "inquiry.publish",
      input: { inquiryId: "Q-001" },
      actor: human,
    });
    expect(getStore().inquiries.find((item) => item.id === "Q-001")?.status).toBe(
      "published",
    );

    const decided = decideApproval(pending.approvalId ?? "", "approve");
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.approval.status).toBe("rejected");
    expect(decided.approval.resultSummary).toMatch(/只能发布草稿/);
    expect(decided.result?.status).toBe("rejected");
    expect(decided.result?.stage).toBe("verifier");
    expect(getStore().inquiries.find((item) => item.id === "Q-001")?.status).toBe(
      "published",
    );
    expect(
      listAudit().some(
        (entry) =>
          entry.outcome === "approval_rejected" &&
          /只能发布草稿/.test(entry.summary),
      ),
    ).toBe(true);
    expect(listAudit().some((entry) => entry.outcome === "approved_executed")).toBe(
      false,
    );
  });
});

describe("stage 1 audit", () => {
  it("records executed, rejected, pending, and approved outcomes, newest first", () => {
    const rejected = invoke({
      capabilityId: "product.create",
      input: productInput("不锈钢螺栓"),
      actor: agent,
    });
    const pending = invoke({
      capabilityId: "inquiry.publish",
      input: { inquiryId: "Q-001" },
      actor: agent,
    });
    decideApproval(pending.approvalId ?? "", "approve");
    const executed = invoke({
      capabilityId: "product.create",
      input: productInput("审计产品"),
      actor: human,
    });

    const outcomes = listAudit().map((entry) => entry.outcome);
    expect(outcomes[0]).toBe("executed");
    expect(outcomes).toContain("rejected");
    expect(outcomes).toContain("pending_approval");
    expect(outcomes).toContain("approved_executed");
    expect(findAudit(rejected.auditId ?? "")?.stage).toBe("verifier");
    expect(findAudit(executed.auditId ?? "")?.undoable).toBe(true);
    expect(findAudit(executed.auditId ?? "")?.undoData).toEqual({
      id: (executed.data as Product).id,
    });

    const schema = invoke({
      capabilityId: "product.create",
      input: { name: 1 },
      actor: agent,
    });
    expect(schema.stage).toBe("schema");
    expect(findAudit(schema.auditId ?? "")?.outcome).toBe("rejected");
    const beforeReads = getStore().audit.length;
    invoke({
      capabilityId: "inquiry.list",
      input: { keyword: 1 },
      actor: agent,
    });
    expect(getStore().audit).toHaveLength(beforeReads);
  });

  it("marks an entry as reviewed", () => {
    const created = invoke({
      capabilityId: "product.create",
      input: productInput("抽查产品"),
      actor: human,
    });
    const flagged = reviewAudit(created.auditId ?? "", "flagged", "名称可疑");
    expect(flagged.ok).toBe(true);
    if (!flagged.ok) return;
    expect(flagged.entry.review?.mark).toBe("flagged");
    expect(flagged.entry.review?.note).toBe("名称可疑");
    expect(flagged.entry.review?.at).toMatch(/^\d{4}-/);

    const cleared = reviewAudit(created.auditId ?? "", "ok");
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.entry.review).toMatchObject({ mark: "ok" });
    expect(cleared.entry.review?.note).toBeUndefined();
    expect(reviewAudit("L-999", "ok")).toMatchObject({ ok: false, status: 404 });
  });

  it("reverts product.create, inquiry.create, and inquiry.publish, and refuses award or a second revert", () => {
    const created = invoke({
      capabilityId: "product.create",
      input: productInput("可撤销产品"),
      actor: human,
    });
    const productId = (created.data as Product).id;
    const productAudit = created.auditId ?? "";
    const revertedProduct = revertAudit(productAudit);
    expect(revertedProduct.ok).toBe(true);
    if (!revertedProduct.ok) return;
    expect(revertedProduct.entry.reverted).toBe(true);
    expect(revertedProduct.revertEntry.summary).toContain(`已撤销 ${productAudit}`);
    expect(revertedProduct.revertEntry.outcome).toBe("reverted");
    expect(getStore().products.some((item) => item.id === productId)).toBe(false);
    expect(revertAudit(productAudit)).toMatchObject({
      ok: false,
      status: 409,
      message: "该记录已经撤销，不能重复撤销",
    });

    const drafted = invoke({
      capabilityId: "inquiry.create",
      input: inquiryInput("P-004", { supplierIds: ["S-002"] }),
      actor: human,
    });
    const inquiryId = (drafted.data as Inquiry).id;
    expect(revertAudit(drafted.auditId ?? "").ok).toBe(true);
    expect(getStore().inquiries.some((item) => item.id === inquiryId)).toBe(false);

    const published = invoke({
      capabilityId: "inquiry.publish",
      input: { inquiryId: "Q-001" },
      actor: human,
    });
    expect(getStore().inquiries.find((item) => item.id === "Q-001")?.status).toBe(
      "published",
    );
    expect(revertAudit(published.auditId ?? "").ok).toBe(true);
    expect(getStore().inquiries.find((item) => item.id === "Q-001")?.status).toBe(
      "draft",
    );

    const awarded = invoke({
      capabilityId: "inquiry.award",
      input: { inquiryId: "Q-002", supplierId: "S-002", price: 0.15 },
      actor: human,
    });
    const awardRevert = revertAudit(awarded.auditId ?? "");
    expect(awardRevert).toMatchObject({ ok: false, status: 409 });
    if (awardRevert.ok) return;
    expect(awardRevert.message).toBe("确认中标不可撤销");
    expect(getStore().inquiries.find((item) => item.id === "Q-002")?.status).toBe(
      "awarded",
    );

    const held = invoke({
      capabilityId: "inquiry.publish",
      input: { inquiryId: "Q-001" },
      actor: agent,
    });
    expect(revertAudit(held.auditId ?? "")).toMatchObject({
      ok: false,
      status: 409,
      message: "只有已执行的操作可以撤销",
    });
  });

  it("does not reuse an id after create, revert, and create", () => {
    const first = invoke({
      capabilityId: "product.create",
      input: productInput("第一次"),
      actor: agent,
    });
    expect((first.data as Product).id).toBe("P-007");
    expect(getStore().counters.product).toBe(7);
    expect(revertAudit(first.auditId ?? "").ok).toBe(true);
    expect(getStore().counters.product).toBe(7);
    const second = invoke({
      capabilityId: "product.create",
      input: productInput("第二次"),
      actor: agent,
    });
    expect((second.data as Product).id).toBe("P-008");
    expect(getStore().products.map((item) => item.id)).not.toContain("P-007");
    expect(getStore().products.map((item) => item.id)).toContain("P-008");
  });
});

describe("stage 1 policy", () => {
  it("seeds alwaysReview from capability flags and restores it on reset", () => {
    expect(getPolicy()).toEqual({
      threshold: 6,
      alwaysReview: ["inquiry.award"],
    });
    expect(getCapability("inquiry.award")?.alwaysReview).toBe(true);
    const saved = setPolicy({ threshold: 8, alwaysReview: ["inquiry.award", "inquiry.award"] });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.policy).toEqual({ threshold: 8, alwaysReview: ["inquiry.award"] });
    const invalid = setPolicy({ threshold: 11, alwaysReview: [] });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.errors.some((error) => /0 到 10/.test(error.message))).toBe(true);
    expect(getPolicy().threshold).toBe(8);
    const unknown = setPolicy({ threshold: 6, alwaysReview: ["no.such"] });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.errors[0]?.message).toMatch(/未知能力「no.such」/);
    reset();
    expect(getPolicy()).toEqual({
      threshold: 6,
      alwaysReview: ["inquiry.award"],
    });
    expect(pendingApprovalCount()).toBe(0);
    expect(getStore().audit).toEqual([]);
  });
});

describe("stage 1 http", () => {
  it("treats an omitted actor as an agent and keeps an explicit human", async () => {
    const response = await invokeRoute(
      new Request("http://localhost/api/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capabilityId: "inquiry.award",
          input: { inquiryId: "Q-002", supplierId: "S-002", price: 0.15 },
        }),
      }),
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as InvokeResult;
    expect(body.status).toBe("pending_approval");
    expect(body.actor).toEqual(agent);
    expect(body.approvalId).toBe("A-001");
    expect(getStore().inquiries.find((item) => item.id === "Q-002")?.status).toBe(
      "published",
    );

    const humanResponse = await invokeRoute(
      new Request("http://localhost/api/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capabilityId: "product.create",
          input: productInput("人工接口产品"),
          actor: human,
        }),
      }),
    );
    expect(humanResponse.status).toBe(200);
    const created = (await humanResponse.json()) as InvokeResult;
    expect(created.status).toBe("executed");
    expect(created.actor).toEqual(human);

    const missingActor = await invokeRoute(
      new Request("http://localhost/api/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capabilityId: "product.create",
          input: productInput("空身份"),
          actor: null,
        }),
      }),
    );
    expect(missingActor.status).toBe(422);
    expect(getStore().products.some((item) => item.name === "空身份")).toBe(false);
  });

  it("returns 409 when an approval is decided twice", async () => {
    const pending = await invokeRoute(
      new Request("http://localhost/api/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capabilityId: "inquiry.publish",
          input: { inquiryId: "Q-001" },
        }),
      }),
    );
    expect(pending.status).toBe(202);
    const decided = await decideApprovalRoute(
      new Request("http://localhost/api/approvals/A-001", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      }),
      { params: Promise.resolve({ id: "A-001" }) },
    );
    expect(decided.status).toBe(200);
    const payload = (await decided.json()) as {
      approval: { status: string };
      result: InvokeResult;
    };
    expect(payload.approval.status).toBe("approved");
    expect(payload.result.status).toBe("executed");

    const again = await decideApprovalRoute(
      new Request("http://localhost/api/approvals/A-001", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "reject" }),
      }),
      { params: Promise.resolve({ id: "A-001" }) },
    );
    expect(again.status).toBe(409);
  });
});

describe("stage 1 extensibility", () => {
  it("runs verifier, gate, and audit for a capability that only adds verify", () => {
    let verifyCalls = 0;
    let executed = 0;
    let undone = 0;
    const fake = defineCapability<{ mode: string }>({
      id: "test.watch",
      module: "product",
      moduleLabel: "产品",
      title: "观察测试",
      description: "验证可选 verify 会进入同一条流水线",
      kind: "write",
      impact: 4,
      fields: [
        {
          name: "mode",
          label: "模式",
          type: "string",
          required: true,
        },
      ],
      verify(input) {
        verifyCalls += 1;
        if (input.mode === "禁止") {
          return [
            {
              level: "block",
              field: "mode",
              message: "模式不能是「禁止」，请改为「正常」",
            },
          ];
        }
        if (input.mode === "警告") {
          return [
            {
              level: "warn",
              field: "mode",
              message: "模式「警告」需要确认，请改为「正常」或继续提交",
            },
          ];
        }
        if (input.mode.startsWith("警告x")) {
          const count = Number(input.mode.slice("警告x".length));
          return Array.from({ length: count }, (_, index) => ({
            level: "warn" as const,
            field: "mode",
            message: `第 ${index + 1} 条警告，请确认后继续`,
          }));
        }
        return [];
      },
      execute(input) {
        executed += 1;
        return {
          summary: `已处理 ${input.mode}`,
          data: { mode: input.mode },
          undoData: { mode: input.mode },
        };
      },
      undo() {
        undone += 1;
      },
    });
    const guard = defineCapability<{ name: string }>({
      id: "test.guard",
      module: "product",
      moduleLabel: "产品",
      title: "兜底测试",
      description: "验证执行期 DomainError 仍会被流水线接住",
      kind: "write",
      impact: 1,
      fields: [
        { name: "name", label: "名称", type: "string", required: true },
      ],
      verify() {
        return [];
      },
      execute() {
        throw new DomainError("执行被兜底拦截，请更换名称", "name");
      },
    });
    capabilities.push(fake, guard);
    try {
      const invalid = invoke({
        capabilityId: "test.watch",
        input: { mode: 1 },
        actor: agent,
      });
      expect(invalid.stage).toBe("schema");
      expect(verifyCalls).toBe(0);
      expect(executed).toBe(0);
      expect(findAudit(invalid.auditId ?? "")?.outcome).toBe("rejected");

      const blocked = invoke({
        capabilityId: "test.watch",
        input: { mode: "禁止" },
        actor: agent,
      });
      expect(blocked.status).toBe("rejected");
      expect(blocked.stage).toBe("verifier");
      expect(blocked.summary).toMatch(/请改为「正常」/);
      expect(executed).toBe(0);
      expect(findAudit(blocked.auditId ?? "")?.outcome).toBe("rejected");

      const warned = invoke({
        capabilityId: "test.watch",
        input: { mode: "警告" },
        actor: agent,
      });
      expect(warned.status).toBe("pending_approval");
      expect(warned.effectiveImpact).toBe(6);
      expect(executed).toBe(0);
      expect(findAudit(warned.auditId ?? "")?.outcome).toBe("pending_approval");

      const byHuman = invoke({
        capabilityId: "test.watch",
        input: { mode: "警告" },
        actor: human,
      });
      expect(byHuman.status).toBe("executed");
      expect(byHuman.effectiveImpact).toBe(6);
      expect(executed).toBe(1);
      expect(revertAudit(byHuman.auditId ?? "").ok).toBe(true);
      expect(undone).toBe(1);

      const clean = invoke({
        capabilityId: "test.watch",
        input: { mode: "正常" },
        actor: agent,
      });
      expect(clean.status).toBe("executed");
      expect(clean.effectiveImpact).toBe(4);

      setPolicy({ threshold: 10, alwaysReview: ["test.watch"] });
      const forced = invoke({
        capabilityId: "test.watch",
        input: { mode: "正常" },
        actor: agent,
      });
      expect(forced.status).toBe("pending_approval");
      expect(forced.reasons).toEqual(["该能力被设为必须人工审核"]);

      const heavy = invoke({
        capabilityId: "test.watch",
        input: { mode: "警告x4" },
        actor: human,
      });
      expect(heavy.effectiveImpact).toBe(10);
      expect(heavy.issues).toHaveLength(4);

      const guarded = invoke({
        capabilityId: "test.guard",
        input: { name: "兜底" },
        actor: human,
      });
      expect(guarded.status).toBe("rejected");
      expect(guarded.stage).toBe("execute");
      expect(guarded.summary).toMatch(/请更换名称/);
      expect(findAudit(guarded.auditId ?? "")).toMatchObject({
        outcome: "rejected",
        stage: "execute",
      });
    } finally {
      for (const id of ["test.watch", "test.guard"]) {
        const index = capabilities.findIndex((item) => item.id === id);
        if (index >= 0) capabilities.splice(index, 1);
      }
    }
    expect(getCapability("test.watch")).toBeUndefined();
  });

  it("picks up a new alwaysReview flag the next time the default policy is seeded", () => {
    const flagged = defineCapability({
      id: "test.flagged",
      module: "product",
      moduleLabel: "产品",
      title: "默认必审",
      description: "验证默认策略来自能力定义上的 alwaysReview",
      kind: "write",
      impact: 1,
      alwaysReview: true,
      fields: [],
      execute() {
        return { summary: "不会被调用" };
      },
    });
    capabilities.push(flagged);
    try {
      reset();
      expect(getPolicy().alwaysReview).toEqual(["inquiry.award", "test.flagged"]);
    } finally {
      const index = capabilities.findIndex((item) => item.id === "test.flagged");
      if (index >= 0) capabilities.splice(index, 1);
      reset();
    }
    expect(getPolicy().alwaysReview).toEqual(["inquiry.award"]);
  });
});

describe("stage 1 http policy and audit routes", () => {
  it("rejects an invalid policy and accepts a valid one", async () => {
    const invalid = await putPolicy(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threshold: 6.5, alwaysReview: ["inquiry.award"] }),
      }),
    );
    expect(invalid.status).toBe(422);
    const invalidBody = (await invalid.json()) as { errors: { message: string }[] };
    expect(invalidBody.errors.some((error) => /整数/.test(error.message))).toBe(true);
    expect(getPolicy().threshold).toBe(6);

    const saved = await putPolicy(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threshold: 7, alwaysReview: ["inquiry.award"] }),
      }),
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      threshold: 7,
      alwaysReview: ["inquiry.award"],
    });
  });

  it("reviews and refuses to revert an award through the routes", async () => {
    const awarded = invoke({
      capabilityId: "inquiry.award",
      input: { inquiryId: "Q-002", supplierId: "S-002", price: 0.15 },
      actor: human,
    });
    const reviewed = await reviewRoute(
      new Request("http://localhost/api/audit/L-001/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mark: "ok", note: "抽查通过" }),
      }),
      { params: Promise.resolve({ id: awarded.auditId ?? "" }) },
    );
    expect(reviewed.status).toBe(200);
    const reviewBody = (await reviewed.json()) as {
      entry: { review: { mark: string; note: string } };
    };
    expect(reviewBody.entry.review).toMatchObject({ mark: "ok", note: "抽查通过" });

    const refused = await revertRoute(
      new Request("http://localhost/api/audit/L-001/revert", { method: "POST" }),
      { params: Promise.resolve({ id: awarded.auditId ?? "" }) },
    );
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { message: string };
    expect(body.message).toBe("确认中标不可撤销");
  });
});
