import { beforeEach, describe, expect, it } from "vitest";
import { validateValues } from "@/lib/contract/derive";
import {
  capabilities,
  getCapability,
  getJsonSchemas,
  getUiSpecs,
} from "@/lib/contract/registry";
import { defineCapability } from "@/lib/contract/types";
import type { Actor, Inquiry, InvokeResult, Product, Store } from "@/lib/contract/types";
import { daysFromToday } from "@/lib/dates";
import { getStore, reset } from "@/lib/server/db";
import { invoke } from "@/lib/server/invoke";

const actor: Actor = { kind: "human", surface: "workbench" };

function businessOf(store: Store) {
  return {
    products: store.products,
    suppliers: store.suppliers,
    inquiries: store.inquiries,
    counters: store.counters,
  };
}

function runUnchanged(action: () => InvokeResult): InvokeResult {
  const before = structuredClone(businessOf(getStore()));
  const result = action();
  expect(businessOf(getStore())).toEqual(before);
  return result;
}

function expectFieldError(result: InvokeResult, field: string, pattern: RegExp) {
  expect(result.status).toBe("rejected");
  expect(
    result.errors?.some(
      (error) => error.field === field && pattern.test(error.message),
    ),
  ).toBe(true);
}

beforeEach(() => {
  reset();
});

