import { defineCapability } from "@/lib/contract/types";
import { CATEGORIES } from "@/lib/domain";
import { asRecords } from "@/lib/records";

export const supplierList = defineCapability<{
  keyword?: string;
  category?: string;
}>({
  id: "supplier.list",
  module: "procurement",
  moduleLabel: "采购",
  title: "供应商列表",
  description: "查看供应商，可按品类或关键词筛选。",
  kind: "read",
  impact: 0,
  keywords: ["供应商", "查供应商", "厂家"],
  fields: [
    {
      name: "keyword",
      label: "关键词",
      type: "string",
      required: false,
      description: "匹配供应商名称或编号",
      hints: ["搜索", "供应商", "厂家"],
    },
    {
      name: "category",
      label: "品类",
      type: "enum",
      required: false,
      description: "只看覆盖该品类的供应商",
      hints: ["品类", "类别"],
      options: [...CATEGORIES],
    },
  ],
  execute(input, ctx) {
    const keyword = input.keyword?.trim().toLowerCase() ?? "";
    const suppliers = ctx.store.suppliers.filter((supplier) => {
      if (input.category && !supplier.categories.includes(input.category)) {
        return false;
      }
      if (!keyword) return true;
      return [supplier.id, supplier.name, ...supplier.categories]
        .join(" ")
        .toLowerCase()
        .includes(keyword);
    });
    return {
      summary: suppliers.length
        ? `找到 ${suppliers.length} 家供应商`
        : "没有找到匹配的供应商",
      data: { total: suppliers.length },
      records: asRecords(suppliers),
    };
  },
});
