import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it } from "vitest";
import { DELETE, GET, POST } from "@/app/api/mcp/route";
import { toJsonSchema } from "@/lib/contract/derive";
import { capabilities, getCapability } from "@/lib/contract/registry";
import { defineCapability } from "@/lib/contract/types";
import type { Actor } from "@/lib/contract/types";
import { daysFromToday } from "@/lib/dates";
import { toolNameForCapability, uiSpecUri } from "@/lib/mcp/names";
import { createMcpServer } from "@/lib/mcp/server";
import { getStore, reset } from "@/lib/server/db";
import { findApproval, setPolicy } from "@/lib/server/governance";
import { decideApproval, invoke } from "@/lib/server/invoke";

const human: Actor = { kind: "human", surface: "workbench" };

interface Payload {
  status?: string;
  capabilityId?: string;
  summary?: string;
  nextStep?: string;
  approvalId?: string | null;
  errors?: { message?: string; field?: string }[];
  data?: { id?: string; total?: number } | null;
  records?: { id?: string; status?: string }[] | null;
  capabilities?: {
    id?: string;
    toolName?: string;
    alwaysReview?: boolean;
    requiresApprovalForAgents?: boolean;
    kind?: string;
  }[];
  fields?: { name?: string; options?: { value?: string }[] }[];
  title?: string;
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Payload;
}

interface JsonObjectSchema {
  properties?: Record<string, unknown>;
  required?: string[];
}

function textOf(result: ToolResult): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

