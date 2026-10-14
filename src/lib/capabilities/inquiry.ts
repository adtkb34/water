import { DomainError } from "@/lib/contract/errors";
import { defineCapability } from "@/lib/contract/types";
import type { Inquiry, Issue } from "@/lib/contract/types";
import { daysFromToday } from "@/lib/dates";
import {
  INQUIRY_STATUSES,
  INQUIRY_STATUS_LABEL,
} from "@/lib/domain";
import { asRecords } from "@/lib/records";
import { allocateId, removeAllocated } from "@/lib/server/db";

const inquiryModule = { module: "inquiry" as const, moduleLabel: "询价" };

function statusText(status: string): string {
  if (status in INQUIRY_STATUS_LABEL) {
    return INQUIRY_STATUS_LABEL[status as keyof typeof INQUIRY_STATUS_LABEL];
  }
  return status;
}

function today(): string {
  return daysFromToday(0);
}

function money(value: number): string {
  return String(Math.round(value * 10000) / 10000);
}

function scaled(value: number): number {
  return Math.round(value * 1_000_000);
}

function aboveRatio(price: number, reference: number, ratio: number): boolean {
  return scaled(price) > scaled(reference * ratio);
}

function requireInquiry(inquiries: Inquiry[], id: string): Inquiry {
  const inquiry = inquiries.find((item) => item.id === id);
  if (!inquiry) {
    throw new DomainError(`找不到询价单「${id}」`, "inquiryId");
  }
  return inquiry;
}

export const inquiryList = defineCapability<{
  status?: string;
  keyword?: string;
}>({
  id: "inquiry.list",
  ...inquiryModule,
  title: "询价单列表",
  description: "查看询价单，可按状态或关键词筛选。",
  kind: "read",
  impact: 0,
  keywords: ["询价单", "查询价", "询价列表"],
  fields: [
    {
      name: "status",
      label: "状态",
      type: "enum",
      required: false,
      description: "询价单状态",
      hints: ["状态", "草稿", "已发布", "已中标"],
      options: [...INQUIRY_STATUSES],
      optionLabels: { ...INQUIRY_STATUS_LABEL },
    },
    {
      name: "keyword",
      label: "关键词",
      type: "string",
      required: false,
      description: "匹配询价单编号、产品名称或备注",
      hints: ["搜索", "单号", "询价"],
    },
  ],
  execute(input, ctx) {
    const keyword = input.keyword?.trim().toLowerCase() ?? "";
    const inquiries = ctx.store.inquiries.filter((inquiry) => {
      if (input.status && inquiry.status !== input.status) return false;
      if (!keyword) return true;
      const product = ctx.store.products.find(
        (item) => item.id === inquiry.productId,
      );
      return [inquiry.id, inquiry.note ?? "", product?.name ?? "", inquiry.status]
        .join(" ")
        .toLowerCase()
        .includes(keyword);
    });
    return {
      summary: inquiries.length
        ? `找到 ${inquiries.length} 张询价单`
        : "没有找到匹配的询价单",
      data: { total: inquiries.length },
      records: asRecords(inquiries),
    };
  },
});

