import { describe, expect, it } from "vitest";
import type { InvokeResult, UiFieldSpec, UiSpec } from "@/lib/contract/types";
import {
  GUIDED_HINT,
  activeToken,
  capabilityTurn,
  compactFormOutput,
  continueAfterClientTool,
  filterCommands,
  filterMentions,
  freeTextTurn,
  mentionEntities,
  nextSteps,
  prefillFromReferences,
  shortcutContext,
  suggestionSpecs,
  type ChatReference,
  type ChatUIMessage,
} from "@/lib/client/guided";

function field(
  name: string,
  extra: Partial<UiFieldSpec> = {},
): UiFieldSpec {
  return {
    name,
    label: name,
    type: "string",
    required: true,
    ...extra,
  };
}

function spec(partial: Pick<UiSpec, "capabilityId" | "title" | "kind"> & Partial<UiSpec>): UiSpec {
  return {
    module: "product",
    moduleLabel: "产品",
    description: "",
    impact: 1,
    fields: [],
    submit: { tool: partial.capabilityId, label: "提交" },
    ...partial,
  };
}

const catalog: UiSpec[] = [
  spec({
    capabilityId: "product.search",
    title: "搜索产品",
    description: "按关键词搜索产品",
    kind: "read",
    impact: 0,
  }),
  spec({
    capabilityId: "product.create",
    title: "新建产品",
    description: "新建产品，记录名称",
    kind: "write",
    impact: 2,
    fields: [field("name")],
  }),
  spec({
    capabilityId: "inquiry.list",
    title: "询价单列表",
    description: "查看询价单",
    kind: "read",
    module: "inquiry",
    moduleLabel: "询价",
    impact: 0,
  }),
  spec({
    capabilityId: "inquiry.create",
    title: "创建询价",
    description: "为产品创建一张草稿询价单",
    kind: "write",
    module: "inquiry",
    moduleLabel: "询价",
    impact: 3,
    fields: [
      field("productId", { type: "ref", refKind: "product" }),
      field("supplierIds", { type: "multiref", refKind: "supplier" }),
    ],
  }),
  spec({
    capabilityId: "inquiry.publish",
    title: "发布询价",
    description: "把草稿询价单发布给供应商",
    kind: "write",
    module: "inquiry",
    moduleLabel: "询价",
    impact: 6,
    fields: [
      field("inquiryId", { type: "ref", refKind: "inquiry", refFilter: ["draft"] }),
    ],
  }),
  spec({
    capabilityId: "supplier.list",
    title: "供应商列表",
    description: "查看供应商",
    kind: "read",
    module: "procurement",
    moduleLabel: "采购",
    impact: 0,
  }),
];

function ids() {
  let n = 0;
  return () => `id-${++n}`;
}

describe("filterCommands", () => {
  it("returns every capability when the query is empty", () => {
    expect(filterCommands(catalog, "").map((item) => item.capabilityId)).toEqual(
      catalog.map((item) => item.capabilityId),
    );
    expect(filterCommands(catalog, "   ")).toHaveLength(catalog.length);
  });

  it("matches title, description, and id without dropping unrelated text", () => {
    expect(filterCommands(catalog, "新建").map((item) => item.capabilityId)).toEqual([
      "product.create",
    ]);
    expect(filterCommands(catalog, "一张").map((item) => item.capabilityId)).toEqual([
      "inquiry.create",
    ]);
    expect(filterCommands(catalog, "inquiry.pub").map((item) => item.capabilityId)).toEqual([
      "inquiry.publish",
    ]);
    expect(filterCommands(catalog, "不存在的事情")).toEqual([]);
  });
});

describe("activeToken", () => {
  it("opens a command only at the start or after whitespace", () => {
    expect(activeToken("/", 1)).toEqual({ kind: "command", query: "", start: 0 });
    expect(activeToken("/新建", 3)).toEqual({ kind: "command", query: "新建", start: 0 });
    expect(activeToken("你好 /pub", 7)).toMatchObject({ kind: "command", query: "pub" });
    expect(activeToken("你好/pub", 6)).toBeNull();
  });

  it("treats @ as a mention, not a command", () => {
    expect(activeToken("@螺栓", 3)).toMatchObject({ kind: "mention", query: "螺栓" });
    expect(activeToken("给 @不锈钢", 6)?.kind).toBe("mention");
  });
});

describe("guided turns", () => {
  it("selecting a capability produces a user message and a show_form tool part", () => {
    const chosen = catalog.find((item) => item.capabilityId === "product.create");
    if (!chosen) throw new Error("missing spec");
    const [user, assistant] = capabilityTurn({ spec: chosen, nextId: ids() });
    expect(user?.role).toBe("user");
    expect(user?.parts).toEqual([
      { type: "text", text: "新建产品", state: "done" },
    ]);
    expect(user?.metadata?.capabilityId).toBe("product.create");
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.parts[0]).toMatchObject({ type: "text" });
    expect(assistant?.parts[1]).toMatchObject({
      type: "tool-show_form",
      state: "input-available",
      input: { capabilityId: "product.create" },
    });
  });

  it("prefills a ref field from an @ reference by refKind", () => {
    const chosen = catalog.find((item) => item.capabilityId === "inquiry.create");
    if (!chosen) throw new Error("missing spec");
    const references: ChatReference[] = [
      { id: "P-009", kind: "product", label: "不锈钢螺栓", token: "@不锈钢螺栓" },
      { id: "S-001", kind: "supplier", label: "沪上紧固件" },
      { id: "S-002", kind: "supplier", label: "芯联电子" },
      { id: "P-001", kind: "product", label: "旧产品" },
    ];
    expect(prefillFromReferences(chosen, references)).toEqual({
      productId: "P-001",
      supplierIds: ["S-001", "S-002"],
    });
    const [, assistant] = capabilityTurn({
      spec: chosen,
      text: "给这个产品建询价",
      references: references.slice(0, 2),
      nextId: ids(),
    });
    expect(assistant?.parts[1]).toMatchObject({
      type: "tool-show_form",
      state: "input-available",
      input: {
        capabilityId: "inquiry.create",
        prefill: { productId: "P-009", supplierIds: ["S-001"] },
      },
    });
  });

  it("does not start a flow from free text, even when the text names a capability", () => {
    const [user, assistant] = freeTextTurn(
      "请帮我创建产品 /inquiry.create @不锈钢螺栓",
      ids(),
    );
    expect(user?.parts).toEqual([
      {
        type: "text",
        text: "请帮我创建产品 /inquiry.create @不锈钢螺栓",
        state: "done",
      },
    ]);
    expect(assistant?.metadata?.guidedHint).toBe(true);
    expect(assistant?.parts).toEqual([
      { type: "text", text: GUIDED_HINT, state: "done" },
    ]);
    expect(JSON.stringify(assistant?.parts)).not.toContain("show_form");
    expect(JSON.stringify(assistant?.parts)).not.toContain("tool-");
  });
});