describe("stage 0", () => {
  it("creates a product, drafts an inquiry, and publishes it", () => {
    const deadline = daysFromToday(30);
    const created = invoke({
      capabilityId: "product.create",
      input: {
        name: "测试垫片",
        category: "五金",
        unit: "件",
        referencePrice: 1.25,
      },
      actor,
    });
    expect(created.status).toBe("executed");
    expect(created.impact).toBe(2);
    expect(created.actor).toEqual(actor);
    const product = created.data as Product;
    expect(product.id).toBe("P-007");

    const drafted = invoke({
      capabilityId: "inquiry.create",
      input: {
        productId: product.id,
        quantity: 120,
        deadline,
        supplierIds: ["S-001", "S-005"],
        note: "阶段0验收",
      },
      actor,
    });
    expect(drafted.status).toBe("executed");
    expect(drafted.impact).toBe(3);
    const inquiry = drafted.data as Inquiry;
    expect(inquiry.id).toBe("Q-003");
    expect(inquiry.status).toBe("draft");

    const published = invoke({
      capabilityId: "inquiry.publish",
      input: { inquiryId: inquiry.id },
      actor,
    });
    expect(published.status).toBe("executed");
    expect(published.impact).toBe(6);
    expect(published.summary).toContain("已发布");

    const store = getStore();
    expect(store.products.find((item) => item.id === "P-007")).toMatchObject({
      name: "测试垫片",
      category: "五金",
      unit: "件",
      referencePrice: 1.25,
    });
    expect(store.inquiries.find((item) => item.id === "Q-003")).toMatchObject({
      productId: "P-007",
      quantity: 120,
      deadline,
      supplierIds: ["S-001", "S-005"],
      note: "阶段0验收",
      status: "published",
    });
    expect(store.inquiries.find((item) => item.id === "Q-001")?.status).toBe(
      "draft",
    );
    expect(store.inquiries.find((item) => item.id === "Q-002")?.status).toBe(
      "published",
    );
  });

  it("lists seeded products, suppliers, and inquiries", () => {
    const products = invoke({
      capabilityId: "product.search",
      input: { keyword: "螺栓" },
      actor,
    });
    expect(products.status).toBe("executed");
    expect(products.records?.map((row) => row.name)).toEqual(["不锈钢螺栓"]);

    const suppliers = invoke({
      capabilityId: "supplier.list",
      input: { category: "原料" },
      actor,
    });
    expect(suppliers.status).toBe("executed");
    expect(suppliers.records?.map((row) => row.id).sort()).toEqual([
      "S-004",
      "S-005",
    ]);

    const inquiries = invoke({
      capabilityId: "inquiry.list",
      input: { status: "draft" },
      actor,
    });
    expect(inquiries.status).toBe("executed");
    expect(inquiries.records?.map((row) => row.id)).toEqual(["Q-001"]);
  });

  it("awards a published inquiry and rejects a supplier that was not invited", () => {
    const awarded = invoke({
      capabilityId: "inquiry.award",
      input: { inquiryId: "Q-002", supplierId: "S-002", price: 0.15 },
      actor,
    });
    expect(awarded.status).toBe("executed");
    expect(getCapability("inquiry.award")?.alwaysReview).toBe(true);
    expect(getCapability("inquiry.award")?.undo).toBeUndefined();
    expect(getStore().inquiries.find((item) => item.id === "Q-002")).toMatchObject(
      {
        status: "awarded",
        award: { supplierId: "S-002", price: 0.15 },
      },
    );

    reset();
    const rejected = runUnchanged(() =>
      invoke({
        capabilityId: "inquiry.award",
        input: { inquiryId: "Q-002", supplierId: "S-001", price: 0.15 },
        actor,
      }),
    );
    expectFieldError(rejected, "supplierId", /供应商名单/);
  });

  it("reset restores counters so the next id stays deterministic", () => {
    invoke({
      capabilityId: "product.create",
      input: {
        name: "临时产品",
        category: "电子",
        unit: "台",
        referencePrice: 3,
      },
      actor,
    });
    expect(getStore().products.some((item) => item.id === "P-007")).toBe(true);
    reset();
    const again = invoke({
      capabilityId: "product.create",
      input: {
        name: "临时产品",
        category: "电子",
        unit: "台",
        referencePrice: 3,
      },
      actor,
    });
    expect((again.data as Product).id).toBe("P-007");
  });

  describe("invalid input leaves business data unchanged", () => {
    it("rejects the wrong type", () => {
      const result = runUnchanged(() =>
        invoke({
          capabilityId: "product.create",
          input: {
            name: 123,
            category: "五金",
            unit: "件",
            referencePrice: 1,
          },
          actor,
        }),
      );
      expectFieldError(result, "name", /名称必须是文本/);
    });

    it("rejects missing required fields", () => {
      const result = runUnchanged(() =>
        invoke({
          capabilityId: "product.create",
          input: {},
          actor,
        }),
      );
      expect(result.status).toBe("rejected");
      for (const field of ["name", "category", "unit", "referencePrice"]) {
        expect(result.errors?.some((error) => error.field === field)).toBe(true);
      }
      expect(result.errors?.every((error) => /请填写/.test(error.message))).toBe(
        true,
      );
    });

    it("rejects an unknown enum value", () => {
      const result = runUnchanged(() =>
        invoke({
          capabilityId: "product.create",
          input: {
            name: "未知品类",
            category: "食品",
            unit: "件",
            referencePrice: 1,
          },
          actor,
        }),
      );
      expectFieldError(result, "category", /五金、电子、包材、原料/);
    });

    it("rejects a nonexistent product id", () => {
      const result = runUnchanged(() =>
        invoke({
          capabilityId: "inquiry.create",
          input: {
            productId: "P-999",
            quantity: 10,
            deadline: daysFromToday(7),
            supplierIds: ["S-001"],
          },
          actor,
        }),
      );
      expectFieldError(result, "productId", /找不到产品「P-999」/);
    });

    it("rejects a non-integer quantity", () => {
      const result = runUnchanged(() =>
        invoke({
          capabilityId: "inquiry.create",
          input: {
            productId: "P-001",
            quantity: 1.5,
            deadline: daysFromToday(7),
            supplierIds: ["S-001"],
          },
          actor,
        }),
      );
      expectFieldError(result, "quantity", /数量必须是不小于1的整数/);
    });

    it("rejects an empty supplier list", () => {
      const result = runUnchanged(() =>
        invoke({
          capabilityId: "inquiry.create",
          input: {
            productId: "P-001",
            quantity: 10,
            deadline: daysFromToday(7),
            supplierIds: [],
          },
          actor,
        }),
      );
      expectFieldError(result, "supplierIds", /请至少选择一个供应商/);
    });

    it("rejects a nonexistent supplier id", () => {
      const result = runUnchanged(() =>
        invoke({
          capabilityId: "inquiry.create",
          input: {
            productId: "P-001",
            quantity: 10,
            deadline: daysFromToday(7),
            supplierIds: ["S-001", "S-999"],
          },
          actor,
        }),
      );
      expectFieldError(result, "supplierIds", /找不到供应商「S-999」/);
    });

    it("rejects publishing an already published inquiry", () => {
      const result = runUnchanged(() =>
        invoke({
          capabilityId: "inquiry.publish",
          input: { inquiryId: "Q-002" },
          actor,
        }),
      );
      expect(result.impact).toBe(6);
      expectFieldError(result, "inquiryId", /只能发布草稿/);
    });

    it("rejects an unknown capability", () => {
      const result = runUnchanged(() =>
        invoke({
          capabilityId: "product.missing",
          input: {},
          actor,
        }),
      );
      expect(result.status).toBe("rejected");
      expect(result.summary).toContain("未知能力");
    });

    it("checks enum membership from the field definition", () => {
      const errors = validateValues(
        [
          {
            name: "category",
            label: "品类",
            type: "enum",
            required: true,
            options: ["五金", "电子"],
          },
        ],
        { category: "食品" },
        getStore(),
      );
      expect(errors).toEqual([
        { field: "category", message: "品类必须是以下之一：五金、电子" },
      ]);
    });
  });

  it("picks up a capability registered only in the registry", () => {
    const fake = defineCapability<{ message: string }>({
      id: "test.echo",
      module: "product",
      moduleLabel: "产品",
      title: "回声测试",
      description: "只为验证注册表是唯一入口",
      kind: "read",
      impact: 1,
      fields: [
        {
          name: "message",
          label: "消息",
          type: "string",
          required: true,
          hints: ["消息"],
        },
      ],
      execute(input) {
        return { summary: `收到：${input.message}`, data: { message: input.message } };
      },
    });
    capabilities.push(fake);
    try {
      expect(
        getUiSpecs(getStore()).some((spec) => spec.capabilityId === "test.echo"),
      ).toBe(true);
      const schema = getJsonSchemas()["test.echo"];
      expect(schema.type).toBe("object");
      expect(schema.required).toContain("message");
      expect(schema.properties.message).toMatchObject({ type: "string" });
      const result = invoke({
        capabilityId: "test.echo",
        input: { message: "你好" },
        actor,
      });
      expect(result).toMatchObject({
        status: "executed",
        capabilityId: "test.echo",
        impact: 1,
        summary: "收到：你好",
        data: { message: "你好" },
      });
    } finally {
      const index = capabilities.findIndex((item) => item.id === "test.echo");
      if (index >= 0) capabilities.splice(index, 1);
    }
    expect(getCapability("test.echo")).toBeUndefined();
  });

  it("undo restores product.create, inquiry.create, and inquiry.publish", () => {
    const ctx = { store: getStore(), actor };
    const deadline = daysFromToday(15);

    const productCap = getCapability("product.create");
    if (!productCap?.undo) throw new Error("product.create 缺少 undo");
    const productsBefore = structuredClone(getStore().products);
    const productCounter = getStore().counters.product;
    const created = productCap.execute(
      {
        name: "撤销产品",
        category: "电子",
        unit: "台",
        referencePrice: 10,
      },
      ctx,
    );
    expect(getStore().products.some((item) => item.id === "P-007")).toBe(true);
    productCap.undo(created.undoData, ctx);
    expect(getStore().products).toEqual(productsBefore);
    expect(getStore().counters.product).toBe(productCounter + 1);

    const inquiryCap = getCapability("inquiry.create");
    if (!inquiryCap?.undo) throw new Error("inquiry.create 缺少 undo");
    const inquiriesBefore = structuredClone(getStore().inquiries);
    const inquiryCounter = getStore().counters.inquiry;
    const drafted = inquiryCap.execute(
      {
        productId: "P-001",
        quantity: 8,
        deadline,
        supplierIds: ["S-001"],
      },
      ctx,
    );
    expect(getStore().inquiries.some((item) => item.id === "Q-003")).toBe(true);
    inquiryCap.undo(drafted.undoData, ctx);
    expect(getStore().inquiries).toEqual(inquiriesBefore);
    expect(getStore().counters.inquiry).toBe(inquiryCounter + 1);

    const publishCap = getCapability("inquiry.publish");
    if (!publishCap?.undo) throw new Error("inquiry.publish 缺少 undo");
    const beforePublish = structuredClone(getStore());
    const published = publishCap.execute({ inquiryId: "Q-001" }, ctx);
    expect(getStore().inquiries.find((item) => item.id === "Q-001")?.status).toBe(
      "published",
    );
    publishCap.undo(published.undoData, ctx);
    expect(getStore()).toEqual(beforePublish);
  });

  it("resolves ref options from the current store", () => {
    const awardBefore = getUiSpecs(getStore()).find(
      (spec) => spec.capabilityId === "inquiry.award",
    );
    const awardInquiries = awardBefore?.fields.find(
      (field) => field.name === "inquiryId",
    );
    expect(awardInquiries?.options).toEqual([
      { value: "Q-002", label: "Q-002 · 贴片电阻 × 10000" },
    ]);

    const publishSpec = getUiSpecs(getStore()).find(
      (spec) => spec.capabilityId === "inquiry.publish",
    );
    expect(
      publishSpec?.fields.find((field) => field.name === "inquiryId")?.options,
    ).toEqual([{ value: "Q-001", label: "Q-001 · 不锈钢螺栓 × 2000" }]);

    invoke({
      capabilityId: "product.create",
      input: {
        name: "新增长螺栓",
        category: "五金",
        unit: "件",
        referencePrice: 2,
      },
      actor,
    });
    const createSpec = getUiSpecs(getStore()).find(
      (spec) => spec.capabilityId === "inquiry.create",
    );
    const productField = createSpec?.fields.find(
      (field) => field.name === "productId",
    );
    expect(productField?.options).toContainEqual({
      value: "P-007",
      label: "新增长螺栓",
    });
    expect(
      createSpec?.fields.find((field) => field.name === "supplierIds")?.options,
    ).toContainEqual({ value: "S-001", label: "沪上紧固件" });

    const schemas = getJsonSchemas();
    expect(schemas["product.create"].properties.category).toMatchObject({
      type: "string",
      enum: ["五金", "电子", "包材", "原料"],
    });
    expect(schemas["inquiry.create"].properties.productId).toMatchObject({
      type: "string",
    });
    expect(schemas["inquiry.create"].properties.supplierIds).toMatchObject({
      type: "array",
      minItems: 1,
    });
    expect(schemas["inquiry.create"].properties.quantity).toMatchObject({
      type: "integer",
      minimum: 1,
    });
    expect(String(schemas["inquiry.create"].properties.productId.description)).toContain(
      "P-001",
    );
  });
});
