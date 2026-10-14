/**
 * 只用 MCP 走完「建产品 → 询价草稿 → 发布 → 中标」。
 *
 * 只有两处不是 MCP，因为它们不是外部 Agent 能做的事：
 * 1. POST /api/reset：把内存数据恢复成种子，让脚本可以重复跑。
 * 2. POST /api/approvals/:id：批准必须由人来做。MCP 不提供批准工具。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:4817";

interface ToolPayload {
  status?: string;
  capabilityId?: string;
  summary?: string;
  nextStep?: string;
  approvalId?: string | null;
  errors?: { message?: string }[];
  data?: Record<string, unknown> | null;
  records?: Record<string, unknown>[] | null;
  fields?: { name?: string; options?: { value?: string }[] }[];
  capabilities?: { id?: string; requiresApprovalForAgents?: boolean }[];
}

interface ToolResult {
  isError?: boolean;
  content?: { text?: string }[];
  structuredContent?: ToolPayload;
}

class StepFailure extends Error {}

let failed = false;
let client: Client | undefined;

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function step(name: string, run: () => Promise<string>): Promise<void> {
  try {
    const detail = await run();
    console.log(`PASS ${name} — ${detail}`);
  } catch (error) {
    if (error instanceof StepFailure) throw error;
    failed = true;
    console.log(`FAIL ${name} — ${detailOf(error)}`);
    throw new StepFailure(name);
  }
}

function deadline(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function call(
  connected: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await connected.callTool({ name, arguments: args })) as ToolResult;
}

function payload(result: ToolResult): ToolPayload {
  return result.structuredContent ?? {};
}

function textOf(result: ToolResult): string {
  return (result.content ?? []).map((item) => item.text ?? "").join("\n");
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`缺少${label}`);
  }
  return value;
}

async function resetStore(): Promise<void> {
  const response = await fetch(`${baseUrl}/api/reset`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`reset 返回 ${response.status}`);
  }
}

async function approve(approvalId: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/approvals/${approvalId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`人工批准失败 ${response.status} ${body}`);
  }
}

async function inquiryStatus(
  connected: Client,
  inquiryId: string,
): Promise<string> {
  const listed = await call(connected, "inquiry_list", { keyword: inquiryId });
  if (listed.isError || payload(listed).status !== "executed") {
    throw new Error(`查询询价单失败：${textOf(listed)}`);
  }
  const row = (payload(listed).records ?? []).find(
    (item) => item.id === inquiryId,
  );
  return requireString(row?.status, "询价单状态");
}

async function main(): Promise<void> {
  console.log(
    "非 MCP 调用只有两处：开始时 POST /api/reset（恢复种子，便于重复运行），以及 POST /api/approvals/:id（只有人能批准，MCP 不暴露批准）。",
  );
  await step("reset", async () => {
    await resetStore();
    return "已恢复种子数据";
  });

  client = new Client({ name: "mcp-flow", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/api/mcp`),
  );
  await client.connect(transport);
  const connected = client;

  await step("list tools", async () => {
    const listed = await connected.listTools();
    const names = listed.tools.map((tool) => tool.name);
    const expected = [
      "product_search",
      "product_create",
      "inquiry_list",
      "inquiry_create",
      "inquiry_publish",
      "inquiry_award",
      "supplier_list",
      "list_capabilities",
      "get_ui_spec",
      "get_approval_status",
    ];
    for (const name of expected) {
      if (!names.includes(name)) throw new Error(`缺少工具 ${name}`);
    }
    if (names.some((name) => /approve|reject/.test(name))) {
      throw new Error(`不应暴露批准或驳回工具：${names.join(", ")}`);
    }
    return `${names.length} 个工具`;
  });

  await step("list resources", async () => {
    const listed = await connected.listResources();
    const uris = listed.resources.map((resource) => resource.uri);
    for (const uri of ["uispec://index", "uispec://inquiry.create"]) {
      if (!uris.includes(uri)) throw new Error(`缺少资源 ${uri}`);
    }
    return `${uris.length} 个资源`;
  });

  await step("get_ui_spec inquiry.create", async () => {
    const result = await call(connected, "get_ui_spec", {
      capabilityId: "inquiry.create",
    });
    if (result.isError) throw new Error(textOf(result));
    const spec = payload(result);
    if (spec.capabilityId !== "inquiry.create") {
      throw new Error(`capabilityId 是 ${spec.capabilityId ?? "空"}`);
    }
    const options =
      spec.fields?.find((field) => field.name === "productId")?.options ?? [];
    if (!options.some((option) => option.value === "P-001")) {
      throw new Error("产品选项里没有 P-001");
    }
    return `${options.length} 个产品选项`;
  });

  let productId = "";
  await step("product_create", async () => {
    const result = await call(connected, "product_create", {
      name: "MCP验收零件",
      category: "五金",
      unit: "件",
      referencePrice: 10,
    });
    if (result.isError || payload(result).status !== "executed") {
      throw new Error(textOf(result));
    }
    productId = requireString(payload(result).data?.id, "产品编号");
    return productId;
  });

  let inquiryId = "";
  await step("inquiry_create draft", async () => {
    const result = await call(connected, "inquiry_create", {
      productId,
      quantity: 12,
      deadline: deadline(21),
      supplierIds: ["S-001"],
    });
    if (result.isError || payload(result).status !== "executed") {
      throw new Error(textOf(result));
    }
    inquiryId = requireString(payload(result).data?.id, "询价单编号");
    const status = await inquiryStatus(connected, inquiryId);
    if (status !== "draft") throw new Error(`状态是 ${status}`);
    return `${inquiryId} 草稿`;
  });

  let publishApprovalId = "";
  await step("inquiry_publish ignores client actor", async () => {
    const spoofed = await call(connected, "inquiry_publish", {
      inquiryId,
      actor: { kind: "human", surface: "workbench" },
    });
    if (payload(spoofed).status === "executed") {
      throw new Error("客户端传入的 human actor 绕过了审核闸门");
    }
    let gated = spoofed;
    let how = "客户端 actor 被忽略，仍然待审核";
    if (payload(spoofed).status !== "pending_approval") {
      if (!spoofed.isError) {
        throw new Error(`意外结果：${textOf(spoofed)}`);
      }
      gated = await call(connected, "inquiry_publish", { inquiryId });
      how = "客户端 actor 被模式拒绝，去掉后进入待审核";
      if (payload(gated).status !== "pending_approval") {
        throw new Error(`去掉 actor 后仍未待审核：${textOf(gated)}`);
      }
    }
    if (gated.isError) throw new Error("pending_approval 不应是错误");
    publishApprovalId = requireString(payload(gated).approvalId, "审批号");
    const waiting = await call(connected, "get_approval_status", {
      approvalId: publishApprovalId,
    });
    if (payload(waiting).status !== "pending") {
      throw new Error(`审批状态是 ${payload(waiting).status ?? "空"}`);
    }
    return `${how}（${publishApprovalId}）`;
  });

  await step("human approve publish", async () => {
    await approve(publishApprovalId);
    return `已批准 ${publishApprovalId}（人工 HTTP，不是 MCP 工具）`;
  });

  await step("inquiry_list published", async () => {
    const status = await inquiryStatus(connected, inquiryId);
    if (status !== "published") throw new Error(`状态是 ${status}`);
    return `${inquiryId} 已发布`;
  });

  await step("inquiry_award overpriced", async () => {
    const result = await call(connected, "inquiry_award", {
      inquiryId,
      supplierId: "S-001",
      price: 14,
    });
    if (!result.isError) throw new Error("过高中标价应返回 isError");
    if (payload(result).status !== "rejected") {
      throw new Error(`状态是 ${payload(result).status ?? "空"}`);
    }
    const text = textOf(result);
    if (!/30%/.test(text) || !/请把 price/.test(text)) {
      throw new Error(`缺少修正提示：${text}`);
    }
    if (!/请根据 errors 修正参数后重试/.test(payload(result).nextStep ?? "")) {
      throw new Error("nextStep 没有修正提示");
    }
    const status = await inquiryStatus(connected, inquiryId);
    if (status !== "published") throw new Error(`数据被改成 ${status}`);
    return "已拦截，询价单仍是已发布";
  });

  let awardApprovalId = "";
  await step("inquiry_award valid price", async () => {
    const result = await call(connected, "inquiry_award", {
      inquiryId,
      supplierId: "S-001",
      price: 10,
    });
    if (result.isError || payload(result).status !== "pending_approval") {
      throw new Error(textOf(result));
    }
    awardApprovalId = requireString(payload(result).approvalId, "审批号");
    const waiting = await call(connected, "get_approval_status", {
      approvalId: awardApprovalId,
    });
    if (payload(waiting).status !== "pending") {
      throw new Error(`审批状态是 ${payload(waiting).status ?? "空"}`);
    }
    return `待审核 ${awardApprovalId}`;
  });

  await step("human approve award", async () => {
    await approve(awardApprovalId);
    return `已批准 ${awardApprovalId}（人工 HTTP，不是 MCP 工具）`;
  });

  await step("inquiry_list awarded", async () => {
    const status = await inquiryStatus(connected, inquiryId);
    if (status !== "awarded") throw new Error(`状态是 ${status}`);
    return `${inquiryId} 已中标`;
  });
}

main()
  .catch((error) => {
    if (!(error instanceof StepFailure)) {
      failed = true;
      console.log(`FAIL 脚本异常 — ${detailOf(error)}`);
    }
  })
  .finally(async () => {
    await client?.close();
    if (failed) process.exit(1);
  });