async function withClient(run: (client: Client) => Promise<void>) {
  const server = createMcpServer();
  const client = new Client({ name: "mcp-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function seedDraft(name: string) {
  const product = invoke({
    capabilityId: "product.create",
    input: {
      name,
      category: "五金",
      unit: "件",
      referencePrice: 10,
    },
    actor: human,
  });
  const productId = (product.data as { id: string }).id;
  const inquiry = invoke({
    capabilityId: "inquiry.create",
    input: {
      productId,
      quantity: 8,
      deadline: daysFromToday(20),
      supplierIds: ["S-001"],
    },
    actor: human,
  });
  return {
    productId,
    inquiryId: (inquiry.data as { id: string }).id,
  };
}

beforeEach(() => {
  reset();
});

describe("mcp tools derived from the registry", () => {
  it("lists one tool per capability plus the helper tools", async () => {
    await withClient(async (client) => {
      expect(client.getServerVersion()?.name).toBe("agent-native-prototype");
      expect(client.getInstructions()).toContain("list_capabilities");
      expect(client.getInstructions()).toContain("get_ui_spec");
      expect(client.getInstructions()).toContain("pending_approval");

      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      const expected = [
        ...capabilities.map((capability) => toolNameForCapability(capability.id)),
        "list_capabilities",
        "get_ui_spec",
        "get_approval_status",
        "show_form",
      ];
      expect(names).toHaveLength(expected.length);
      expect(new Set(names)).toEqual(new Set(expected));
      expect(toolNameForCapability("inquiry.create")).toBe("inquiry_create");
      expect(names.some((name) => /approve|reject/.test(name))).toBe(false);

      for (const capability of capabilities) {
        const tool = listed.tools.find(
          (item) => item.name === toolNameForCapability(capability.id),
        );
        expect(tool?.annotations?.readOnlyHint).toBe(capability.kind === "read");
        expect(tool?.annotations?.destructiveHint).toBe(
          capability.kind === "write" && capability.impact >= 8,
        );
        const contract = toJsonSchema(capability);
        const input = tool?.inputSchema as JsonObjectSchema;
        expect(Object.keys(input.properties ?? {}).sort()).toEqual(
          Object.keys(contract.properties).sort(),
        );
        expect([...(input.required ?? [])].sort()).toEqual(
          [...contract.required].sort(),
        );
      }

      const award = listed.tools.find((tool) => tool.name === "inquiry_award");
      expect(award?.description).toContain("确认中标");
      expect(award?.description).toContain("影响权重 9");
      expect(award?.description).toContain("默认需要人工审核");
      const create = listed.tools.find((tool) => tool.name === "product_create");
      expect(create?.description).toContain("影响权重 2");
      expect(create?.description).not.toContain("默认需要人工审核");
      expect(
        listed.tools.find((tool) => tool.name === "product_search")?.annotations
          ?.readOnlyHint,
      ).toBe(true);

      const catalog = await call(client, "list_capabilities");
      const items = catalog.structuredContent?.capabilities ?? [];
      expect(items).toHaveLength(capabilities.length);
      expect(items.find((item) => item.id === "inquiry.award")).toMatchObject({
        toolName: "inquiry_award",
        alwaysReview: true,
        requiresApprovalForAgents: true,
      });
      expect(items.find((item) => item.id === "inquiry.publish")).toMatchObject({
        toolName: "inquiry_publish",
        alwaysReview: false,
        requiresApprovalForAgents: true,
      });
      expect(items.find((item) => item.id === "product.create")).toMatchObject({
        alwaysReview: false,
        requiresApprovalForAgents: false,
      });
    });
  });

  it("reports the effective review policy from the current store", async () => {
    setPolicy({ threshold: 10, alwaysReview: ["product.create"] });
    await withClient(async (client) => {
      const catalog = await call(client, "list_capabilities");
      const items = catalog.structuredContent?.capabilities ?? [];
      expect(items.find((item) => item.id === "product.create")).toMatchObject({
        alwaysReview: true,
        requiresApprovalForAgents: true,
      });
      expect(items.find((item) => item.id === "inquiry.publish")).toMatchObject({
        alwaysReview: false,
        requiresApprovalForAgents: false,
      });
      expect(items.find((item) => item.id === "inquiry.award")).toMatchObject({
        alwaysReview: false,
        requiresApprovalForAgents: false,
      });
    });
  });
});

describe("mcp tool execution", () => {
  it("ignores a client-supplied actor and still gates publish", async () => {
    const { inquiryId } = seedDraft("MCP闸门零件");
    await withClient(async (client) => {
      const gated = await call(client, "inquiry_publish", {
        inquiryId,
        actor: { kind: "human", surface: "workbench" },
      });
      expect(getStore().inquiries.find((item) => item.id === inquiryId)?.status).toBe(
        "draft",
      );
      expect(gated.structuredContent?.status).not.toBe("executed");
      if (gated.isError) {
        expect(textOf(gated).length).toBeGreaterThan(0);
        return;
      }
      expect(gated.structuredContent?.status).toBe("pending_approval");
      expect(gated.isError).toBeFalsy();
      const approval = findApproval(String(gated.structuredContent?.approvalId));
      expect(approval?.actor).toEqual({ kind: "agent", surface: "mcp" });
    });
  });

  it("returns isError for a rejected award and pending_approval for a valid one", async () => {
    const { inquiryId } = seedDraft("MCP中标零件");
    const published = invoke({
      capabilityId: "inquiry.publish",
      input: { inquiryId },
      actor: human,
    });
    expect(published.status).toBe("executed");

    await withClient(async (client) => {
      const blocked = await call(client, "inquiry_award", {
        inquiryId,
        supplierId: "S-001",
        price: 14,
      });
      expect(blocked.isError).toBe(true);
      expect(blocked.structuredContent?.status).toBe("rejected");
      expect(textOf(blocked)).toMatch(/30%/);
      expect(textOf(blocked)).toMatch(/请把 price/);
      expect(blocked.structuredContent?.nextStep).toMatch(
        /请根据 errors 修正参数后重试/,
      );
      expect(
        getStore().inquiries.find((item) => item.id === inquiryId)?.status,
      ).toBe("published");

      const pending = await call(client, "inquiry_award", {
        inquiryId,
        supplierId: "S-001",
        price: 10,
      });
      expect(pending.isError).toBeFalsy();
      expect(pending.structuredContent?.status).toBe("pending_approval");
      expect(pending.structuredContent?.nextStep).toContain("已提交人工审核");
      expect(pending.structuredContent?.nextStep).toContain("get_approval_status");
      const approvalId = String(pending.structuredContent?.approvalId);
      expect(findApproval(approvalId)?.actor).toEqual({
        kind: "agent",
        surface: "mcp",
      });
      expect(
        getStore().inquiries.find((item) => item.id === inquiryId)?.status,
      ).toBe("published");

      const waiting = await call(client, "get_approval_status", { approvalId });
      expect(waiting.isError).toBeFalsy();
      expect(waiting.structuredContent?.status).toBe("pending");

      const decided = decideApproval(approvalId, "approve");
      expect(decided.ok).toBe(true);
      const after = await call(client, "get_approval_status", { approvalId });
      expect(after.structuredContent?.status).toBe("approved");
      expect(textOf(after)).toMatch(/已通过/);
      expect(
        getStore().inquiries.find((item) => item.id === inquiryId)?.status,
      ).toBe("awarded");
    });
  });

  it("lists valid capability ids when get_ui_spec is unknown", async () => {
    await withClient(async (client) => {
      const missing = await call(client, "get_ui_spec", {
        capabilityId: "no.such",
      });
      expect(missing.isError).toBe(true);
      const text = textOf(missing);
      for (const capability of capabilities) {
        expect(text).toContain(capability.id);
      }
      const unknownApproval = await call(client, "get_approval_status", {
        approvalId: "A-999",
      });
      expect(unknownApproval.isError).toBe(true);
      expect(textOf(unknownApproval)).toContain("A-999");
    });
  });
});

describe("mcp resources and ui spec", () => {
  it("lists and reads ui specs, including options from the store", async () => {
    await withClient(async (client) => {
      const listed = await client.listResources();
      const uris = listed.resources.map((resource) => resource.uri);
      expect(uris).toContain("uispec://index");
      for (const capability of capabilities) {
        expect(uris).toContain(uiSpecUri(capability.id));
      }

      const before = await call(client, "get_ui_spec", {
        capabilityId: "inquiry.create",
      });
      expect(before.isError).toBeFalsy();
      expect(before.structuredContent?.capabilityId).toBe("inquiry.create");
      const beforeOptions =
        before.structuredContent?.fields?.find((field) => field.name === "productId")
          ?.options ?? [];
      expect(beforeOptions.some((option) => option.value === "P-001")).toBe(true);

      const created = await call(client, "product_create", {
        name: "界面新产品",
        category: "电子",
        unit: "个",
        referencePrice: 3,
      });
      expect(created.structuredContent?.status).toBe("executed");
      const productId = created.structuredContent?.data?.id ?? "";
      expect(productId).toMatch(/^P-/);

      const after = await call(client, "get_ui_spec", {
        capabilityId: "inquiry.create",
      });
      const afterOptions =
        after.structuredContent?.fields?.find((field) => field.name === "productId")
          ?.options ?? [];
      expect(afterOptions.some((option) => option.value === productId)).toBe(true);

      const read = await client.readResource({
        uri: uiSpecUri("inquiry.create"),
      });
      const content = read.contents[0];
      expect("text" in content).toBe(true);
      if (!("text" in content)) return;
      const spec = JSON.parse(content.text) as Payload;
      expect(spec.capabilityId).toBe("inquiry.create");
      expect(content.mimeType).toBe("application/json");
      expect(
        spec.fields
          ?.find((field) => field.name === "productId")
          ?.options?.some((option) => option.value === productId),
      ).toBe(true);

      const index = await client.readResource({ uri: "uispec://index" });
      const indexContent = index.contents[0];
      expect("text" in indexContent).toBe(true);
      if (!("text" in indexContent)) return;
      const body = JSON.parse(indexContent.text) as {
        resources: { uri: string; capabilityId: string }[];
      };
      expect(body.resources.map((item) => item.uri)).toEqual(
        capabilities.map((capability) => uiSpecUri(capability.id)),
      );
    });
  });
});

describe("mcp single registration point", () => {
  it("exposes a newly registered capability without other code changes", async () => {
    const fake = defineCapability<{ keyword?: string }>({
      id: "test.echo",
      module: "product",
      moduleLabel: "产品",
      title: "回声",
      description: "把关键词原样返回，用来证明工具从契约派生。",
      kind: "read",
      impact: 0,
      fields: [
        {
          name: "keyword",
          label: "关键词",
          type: "string",
          required: false,
        },
      ],
      execute(input) {
        return { summary: `回声 ${input.keyword ?? "空"}` };
      },
    });
    capabilities.push(fake);
    try {
      await withClient(async (client) => {
        const listed = await client.listTools();
        expect(listed.tools.some((tool) => tool.name === "test_echo")).toBe(true);
        const catalog = await call(client, "list_capabilities");
        expect(
          catalog.structuredContent?.capabilities?.some(
            (item) => item.id === "test.echo" && item.toolName === "test_echo",
          ),
        ).toBe(true);
        const echoed = await call(client, "test_echo", { keyword: "单点" });
        expect(echoed.isError).toBeFalsy();
        expect(echoed.structuredContent?.status).toBe("executed");
        expect(echoed.structuredContent?.summary).toBe("回声 单点");
        const resources = await client.listResources();
        expect(resources.resources.some((item) => item.uri === "uispec://test.echo")).toBe(
          true,
        );
      });
    } finally {
      const index = capabilities.findIndex((item) => item.id === "test.echo");
      if (index >= 0) capabilities.splice(index, 1);
    }
    expect(getCapability("test.echo")).toBeUndefined();
  });
});

describe("mcp http route", () => {
  it("answers initialize and tools/list as stateless JSON", async () => {
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
    };
    const initialize = await POST(
      new Request("http://127.0.0.1:4817/api/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "http-test", version: "0.0.0" },
          },
        }),
      }),
    );
    expect(initialize.status).toBe(200);
    expect(initialize.headers.get("content-type")).toContain("application/json");
    const initialized = (await initialize.json()) as {
      result?: {
        serverInfo?: { name?: string };
        instructions?: string;
      };
    };
    expect(initialized.result?.serverInfo?.name).toBe("agent-native-prototype");
    expect(initialized.result?.instructions).toContain("list_capabilities");

    const tools = await POST(
      new Request("http://127.0.0.1:4817/api/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      }),
    );
    expect(tools.status).toBe(200);
    expect(tools.headers.get("content-type")).toContain("application/json");
    const body = (await tools.json()) as {
      result?: { tools?: { name: string }[] };
    };
    const names = body.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain("inquiry_create");
    expect(names).toContain("list_capabilities");
    expect(names).toHaveLength(capabilities.length + 4);

    const get = await GET(
      new Request("http://127.0.0.1:4817/api/mcp", {
        method: "GET",
        headers: { accept: "text/event-stream" },
      }),
    );
    expect(get.status).toBe(405);
    const removed = await DELETE(
      new Request("http://127.0.0.1:4817/api/mcp", { method: "DELETE" }),
    );
    expect(removed.status).toBe(405);
  });
});