export const inquiryCreate = defineCapability<{
  productId: string;
  quantity: number;
  deadline: string;
  supplierIds: string[];
  note?: string;
}>({
  id: "inquiry.create",
  ...inquiryModule,
  title: "创建询价",
  description: "为产品创建一张草稿询价单。",
  kind: "write",
  impact: 3,
  keywords: ["创建询价", "新建询价", "发询价", "询价草稿"],
  fields: [
    {
      name: "productId",
      label: "产品",
      type: "ref",
      required: true,
      description: "要采购的产品",
      hints: ["产品", "商品"],
      refKind: "product",
    },
    {
      name: "quantity",
      label: "数量",
      type: "number",
      required: true,
      description: "采购数量",
      hints: ["数量", "个数", "采购量"],
      min: 1,
      integer: true,
    },
    {
      name: "deadline",
      label: "截止日期",
      type: "date",
      required: true,
      description: "报价截止日期",
      hints: ["截止日期", "交期", "日期", "之前"],
    },
    {
      name: "supplierIds",
      label: "供应商",
      type: "multiref",
      required: true,
      description: "邀请报价的供应商",
      hints: ["供应商", "厂家"],
      refKind: "supplier",
    },
    {
      name: "note",
      label: "备注",
      type: "string",
      required: false,
      description: "给供应商的补充说明",
      hints: ["备注", "说明"],
    },
  ],
  execute(input, ctx) {
    const note = input.note?.trim();
    const inquiry: Inquiry = {
      id: allocateId(ctx.store, "inquiry"),
      productId: input.productId,
      quantity: input.quantity,
      deadline: input.deadline,
      supplierIds: [...input.supplierIds],
      status: "draft",
      createdAt: new Date().toISOString(),
      ...(note ? { note } : {}),
    };
    ctx.store.inquiries.push(inquiry);
    return {
      summary: `已创建询价草稿 ${inquiry.id}`,
      data: inquiry,
      records: asRecords([inquiry]),
      undoData: { id: inquiry.id },
    };
  },
  undo(undoData, ctx) {
    const id = (undoData as { id?: string } | undefined)?.id;
    if (!id) return;
    removeAllocated(ctx.store.inquiries, id);
  },
  verify(input, ctx) {
    const issues: Issue[] = [];
    const currentDay = today();
    if (input.deadline <= currentDay) {
      issues.push({
        level: "block",
        field: "deadline",
        message: `截止日期 ${input.deadline} 不是未来日期（今天是 ${currentDay}）。请改为 ${daysFromToday(1)} 或更晚的日期`,
      });
    }
    if (input.quantity > 100000) {
      issues.push({
        level: "block",
        field: "quantity",
        message: `数量 ${input.quantity} 超过上限 100000。请把数量改为不大于 100000 的整数`,
      });
    }
    if (input.quantity > 5000) {
      issues.push({
        level: "warn",
        field: "quantity",
        message: `数量异常偏大（${input.quantity}）。请确认是否仍要采购这么多，或把数量改为 5000 及以下`,
      });
    }
    const product = ctx.store.products.find((item) => item.id === input.productId);
    if (product) {
      for (const supplierId of input.supplierIds) {
        const supplier = ctx.store.suppliers.find((item) => item.id === supplierId);
        if (!supplier || supplier.categories.includes(product.category)) continue;
        issues.push({
          level: "warn",
          field: "supplierIds",
          message: `供应商 ${supplier.id} ${supplier.name} 的品类（${supplier.categories.join("、")}）不包含产品「${product.name}」的品类「${product.category}」。请改选覆盖「${product.category}」的供应商，或从 supplierIds 中移除 ${supplier.id}`,
        });
      }
      const open = ctx.store.inquiries.filter(
        (inquiry) =>
          inquiry.productId === product.id &&
          (inquiry.status === "draft" || inquiry.status === "published"),
      );
      if (open.length > 0) {
        const listed = open
          .map((inquiry) => `${inquiry.id}（${statusText(inquiry.status)}）`)
          .join("、");
        issues.push({
          level: "warn",
          field: "productId",
          message: `产品 ${product.id} ${product.name} 已有进行中的询价单 ${listed}。请确认是否仍要新建，或改用这些询价单而不是再次调用 inquiry.create`,
        });
      }
    }
    return issues;
  },
});

export const inquiryPublish = defineCapability<{ inquiryId: string }>({
  id: "inquiry.publish",
  ...inquiryModule,
  title: "发布询价",
  description: "把草稿询价单发布给供应商。",
  kind: "write",
  impact: 6,
  keywords: ["发布询价", "发给供应商", "对外发布"],
  fields: [
    {
      name: "inquiryId",
      label: "询价单",
      type: "ref",
      required: true,
      description: "要发布的草稿询价单",
      hints: ["询价单", "单号", "发布"],
      refKind: "inquiry",
      refFilter: ["draft"],
    },
  ],
  execute(input, ctx) {
    const inquiry = requireInquiry(ctx.store.inquiries, input.inquiryId);
    if (inquiry.status !== "draft") {
      throw new DomainError(
        `只能发布草稿状态的询价单，当前是${statusText(inquiry.status)}`,
        "inquiryId",
      );
    }
    const previousStatus = inquiry.status;
    inquiry.status = "published";
    return {
      summary: `询价单 ${inquiry.id} 已发布`,
      data: { ...inquiry, supplierIds: [...inquiry.supplierIds] },
      undoData: { id: inquiry.id, status: previousStatus },
    };
  },
  undo(undoData, ctx) {
    const data = undoData as { id?: string; status?: Inquiry["status"] };
    if (!data?.id || !data.status) return;
    const inquiry = ctx.store.inquiries.find((item) => item.id === data.id);
    if (!inquiry) return;
    inquiry.status = data.status;
  },
  verify(input, ctx) {
    const inquiry = ctx.store.inquiries.find((item) => item.id === input.inquiryId);
    if (!inquiry) return [];
    const issues: Issue[] = [];
    if (inquiry.status !== "draft") {
      issues.push({
        level: "block",
        field: "inquiryId",
        message: `只能发布草稿状态的询价单，当前是${statusText(inquiry.status)}。请改用草稿询价单`,
      });
    }
    if (inquiry.supplierIds.length === 0) {
      issues.push({
        level: "block",
        field: "inquiryId",
        message: `询价单 ${inquiry.id} 没有供应商，无法发布。请重新创建询价单并至少选择一个供应商后再发布`,
      });
    }
    const currentDay = today();
    if (inquiry.deadline <= currentDay) {
      issues.push({
        level: "block",
        field: "inquiryId",
        message: `询价单 ${inquiry.id} 的截止日期 ${inquiry.deadline} 不是未来日期（今天是 ${currentDay}）。请重新创建截止日期为 ${daysFromToday(1)} 或更晚的询价单后再发布`,
      });
    }
    return issues;
  },
});

