export const FIELD_LABELS: Record<string, string> = {
  id: "编号",
  keyword: "关键词",
  name: "名称",
  category: "品类",
  categories: "品类",
  unit: "单位",
  referencePrice: "参考价",
  productId: "产品",
  quantity: "数量",
  deadline: "截止日期",
  supplierIds: "供应商",
  supplierId: "供应商",
  note: "备注",
  status: "状态",
  outcome: "结果",
  inquiryId: "询价单",
  price: "价格",
  rating: "评分",
  createdAt: "创建时间",
  award: "中标",
  total: "合计",
};

export const COLUMN_ORDER = [
  "id",
  "name",
  "category",
  "categories",
  "unit",
  "referencePrice",
  "rating",
  "productId",
  "quantity",
  "deadline",
  "supplierIds",
  "supplierId",
  "price",
  "status",
  "outcome",
  "note",
  "createdAt",
  "award",
];

export const STATUS_LABELS: Record<string, string> = {
  executed: "已执行",
  pending_approval: "待人工审核",
  rejected: "已拦截",
  draft: "草稿",
  published: "已发布",
  awarded: "已中标",
  pending: "待处理",
  approved: "已批准",
  approved_executed: "批准并执行",
  approval_rejected: "审批驳回",
  reverted: "已撤销",
};

export function fieldLabel(name: string): string {
  return FIELD_LABELS[name] ?? name;
}

export function statusLabel(status: string): string | undefined {
  return STATUS_LABELS[status];
}
