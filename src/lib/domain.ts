export const CATEGORIES = ["五金", "电子", "包材", "原料"] as const;
export const UNITS = ["件", "个", "台", "千克", "吨", "米"] as const;
export const INQUIRY_STATUSES = ["draft", "published", "awarded"] as const;

export const INQUIRY_STATUS_LABEL: Record<
  (typeof INQUIRY_STATUSES)[number],
  string
> = {
  draft: "草稿",
  published: "已发布",
  awarded: "已中标",
};

export const REF_KINDS = {
  product: { prefix: "P", example: "P-001", noun: "产品" },
  supplier: { prefix: "S", example: "S-001", noun: "供应商" },
  inquiry: { prefix: "Q", example: "Q-001", noun: "询价单" },
} as const;
