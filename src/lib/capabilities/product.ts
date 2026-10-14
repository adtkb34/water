import { defineCapability } from "@/lib/contract/types";
import { CATEGORIES, UNITS } from "@/lib/domain";
import { asRecords } from "@/lib/records";
import { allocateId, removeAllocated } from "@/lib/server/db";

const productModule = { module: "product" as const, moduleLabel: "产品" };

export const productSearch = defineCapability<{ keyword?: string }>({
  id: "product.search",
  ...productModule,
  title: "搜索产品",
  description: "按关键词搜索产品。关键词留空时返回全部产品。",
  kind: "read",
  impact: 0,
  keywords: ["查产品", "搜索产品", "找产品", "产品列表"],
  fields: [
    {
      name: "keyword",
      label: "关键词",
      type: "string",
      required: false,
      description: "匹配产品名称、编号、品类或单位",
      hints: ["搜索", "查找", "关键词", "产品"],
    },
  ],
  execute(input, ctx) {
    const keyword = input.keyword?.trim().toLowerCase() ?? "";
    const products = ctx.store.products.filter((product) => {
      if (!keyword) return true;
      return [product.id, product.name, product.category, product.unit]
        .join(" ")
        .toLowerCase()
        .includes(keyword);
    });
    return {
      summary: products.length
        ? `找到 ${products.length} 个产品`
        : "没有找到匹配的产品",
      data: { total: products.length },
      records: asRecords(products),
    };
  },
});

export const productCreate = defineCapability<{
  name: string;
  category: string;
  unit: string;
  referencePrice: number;
}>({
  id: "product.create",
  ...productModule,
  title: "新建产品",
  description: "新建产品，记录名称、品类、单位和参考价。",
  kind: "write",
  impact: 2,
  keywords: ["新建产品", "添加产品", "创建产品"],
  fields: [
    {
      name: "name",
      label: "名称",
      type: "string",
      required: true,
      description: "产品名称",
      hints: ["名称", "品名", "叫做"],
    },
    {
      name: "category",
      label: "品类",
      type: "enum",
      required: true,
      description: "产品品类",
      hints: ["品类", "类别", "分类"],
      options: [...CATEGORIES],
    },
    {
      name: "unit",
      label: "单位",
      type: "enum",
      required: true,
      description: "计量单位",
      hints: ["单位"],
      options: [...UNITS],
    },
    {
      name: "referencePrice",
      label: "参考价",
      type: "number",
      required: true,
      description: "参考单价",
      hints: ["参考价", "单价", "价格"],
      min: 0,
    },
  ],
  execute(input, ctx) {
    const product = {
      id: allocateId(ctx.store, "product"),
      name: input.name.trim(),
      category: input.category,
      unit: input.unit,
      referencePrice: input.referencePrice,
    };
    ctx.store.products.push(product);
    return {
      summary: `已创建产品 ${product.id} ${product.name}`,
      data: product,
      records: asRecords([product]),
      undoData: { id: product.id },
    };
  },
  undo(undoData, ctx) {
    const id = (undoData as { id?: string } | undefined)?.id;
    if (!id) return;
    removeAllocated(ctx.store.products, id);
  },
  verify(input, ctx) {
    const name = input.name.trim();
    const existing = ctx.store.products.find((product) => product.name === name);
    if (!existing) return [];
    return [
      {
        level: "block",
        field: "name",
        message: `已存在同名产品「${name}」（${existing.id}）。请更换名称后再创建`,
      },
    ];
  },
});