describe("model-mode helpers", () => {
  it("puts the shortcut choice into the user text for the model", () => {
    expect(
      shortcutContext({
        title: "发布询价",
        references: [{ id: "Q-001", kind: "inquiry", label: "询价 Q-001" }],
        prefill: { inquiryId: "Q-001" },
      }),
    ).toBe("用户通过快捷入口选择了能力：发布询价，引用：询价 Q-001(Q-001)\n预填：{\"inquiryId\":\"Q-001\"}");
  });

  it("keeps a compact form result the model can read", () => {
    expect(
      compactFormOutput(
        {
          status: "executed",
          capabilityId: "product.create",
          impact: 2,
          effectiveImpact: 2,
          summary: "已创建",
          data: { id: "P-009" },
        },
        { name: "垫片" },
      ),
    ).toMatchObject({
      status: "executed",
      summary: "已创建",
      ids: ["P-009"],
      submitted: { name: "垫片" },
    });
  });

  it("continues the model only after the client form tool finishes", () => {
    const pending: ChatUIMessage = {
      id: "a",
      role: "assistant",
      parts: [
        {
          type: "tool-show_form",
          toolCallId: "call-1",
          state: "input-available",
          input: { capabilityId: "product.create" },
        },
      ],
    };
    expect(continueAfterClientTool({ messages: [pending] })).toBe(false);
    const done: ChatUIMessage = {
      ...pending,
      parts: [
        {
          type: "tool-show_form",
          toolCallId: "call-1",
          state: "output-available",
          input: { capabilityId: "product.create" },
          output: { status: "executed", capabilityId: "product.create", summary: "已创建" },
        },
      ],
    };
    expect(continueAfterClientTool({ messages: [done] })).toBe(true);
    const serverTool: ChatUIMessage = {
      id: "b",
      role: "assistant",
      parts: [
        {
          type: "tool-inquiry_publish",
          toolCallId: "call-2",
          state: "output-available",
          input: { inquiryId: "Q-001" },
          output: { status: "pending_approval", capabilityId: "inquiry.publish", summary: "待审核" },
        },
      ],
    };
    expect(continueAfterClientTool({ messages: [serverTool] })).toBe(false);
    const mcpForm: ChatUIMessage = {
      id: "c",
      role: "assistant",
      parts: [
        {
          type: "tool-show_form",
          toolCallId: "call-3",
          state: "output-available",
          input: {},
          output: {
            structuredContent: {
              kind: "form",
              uiSpec: { capabilityId: "inquiry.create", title: "创建询价", fields: [], submit: { tool: "inquiry.create", label: "提交" } },
              prefill: { quantity: 1 },
            },
          },
        },
      ],
    };
    expect(continueAfterClientTool({ messages: [mcpForm] })).toBe(false);
  });
});

describe("suggestions and next steps", () => {
  it("offers every write plus a couple of reads", () => {
    expect(suggestionSpecs(catalog).map((item) => item.capabilityId)).toEqual([
      "product.create",
      "inquiry.create",
      "inquiry.publish",
      "product.search",
      "inquiry.list",
    ]);
  });

  it("offers writes whose ref filter includes the new entity status", () => {
    const result: InvokeResult = {
      status: "executed",
      capabilityId: "inquiry.create",
      impact: 3,
      effectiveImpact: 3,
      summary: "已创建询价草稿 Q-009",
      data: { id: "Q-009", status: "draft" },
    };
    expect(nextSteps(catalog, result)).toEqual([
      {
        spec: catalog.find((item) => item.capabilityId === "inquiry.publish"),
        prefill: { inquiryId: "Q-009" },
      },
    ]);
    expect(
      nextSteps(catalog, { ...result, status: "pending_approval" }),
    ).toEqual([]);
  });
});

describe("filterMentions", () => {
  it("filters entities by label, detail, or id", () => {
    const entities = mentionEntities({
      products: [{ id: "P-001", name: "不锈钢螺栓" }],
      suppliers: [{ id: "S-001", name: "沪上紧固件" }],
      inquiries: [{ id: "Q-001", productId: "P-001" }],
    });
    expect(filterMentions(entities, "螺栓").map((item) => item.id)).toEqual([
      "P-001",
      "Q-001",
    ]);
    expect(filterMentions(entities, "S-001").map((item) => item.kind)).toEqual([
      "supplier",
    ]);
  });
});