export const inquiryAward = defineCapability<{
  inquiryId: string;
  supplierId: string;
  price: number;
}>({
  id: "inquiry.award",
  module: "procurement",
  moduleLabel: "采购",
  title: "确认中标",
  description: "确认已发布询价单的中标供应商和成交价。此操作不可撤销。",
  kind: "write",
  impact: 9,
  alwaysReview: true,
  keywords: ["中标", "定标", "确认中标", "成交"],
  fields: [
    {
      name: "inquiryId",
      label: "询价单",
      type: "ref",
      required: true,
      description: "要确认中标的已发布询价单",
      hints: ["询价单", "单号"],
      refKind: "inquiry",
      refFilter: ["published"],
    },
    {
      name: "supplierId",
      label: "中标供应商",
      type: "ref",
      required: true,
      description: "成交供应商，必须在该询价单的邀请名单中",
      hints: ["供应商", "中标方", "厂家"],
      refKind: "supplier",
    },
    {
      name: "price",
      label: "中标价",
      type: "number",
      required: true,
      description: "成交单价",
      hints: ["价格", "中标价", "单价", "成交价"],
      min: 0,
    },
  ],
  execute(input, ctx) {
    const inquiry = requireInquiry(ctx.store.inquiries, input.inquiryId);
    if (inquiry.status !== "published") {
      throw new DomainError(
        `只能对已发布的询价单确认中标，当前是${statusText(inquiry.status)}`,
        "inquiryId",
      );
    }
    if (!inquiry.supplierIds.includes(input.supplierId)) {
      throw new DomainError(
        "中标供应商不在该询价单的供应商名单中",
        "supplierId",
      );
    }
    inquiry.status = "awarded";
    inquiry.award = { supplierId: input.supplierId, price: input.price };
    return {
      summary: `询价单 ${inquiry.id} 已确认中标`,
      data: {
        ...inquiry,
        supplierIds: [...inquiry.supplierIds],
        award: { ...inquiry.award },
      },
    };
  },
  verify(input, ctx) {
    const inquiry = ctx.store.inquiries.find((item) => item.id === input.inquiryId);
    if (!inquiry) return [];
    const issues: Issue[] = [];
    if (inquiry.status !== "published") {
      issues.push({
        level: "block",
        field: "inquiryId",
        message: `只能对已发布的询价单确认中标，当前是${statusText(inquiry.status)}。请改用已发布的询价单`,
      });
    }
    if (!inquiry.supplierIds.includes(input.supplierId)) {
      const invited = inquiry.supplierIds
        .map((id) => {
          const supplier = ctx.store.suppliers.find((item) => item.id === id);
          return supplier ? `${id} ${supplier.name}` : id;
        })
        .join("、");
      issues.push({
        level: "block",
        field: "supplierId",
        message: `中标供应商 ${input.supplierId} 不在该询价单的供应商名单中。请把 supplierId 改为已邀请的供应商：${invited || "（无）"}`,
      });
    }
    if (input.price <= 0) {
      issues.push({
        level: "block",
        field: "price",
        message: `中标价必须大于 0，当前是 ${input.price}。请把 price 改为大于 0 的数字`,
      });
    }
    const product = ctx.store.products.find((item) => item.id === inquiry.productId);
    if (product && input.price > 0) {
      const limit = product.referencePrice * 1.3;
      const warnAt = product.referencePrice * 1.1;
      if (aboveRatio(input.price, product.referencePrice, 1.3)) {
        issues.push({
          level: "block",
          field: "price",
          message: `中标价 ${input.price} 高于产品 ${product.name} 参考价 ${money(product.referencePrice)} 的 30%（上限 ${money(limit)}）。请把 price 改为不高于 ${money(limit)}`,
        });
      } else if (aboveRatio(input.price, product.referencePrice, 1.1)) {
        issues.push({
          level: "warn",
          field: "price",
          message: `中标价 ${input.price} 高于产品 ${product.name} 参考价 ${money(product.referencePrice)} 的 10%（警戒线 ${money(warnAt)}）。请确认价格，或把 price 改为不高于 ${money(warnAt)}`,
        });
      }
    }
    return issues;
  },
});
