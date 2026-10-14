/**
 * 一条命令证明 PLAN 的验证目标。
 * 对话步骤用模拟模型指令 [[call:<tool_name>:<json>]]，见 scripts/mock-llm.ts。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import puppeteer, { type Frame, type Page } from "puppeteer-core";
import { parseChatFailure } from "@/lib/client/chat-error";
import { resolveModelSelection } from "@/lib/client/model-selection";
import { daysFromToday } from "@/lib/dates";
import { GUIDED_MODEL_ID } from "@/lib/providers/public";
import { startMockLlm, type MockLlmCall, type MockLlmHandle } from "./mock-llm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:4817";
const chromePath = process.env.CHROME_PATH ?? "/usr/local/bin/google-chrome";
const screenshotPath = "/opt/cursor/artifacts/screenshots/widget-polished.png";
const API_KEY = "sk-verify-SHOULD-NOT-LEAK-91zz";
const HEADER_SECRET = "hdr-SHOULD-NOT-LEAK-vendor";
const HEADER_NAME = "x-vendor-token";
const HUMAN = { kind: "human", surface: "workbench" };
const AGENT = { kind: "agent", surface: "llm" };

interface Product {
  id: string;
  name: string;
  category: string;
  unit: string;
  referencePrice: number;
}

interface Inquiry {
  id: string;
  productId: string;
  quantity: number;
  deadline: string;
  supplierIds: string[];
  status: string;
  createdAt?: string;
  award?: { supplierId: string; price: number };
  note?: string;
}

interface AuditRow {
  capabilityId: string;
  outcome: string;
  actor?: { kind?: string; surface?: string };
  input?: unknown;
  effectiveImpact?: number;
  issues?: unknown;
  summary?: string;
}

interface InvokeBody {
  status: number;
  json: unknown;
  text: string;
}

interface ToolPayload {
  status?: string;
  approvalId?: string | null;
  summary?: string;
  data?: { id?: string } | null;
  errors?: { message?: string }[];
}

interface CheckResult {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  evidence: string;
}

class SkipCheck extends Error {}

const captured: string[] = [];
const createdProviders: string[] = [];
let serverLog = "";
let devProcess: ChildProcess | undefined;
let mock: MockLlmHandle | undefined;
let dataDir: string | undefined;
let shuttingDown = false;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clip(text: string, max = 240): string {
  const redacted = text.split(API_KEY).join("[redacted]").split(HEADER_SECRET).join("[redacted]");
  const one = redacted.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

function noteBody(text: string) {
  captured.push(text);
  if (text.includes(API_KEY) || text.includes(HEADER_SECRET)) {
    throw new Error("响应正文里出现了密钥");
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function same(actual: unknown, expected: unknown, label: string) {
  try {
    assert.deepEqual(actual, expected);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}不一致：${clip(message, 500)}`);
  }
}

async function request(pathname: string, init?: RequestInit): Promise<{ status: number; text: string; json: unknown }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  noteBody(text);
  let json: unknown = text;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = text;
  }
  return { status: response.status, text, json };
}

async function resetStore() {
  const response = await request("/api/reset", { method: "POST" });
  if (response.status !== 200) throw new Error(`reset 返回 ${response.status}`);
}

async function putPolicy(policy: { threshold: number; alwaysReview: string[] }) {
  const response = await request("/api/policy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(policy),
  });
  if (response.status !== 200) throw new Error(`策略保存失败 ${response.status} ${clip(response.text)}`);
}

async function getState(): Promise<{ products: Product[]; inquiries: Inquiry[] }> {
  const response = await request("/api/state");
  if (response.status !== 200) throw new Error(`state 返回 ${response.status}`);
  const record = asRecord(response.json);
  if (!record || !Array.isArray(record.products) || !Array.isArray(record.inquiries)) {
    throw new Error("GET /api/state 格式不对");
  }
  return { products: record.products as Product[], inquiries: record.inquiries as Inquiry[] };
}

async function stateText(): Promise<string> {
  const response = await request("/api/state");
  if (response.status !== 200) throw new Error(`state 返回 ${response.status}`);
  return response.text;
}

function businessOf(state: { products: Product[]; inquiries: Inquiry[] }) {
  return {
    products: state.products,
    inquiries: state.inquiries.map((inquiry) => {
      const copy: Inquiry = { ...inquiry };
      delete copy.createdAt;
      return copy;
    }),
  };
}

async function getAudit(): Promise<AuditRow[]> {
  const response = await request("/api/audit");
  if (response.status !== 200) throw new Error(`audit 返回 ${response.status}`);
  const entries = asRecord(response.json)?.entries;
  if (!Array.isArray(entries)) throw new Error("审计响应缺少 entries");
  return (entries as AuditRow[]).slice().reverse();
}

async function approve(id: string, httpLog?: string[]) {
  httpLog?.push(`POST /api/approvals/${id}`);
  const response = await request(`/api/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });
  if (response.status !== 200) throw new Error(`批准 ${id} 失败 ${response.status} ${clip(response.text)}`);
}

async function invokeHttp(body: unknown): Promise<InvokeBody> {
  const response = await request("/api/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response;
}

function dataId(payload: unknown): string {
  const data = asRecord(asRecord(payload)?.data);
  const id = data?.id;
  if (typeof id !== "string" || !id) throw new Error(`结果里没有编号：${clip(JSON.stringify(payload))}`);
  return id;
}

function expectInvoke(result: InvokeBody, status: "executed" | "pending_approval" | "rejected", step: string) {
  const record = asRecord(result.json);
  if (record?.status !== status) {
    throw new Error(`${step}：期望 ${status}，实际 ${String(record?.status)} ${clip(result.text)}`);
  }
  if (status === "executed" && result.status !== 200) {
    throw new Error(`${step}：HTTP ${result.status}`);
  }
  if (status === "pending_approval" && result.status !== 202) {
    throw new Error(`${step}：HTTP ${result.status}`);
  }
  if (status === "rejected" && result.status !== 422) {
    throw new Error(`${step}：HTTP ${result.status}`);
  }
}

async function createProvider(input: Record<string, unknown>): Promise<string> {
  const response = await request("/api/providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.status !== 201) throw new Error(`创建模型失败 ${response.status} ${clip(response.text)}`);
  const id = asRecord(asRecord(response.json)?.provider)?.id;
  if (typeof id !== "string" || !id) throw new Error("创建模型没有返回 id");
  createdProviders.push(id);
  return id;
}

async function deleteProvider(id: string) {
  const response = await request(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
  const index = createdProviders.indexOf(id);
  if (index >= 0) createdProviders.splice(index, 1);
  if (response.status !== 200 && response.status !== 404) {
    throw new Error(`删除模型失败 ${response.status} ${clip(response.text)}`);
  }
}

function parseSse(raw: string): Record<string, unknown>[] {
  const chunks: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed: unknown = JSON.parse(payload);
      const record = asRecord(parsed);
      if (record) chunks.push(record);
    } catch {
      // 非 JSON 行仍留在原始正文里供提示词检查。
    }
  }
  return chunks;
}

function toolOutput(raw: string): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  for (const chunk of parseSse(raw)) {
    if (chunk.type === "tool-output-available" && asRecord(chunk.output)) {
      found = asRecord(chunk.output);
    }
  }
  return found;
}

async function chatTurn(providerId: string, text: string): Promise<{ status: number; text: string; output: Record<string, unknown> | null }> {
  const response = await request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      providerId,
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text }] }],
    }),
  });
  return { status: response.status, text: response.text, output: toolOutput(response.text) };
}

async function chatTool(providerId: string, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const turn = await chatTurn(providerId, `[[call:${tool}:${JSON.stringify(args)}]]`);
  if (turn.status !== 200) throw new Error(`对话失败 ${turn.status} ${clip(turn.text)}`);
  if (!turn.output) throw new Error(`没有工具结果：${clip(turn.text)}`);
  return turn.output;
}

const TASK_PRODUCT = { name: "验收螺栓", category: "五金", unit: "件", referencePrice: 2.5 };

function taskInquiry(productId: string, deadline: string) {
  return {
    productId,
    quantity: 1000,
    deadline,
    supplierIds: ["S-001", "S-002"],
  };
}

function assertTask(state: ReturnType<typeof businessOf>, deadline: string) {
  const product = state.products.find((item) => item.name === TASK_PRODUCT.name);
  if (!product) throw new Error("没有创建「验收螺栓」");
  if (
    product.category !== TASK_PRODUCT.category ||
    product.unit !== TASK_PRODUCT.unit ||
    product.referencePrice !== TASK_PRODUCT.referencePrice
  ) {
    throw new Error(`产品字段不对：${JSON.stringify(product)}`);
  }
  const inquiry = state.inquiries.find((item) => item.productId === product.id);
  if (!inquiry) throw new Error("没有这件产品的询价单");
  if (inquiry.quantity !== 1000 || inquiry.deadline !== deadline) {
    throw new Error(`询价字段不对：${JSON.stringify(inquiry)}`);
  }
  same(inquiry.supplierIds, ["S-001", "S-002"], "供应商");
  if (inquiry.status !== "awarded") throw new Error(`询价状态是 ${inquiry.status}`);
  same(inquiry.award, { supplierId: "S-001", price: 2.6 }, "中标");
}

function fingerprint(row: AuditRow) {
  return {
    capabilityId: row.capabilityId,
    input: row.input,
    effectiveImpact: row.effectiveImpact,
    issues: row.issues,
    summary: row.summary,
  };
}

function expectAudit(rows: AuditRow[], surface: "workbench" | "llm" | "mcp") {
  const actor = surface === "workbench" ? { kind: "human", surface: "workbench" } : { kind: "agent", surface };
  const steps =
    surface === "workbench"
      ? [
          ["product.create", "executed"],
          ["inquiry.create", "executed"],
          ["inquiry.publish", "executed"],
          ["inquiry.award", "executed"],
        ]
      : [
          ["product.create", "executed"],
          ["inquiry.create", "executed"],
          ["inquiry.publish", "pending_approval"],
          ["inquiry.publish", "approved_executed"],
          ["inquiry.award", "pending_approval"],
          ["inquiry.award", "approved_executed"],
        ];
  same(
    rows.map((row) => [row.capabilityId, row.outcome, row.actor?.kind, row.actor?.surface]),
    steps.map(([capabilityId, outcome]) => [capabilityId, outcome, actor.kind, actor.surface]),
    `${surface} 审计路径`,
  );
  if (surface !== "workbench") {
    for (const capabilityId of ["inquiry.publish", "inquiry.award"]) {
      const pending = rows.find((row) => row.capabilityId === capabilityId && row.outcome === "pending_approval");
      const done = rows.find((row) => row.capabilityId === capabilityId && row.outcome === "approved_executed");
      same(pending?.input, done?.input, `${surface} ${capabilityId} 的待审输入`);
    }
  }
}

async function runHttpTask(deadline: string) {
  await resetStore();
  const product = await invokeHttp({ capabilityId: "product.create", actor: HUMAN, input: TASK_PRODUCT });
  expectInvoke(product, "executed", "工作台新建产品");
  const productId = dataId(product.json);
  const inquiry = await invokeHttp({
    capabilityId: "inquiry.create",
    actor: HUMAN,
    input: taskInquiry(productId, deadline),
  });
  expectInvoke(inquiry, "executed", "工作台创建询价");
  const inquiryId = dataId(inquiry.json);
  const published = await invokeHttp({
    capabilityId: "inquiry.publish",
    actor: HUMAN,
    input: { inquiryId },
  });
  expectInvoke(published, "executed", "工作台发布");
  const awarded = await invokeHttp({
    capabilityId: "inquiry.award",
    actor: HUMAN,
    input: { inquiryId, supplierId: "S-001", price: 2.6 },
  });
  expectInvoke(awarded, "executed", "工作台中标");
  return { state: businessOf(await getState()), audit: await getAudit() };
}

async function finishGate(output: Record<string, unknown>, httpLog?: string[]) {
  if (output.status === "pending_approval") {
    const approvalId = output.approvalId;
    if (typeof approvalId !== "string" || !approvalId) throw new Error("待审结果没有审批号");
    await approve(approvalId, httpLog);
    return;
  }
  throw new Error(`写操作应进入待审，实际 ${String(output.status)} ${clip(JSON.stringify(output.summary ?? ""))}`);
}

async function runChatTask(deadline: string) {
  await resetStore();
  const providerId = await createProvider({
    name: "验收对话",
    baseUrl: mock?.url,
    model: "mock-model",
    apiKey: API_KEY,
  });
  try {
    const product = await chatTool(providerId, "product_create", TASK_PRODUCT);
    if (product.status !== "executed") throw new Error(`对话建产品 ${String(product.status)}`);
    const productId = dataId(product);
    const inquiry = await chatTool(providerId, "inquiry_create", taskInquiry(productId, deadline));
    if (inquiry.status !== "executed") throw new Error(`对话建询价 ${String(inquiry.status)} ${clip(JSON.stringify(inquiry))}`);
    const inquiryId = dataId(inquiry);
    await finishGate(await chatTool(providerId, "inquiry_publish", { inquiryId }));
    await finishGate(await chatTool(providerId, "inquiry_award", { inquiryId, supplierId: "S-001", price: 2.6 }));
    return { state: businessOf(await getState()), audit: await getAudit() };
  } finally {
    await deleteProvider(providerId);
  }
}

function toolPayload(result: { structuredContent?: unknown; isError?: boolean }): ToolPayload & { isError?: boolean } {
  const structured = asRecord(result.structuredContent) ?? {};
  return { ...(structured as ToolPayload), isError: result.isError };
}

async function connectMcp(): Promise<Client> {
  const client = new Client({ name: "verify", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`));
  await client.connect(transport);
  return client;
}

async function runMcpTask(deadline: string, tools: string[], httpLog: string[]) {
  await resetStore();
  const client = await connectMcp();
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      tools.push(name);
      const result = (await client.callTool({ name, arguments: args })) as {
        structuredContent?: unknown;
        isError?: boolean;
        content?: { text?: string }[];
      };
      const payload = toolPayload(result);
      if (result.isError || payload.status === "rejected") {
        const text = (result.content ?? []).map((item) => item.text ?? "").join("\n");
        throw new Error(`${name} 被拒绝：${clip(text || JSON.stringify(payload))}`);
      }
      return payload;
    };
    const product = await call("product_create", TASK_PRODUCT);
    const productId = dataId(product);
    const inquiry = await call("inquiry_create", taskInquiry(productId, deadline));
    const inquiryId = dataId(inquiry);
    await finishGate(await call("inquiry_publish", { inquiryId }) as Record<string, unknown>, httpLog);
    await finishGate(
      await call("inquiry_award", { inquiryId, supplierId: "S-001", price: 2.6 }) as Record<string, unknown>,
      httpLog,
    );
    return { state: businessOf(await getState()), audit: await getAudit() };
  } finally {
    await client.close();
  }
}

async function checkConsistency() {
  const deadline = daysFromToday(14);
  const http = await runHttpTask(deadline);
  const chat = await runChatTask(deadline);
  const mcpTools: string[] = [];
  const mcp = await runMcpTask(deadline, mcpTools, []);
  assertTask(http.state, deadline);
  same(chat.state, http.state, "对话与工作台的最终数据");
  same(mcp.state, http.state, "MCP 与工作台的最终数据");
  expectAudit(http.audit, "workbench");
  expectAudit(chat.audit, "llm");
  expectAudit(mcp.audit, "mcp");
  const settled = (rows: AuditRow[]) =>
    rows
      .filter((row) => row.outcome === "executed" || row.outcome === "approved_executed")
      .map(fingerprint);
  same(settled(chat.audit), settled(http.audit), "对话与工作台的已执行审计");
  same(settled(mcp.audit), settled(http.audit), "MCP 与工作台的已执行审计");
  if (mcpTools.some((name) => name === "show_form" || name === "get_ui_spec")) {
    throw new Error("一致性里的 MCP 路径渲染了界面");
  }
  return "工作台、对话、MCP 的产品和询价（含中标）一致；人工直接执行，Agent 的发布和中标是待审后执行";
}

async function checkHeadless() {
  const deadline = daysFromToday(14);
  const tools: string[] = [];
  const httpLog: string[] = [];
  await runMcpTask(deadline, tools, httpLog);
  const expected = ["product_create", "inquiry_create", "inquiry_publish", "inquiry_award"];
  same(tools, expected, "MCP 工具序列");
  if (httpLog.length !== 2 || httpLog.some((item) => !item.startsWith("POST /api/approvals/"))) {
    throw new Error(`任务中的 HTTP 不是两次人工批准：${httpLog.join(", ") || "无"}`);
  }
  return `只用 MCP 工具 ${tools.join(" → ")}，外加 2 次人工批准`;
}

interface BadCase {
  name: string;
  capabilityId: string;
  tool: string;
  input: Record<string, unknown>;
  hint: RegExp;
}

function badCases(deadline: string): BadCase[] {
  return [
    {
      name: "过去的截止日期",
      capabilityId: "inquiry.create",
      tool: "inquiry_create",
      input: { productId: "P-001", quantity: 10, deadline: "2000-01-01", supplierIds: ["S-001"] },
      hint: /未来日期|请改为/,
    },
    {
      name: "数量过大",
      capabilityId: "inquiry.create",
      tool: "inquiry_create",
      input: { productId: "P-001", quantity: 100001, deadline, supplierIds: ["S-001"] },
      hint: /100000/,
    },
    {
      name: "未知产品",
      capabilityId: "inquiry.create",
      tool: "inquiry_create",
      input: { productId: "P-999", quantity: 10, deadline, supplierIds: ["S-001"] },
      hint: /找不到产品/,
    },
    {
      name: "中标价过高",
      capabilityId: "inquiry.award",
      tool: "inquiry_award",
      input: { inquiryId: "Q-002", supplierId: "S-002", price: 10 },
      hint: /30%/,
    },
    {
      name: "未邀请的供应商",
      capabilityId: "inquiry.award",
      tool: "inquiry_award",
      input: { inquiryId: "Q-002", supplierId: "S-001", price: 0.15 },
      hint: /不在该询价单的供应商名单/,
    },
    {
      name: "重复发布",
      capabilityId: "inquiry.publish",
      tool: "inquiry_publish",
      input: { inquiryId: "Q-002" },
      hint: /只能发布草稿/,
    },
    {
      name: "重名产品",
      capabilityId: "product.create",
      tool: "product_create",
      input: { name: "不锈钢螺栓", category: "五金", unit: "件", referencePrice: 1 },
      hint: /已存在同名产品/,
    },
    {
      name: "字段缺失",
      capabilityId: "product.create",
      tool: "product_create",
      input: {},
      hint: /请填写/,
    },
  ];
}

function assertHint(text: string, item: BadCase, surface: string) {
  if (!/[\u4e00-\u9fff]/.test(text) || !item.hint.test(text)) {
    throw new Error(`${surface}「${item.name}」没有中文修正提示：${clip(text)}`);
  }
  if (/"status"\s*:\s*"executed"/.test(text)) {
    throw new Error(`${surface}「${item.name}」被执行了`);
  }
}

async function rejectHttp(item: BadCase): Promise<string> {
  const result = await invokeHttp({ capabilityId: item.capabilityId, actor: HUMAN, input: item.input });
  expectInvoke(result, "rejected", `HTTP ${item.name}`);
  return result.text;
}

async function rejectMcp(client: Client, item: BadCase): Promise<string> {
  try {
    const result = (await client.callTool({ name: item.tool, arguments: item.input })) as {
      structuredContent?: unknown;
      isError?: boolean;
      content?: { text?: string }[];
    };
    const text = `${(result.content ?? []).map((part) => part.text ?? "").join("\n")}\n${JSON.stringify(result.structuredContent ?? {})}`;
    const status = asRecord(result.structuredContent)?.status;
    if (!result.isError && status !== "rejected") {
      throw new Error(`MCP「${item.name}」没有被拒绝：${clip(text)}`);
    }
    return text;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("MCP「")) throw error;
    const text = error instanceof Error ? error.message : String(error);
    if (/fetch failed|ECONNREFUSED|other side closed|socket/i.test(text)) throw error;
    return text;
  }
}

async function rejectModel(providerId: string, item: BadCase): Promise<string> {
  const turn = await chatTurn(providerId, `[[call:${item.tool}:${JSON.stringify(item.input)}]]`);
  if (turn.status !== 200) throw new Error(`模型「${item.name}」HTTP ${turn.status} ${clip(turn.text)}`);
  if (turn.output?.status === "executed") throw new Error(`模型「${item.name}」被执行了`);
  return turn.text;
}

async function checkVerification() {
  const deadline = daysFromToday(14);
  const cases = badCases(deadline);
  const client = await connectMcp();
  const providerId = await createProvider({
    name: "验收拒绝",
    baseUrl: mock?.url,
    model: "mock-model",
    apiKey: API_KEY,
  });
  try {
    for (const surface of ["HTTP", "MCP", "模型"] as const) {
      for (const item of cases) {
        await resetStore();
        const before = await stateText();
        const text =
          surface === "HTTP"
            ? await rejectHttp(item)
            : surface === "MCP"
              ? await rejectMcp(client, item)
              : await rejectModel(providerId, item);
        const after = await stateText();
        if (before !== after) throw new Error(`${surface}「${item.name}」改变了业务数据`);
        assertHint(text, item, surface);
      }
    }
  } finally {
    await client.close();
    await deleteProvider(providerId);
  }
  return `${cases.length} 类错误经 HTTP、MCP、模型均被拒绝，业务数据不变`;
}

function inquiryById(state: { inquiries: Inquiry[] }, id: string): Inquiry {
  const inquiry = state.inquiries.find((item) => item.id === id);
  if (!inquiry) throw new Error(`没有询价单 ${id}`);
  return inquiry;
}

async function checkPolicy() {
  await resetStore();
  await putPolicy({ threshold: 6, alwaysReview: ["inquiry.award"] });
  const gated = await invokeHttp({
    capabilityId: "inquiry.publish",
    actor: AGENT,
    input: { inquiryId: "Q-001" },
  });
  expectInvoke(gated, "pending_approval", "阈值 6 发布");
  if (inquiryById(await getState(), "Q-001").status !== "draft") throw new Error("待审发布改动了询价单");

  await resetStore();
  await putPolicy({ threshold: 7, alwaysReview: ["inquiry.award"] });
  const released = await invokeHttp({
    capabilityId: "inquiry.publish",
    actor: AGENT,
    input: { inquiryId: "Q-001" },
  });
  expectInvoke(released, "executed", "阈值 7 发布");
  if (inquiryById(await getState(), "Q-001").status !== "published") throw new Error("阈值 7 没有发布");

  await resetStore();
  await putPolicy({ threshold: 10, alwaysReview: ["product.create"] });
  const forced = await invokeHttp({
    capabilityId: "product.create",
    actor: AGENT,
    input: { name: "策略螺栓", category: "五金", unit: "件", referencePrice: 1 },
  });
  expectInvoke(forced, "pending_approval", "必审的新建产品");
  if (asRecord(forced.json)?.effectiveImpact !== 2) throw new Error("新建产品的有效权重不是 2");
  if ((await getState()).products.some((item) => item.name === "策略螺栓")) {
    throw new Error("必审的新建产品被执行了");
  }

  await resetStore();
  await putPolicy({ threshold: 6, alwaysReview: [] });
  const awardHeld = await invokeHttp({
    capabilityId: "inquiry.award",
    actor: AGENT,
    input: { inquiryId: "Q-002", supplierId: "S-002", price: 0.15 },
  });
  expectInvoke(awardHeld, "pending_approval", "阈值 6 的中标");
  if (asRecord(awardHeld.json)?.effectiveImpact !== 9) {
    throw new Error(`中标有效权重不是 9：${clip(awardHeld.text)}`);
  }
  if (inquiryById(await getState(), "Q-002").status !== "published") throw new Error("待审中标改动了询价单");

  await resetStore();
  await putPolicy({ threshold: 10, alwaysReview: [] });
  const awardRun = await invokeHttp({
    capabilityId: "inquiry.award",
    actor: AGENT,
    input: { inquiryId: "Q-002", supplierId: "S-002", price: 0.15 },
  });
  expectInvoke(awardRun, "executed", "阈值 10 的中标");
  if (asRecord(awardRun.json)?.effectiveImpact !== 9) throw new Error("放行中标的有效权重不是 9");
  const awarded = inquiryById(await getState(), "Q-002");
  if (awarded.status !== "awarded" || awarded.award?.price !== 0.15) throw new Error("阈值 10 没有按干净价格中标");

  await resetStore();
  await putPolicy({
    threshold: 0,
    alwaysReview: ["product.create", "inquiry.create", "inquiry.publish", "inquiry.award"],
  });
  const humanProduct = await invokeHttp({
    capabilityId: "product.create",
    actor: HUMAN,
    input: { name: "人工验收件", category: "五金", unit: "件", referencePrice: 1 },
  });
  expectInvoke(humanProduct, "executed", "人工新建产品");
  const humanPublish = await invokeHttp({
    capabilityId: "inquiry.publish",
    actor: HUMAN,
    input: { inquiryId: "Q-001" },
  });
  expectInvoke(humanPublish, "executed", "人工发布");
  const humanAward = await invokeHttp({
    capabilityId: "inquiry.award",
    actor: HUMAN,
    input: { inquiryId: "Q-002", supplierId: "S-002", price: 0.15 },
  });
  expectInvoke(humanAward, "executed", "人工中标");

  await resetStore();
  const omitted = await invokeHttp({ capabilityId: "inquiry.publish", input: { inquiryId: "Q-001" } });
  expectInvoke(omitted, "pending_approval", "省略 actor 的发布");
  same(asRecord(omitted.json)?.actor, AGENT, "省略 actor");

  return "阈值 6 发布待审、7 执行；必审名单罩住权重 2；中标去掉必审后阈值 6 仍待审、10 执行；人工不审核；省略 actor 视为 agent";
}

const WIDGET_INPUT = {
  productId: "P-002",
  quantity: 1000,
  supplierIds: ["S-001", "S-005"],
};

function assertDraft(state: { inquiries: Inquiry[] }, deadline: string) {
  const created = state.inquiries.filter((item) => item.id !== "Q-001" && item.id !== "Q-002");
  if (created.length !== 1) throw new Error(`新增询价 ${created.length} 张`);
  const inquiry = created[0];
  if (!inquiry) throw new Error("没有新询价");
  same(
    {
      productId: inquiry.productId,
      quantity: inquiry.quantity,
      deadline: inquiry.deadline,
      supplierIds: inquiry.supplierIds,
      status: inquiry.status,
      award: inquiry.award ?? null,
    },
    {
      productId: WIDGET_INPUT.productId,
      quantity: WIDGET_INPUT.quantity,
      deadline,
      supplierIds: WIDGET_INPUT.supplierIds,
      status: "draft",
      award: null,
    },
    "草稿字段",
  );
}

async function draftViaHttp(deadline: string) {
  await resetStore();
  const result = await invokeHttp({
    capabilityId: "inquiry.create",
    actor: HUMAN,
    input: { ...WIDGET_INPUT, deadline },
  });
  expectInvoke(result, "executed", "工作台创建对照草稿");
  const state = await getState();
  assertDraft(state, deadline);
  return businessOf(state);
}

async function draftViaMcp(deadline: string) {
  await resetStore();
  const client = await connectMcp();
  try {
    const result = (await client.callTool({
      name: "inquiry_create",
      arguments: { ...WIDGET_INPUT, deadline },
    })) as { structuredContent?: unknown; isError?: boolean };
    const payload = toolPayload(result);
    if (result.isError || payload.status !== "executed") {
      throw new Error(`MCP 对照草稿失败：${clip(JSON.stringify(payload))}`);
    }
  } finally {
    await client.close();
  }
  const state = await getState();
  assertDraft(state, deadline);
  return businessOf(state);
}

function isSans(font: string): boolean {
  return /sans|geist|pingfang|noto sans|microsoft yahei|system-ui|ui-sans/i.test(font);
}

async function widgetFrame(page: Page): Promise<Frame> {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const hit = await frame
        .evaluate(() => Boolean(document.querySelector('[data-field="productId"]')))
        .catch(() => false);
      if (hit) return frame;
    }
    await sleep(200);
  }
  const texts = await Promise.all(
    page.frames().map(async (frame) => {
      const text = await frame.evaluate(() => document.body?.innerText.slice(0, 120) ?? "").catch(() => "");
      return `${frame.url() || "(srcdoc)"}: ${text}`;
    }),
  );
  throw new Error(`沙箱里没有创建询价表单。${texts.join(" | ")}`);
}

async function setInputValue(frame: Frame, field: string, value: string) {
  const wrote = await frame.evaluate((fieldName, next) => {
    const input = document.querySelector(`[data-field="${fieldName}"] input`);
    if (!(input instanceof HTMLInputElement)) return "missing";
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    descriptor?.set?.call(input, next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input.value;
  }, field, value);
  if (wrote !== value) throw new Error(`${field} 没有写成 ${value}（实际 ${wrote}）`);
}

async function clickInFrame(frame: Frame, selector: string) {
  const handle = await frame.waitForSelector(selector, { timeout: 8_000, visible: true });
  if (!handle) throw new Error(`找不到 ${selector}`);
  await handle.click();
}

async function runWidget(deadline: string) {
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SkipCheck(`无法启动 Chrome（${chromePath}）：${clip(message, 180)}`);
  }
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/host-sim`, { waitUntil: "load", timeout: 60_000 });
    try {
      await page.waitForFunction(() => document.body.innerText.includes("已连接"), { timeout: 60_000 });
    } catch (error) {
      const text = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? "").catch(() => "");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}；页面：${text.replace(/\s+/g, " ")}`);
    }
    await page.evaluate(() => {
      const preset = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("表单：创建询价"));
      if (!(preset instanceof HTMLButtonElement)) throw new Error("没有「表单：创建询价」");
      preset.click();
    });
    await page.waitForFunction(() => {
      const call = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "调用");
      return call instanceof HTMLButtonElement && !call.disabled;
    });
    await page.evaluate(() => {
      const call = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "调用");
      if (!(call instanceof HTMLButtonElement)) throw new Error("没有调用按钮");
      call.click();
    });
    const frame = await widgetFrame(page);
    await clickInFrame(frame, '[data-field="productId"] [data-slot="select-trigger"]');
    await frame.waitForSelector('[data-slot="select-item"]', { visible: true });
    const options = await frame.$$("[data-slot='select-item']");
    let picked = false;
    for (const option of options) {
      const text = await option.evaluate((node) => node.textContent ?? "");
      if (!text.includes("镀锌螺母")) continue;
      await option.click();
      picked = true;
      break;
    }
    if (!picked) throw new Error("产品选项里没有镀锌螺母");
    await frame.waitForFunction(
      () => document.querySelector('[data-field="productId"]')?.textContent?.includes("镀锌螺母") ?? false,
    );
    await setInputValue(frame, "quantity", "1000");
    await setInputValue(frame, "deadline", deadline);
    for (const label of ["沪上紧固件", "联采商行"]) {
      await clickInFrame(frame, `[data-field="supplierIds"] [aria-label="${label}"]`);
      const checked = await frame.$eval(
        `[data-field="supplierIds"] [aria-label="${label}"]`,
        (element) => element.getAttribute("aria-checked"),
      );
      if (checked !== "true") throw new Error(`没有选中供应商 ${label}`);
    }
    const fonts = await frame.evaluate(() => ({
      body: getComputedStyle(document.body).fontFamily,
      heading: getComputedStyle(document.querySelector("h2") ?? document.body).fontFamily,
      input: getComputedStyle(document.querySelector("input") ?? document.body).fontFamily,
    }));
    if (!isSans(fonts.body) || !isSans(fonts.heading) || !isSans(fonts.input)) {
      throw new Error(`界面字体仍是衬线：${JSON.stringify(fonts)}`);
    }
    mkdirSync(path.dirname(screenshotPath), { recursive: true });
    await page.evaluate(() => document.querySelector("[data-testid='host-sim-frame']")?.scrollIntoView());
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await clickInFrame(frame, 'button[type="submit"]');
    await frame.waitForFunction(
      () => {
        const text = document.body?.innerText ?? "";
        return text.includes("已创建询价草稿") || Boolean(document.querySelector("[role='alert']"));
      },
      { timeout: 15_000 },
    );
    const widgetText = await frame.evaluate(() => document.body?.innerText ?? "");
    if (!widgetText.includes("已创建询价草稿")) {
      throw new Error(`界面没有创建草稿：${clip(widgetText)}`);
    }
    return { fonts, widgetText };
  } finally {
    await browser.close();
  }
}

async function checkWidget() {
  const deadline = daysFromToday(14);
  const http = await draftViaHttp(deadline);
  const mcp = await draftViaMcp(deadline);
  same(mcp, http, "MCP 与工作台的对照草稿");
  await resetStore();
  const widget = await runWidget(deadline);
  const state = await getState();
  assertDraft(state, deadline);
  same(businessOf(state), http, "外发界面与其他入口的草稿");
  return `沙箱表单提交的草稿与工作台、MCP 一致；字体 ${clip(widget.fonts.body, 80)}`;
}

function requestModel(call: MockLlmCall): string {
  const model = asRecord(call.body)?.model;
  return typeof model === "string" ? model : "";
}

async function setDefault(id: string) {
  const response = await request("/api/providers/default", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (response.status !== 200) throw new Error(`设置默认模型失败 ${response.status} ${clip(response.text)}`);
  const listed = await request("/api/providers");
  if (asRecord(listed.json)?.defaultId !== id) throw new Error("默认模型没有切换成功");
}

async function checkModelsClean() {
  if (!mock) throw new Error("模拟模型没有启动");
  const before = mock.calls.length;
  const alphaId = await createProvider({
    name: "验收甲",
    baseUrl: mock.url,
    model: "mock-alpha",
    apiKey: API_KEY,
  });
  const betaId = await createProvider({
    name: "验收乙",
    baseUrl: mock.url,
    model: "mock-beta",
    apiKey: API_KEY,
    headers: { [HEADER_NAME]: HEADER_SECRET },
  });
  try {
    await setDefault(alphaId);
    const alpha = await chatTurn(alphaId, "你好");
    if (alpha.status !== 200 || !alpha.text.includes("请说明要办的事")) {
      throw new Error(`模型甲对话失败 ${alpha.status} ${clip(alpha.text)}`);
    }
    await setDefault(betaId);
    const beta = await chatTurn(betaId, "你好");
    if (beta.status !== 200 || !beta.text.includes("请说明要办的事")) {
      throw new Error(`模型乙对话失败 ${beta.status} ${clip(beta.text)}`);
    }
    const turns = mock.calls.slice(before).filter((call) => call.pathname.endsWith("/chat/completions"));
    if (!turns.some((call) => requestModel(call) === "mock-alpha")) throw new Error("模拟服务没有收到模型甲");
    const betaCall = turns.find((call) => requestModel(call) === "mock-beta");
    if (!betaCall) throw new Error("模拟服务没有收到模型乙");
    if (betaCall.headers[HEADER_NAME] !== HEADER_SECRET) throw new Error("模型乙的自定义请求头没有送到模拟服务");
    await deleteProvider(betaId);
    const missing = await chatTurn(betaId, "你好");
    if (missing.status !== 404) throw new Error(`删除后的对话返回 ${missing.status}`);
    if (!missing.text.includes("所选模型不存在") || !missing.text.includes("provider_missing")) {
      throw new Error(`删除模型后的错误不清楚：${clip(missing.text)}`);
    }
    const choice = resolveModelSelection(betaId, [{ id: alphaId }], alphaId);
    if (choice.id !== GUIDED_MODEL_ID || !choice.fellBackToGuided) {
      throw new Error("客户端没有在所选模型消失后回到引导模式");
    }
    const failure = parseChatFailure(
      new Error(JSON.stringify({ error: "所选模型不存在，已切换到引导模式。", code: "provider_missing" })),
    );
    if (!failure.missingProvider || !failure.message.includes("引导模式")) {
      throw new Error("parseChatFailure 没有把 provider_missing 当成回退");
    }
    if (captured.length === 0) throw new Error("没有收集到响应正文");
    return `两个模型各完成一轮（乙带自定义请求头）；删除后对话返回 provider_missing；${captured.length} 段响应不含密钥；客户端回退到 ${GUIDED_MODEL_ID}`;
  } finally {
    if (createdProviders.includes(betaId)) await deleteProvider(betaId).catch(() => undefined);
    if (createdProviders.includes(alphaId)) await deleteProvider(alphaId).catch(() => undefined);
  }
}

async function checkCursorEngine() {
  const key = "cursor_verify_SHOULD_NOT_LEAK_91zz";
  const previousData = process.env.AGENT_DATA_DIR;
  const previousCursor = process.env.CURSOR_API_KEY;
  const previousTimeout = process.env.CURSOR_TIMEOUT_MS;
  const data = mkdtempSync(path.join(tmpdir(), "verify-cursor-"));
  process.env.AGENT_DATA_DIR = data;
  delete process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_AUTH_TOKEN;
  process.env.CURSOR_TIMEOUT_MS = "5000";
  let ready = false;
  try {
    const sdk = await import("@/lib/server/cursor-sdk");
    const engine = await import("@/lib/server/cursor-engine");
    const providers = await import("@/lib/server/providers");
    const fakeModule = await import("@/lib/server/cursor-fake");
    const route = await import("@/app/api/chat/route");
    ready = true;
    const fake = fakeModule.createFakeCursorSdk({
      events: [
        { type: "assistant", message: { content: [{ type: "text", text: "正在查看询价单。" }] } },
        {
          type: "tool_call",
          call_id: "c1",
          name: "mcp",
          status: "running",
          args: { toolName: "list_capabilities", args: {} },
        },
        {
          type: "tool_call",
          call_id: "c1",
          name: "mcp",
          status: "completed",
          args: { toolName: "list_capabilities", args: {} },
          result: {
            status: "success",
            value: { content: [{ text: { text: JSON.stringify({ capabilities: ["inquiry.list"] }) } }], isError: false },
          },
        },
      ],
    });
    sdk.setCursorSdkForTests(fake.sdk);
    providers.resetProvidersForTests();
    engine.resetCursorSessionsForTests();
    const created = providers.createProvider({
      kind: "cursor",
      name: "验收 Cursor",
      model: "composer-2",
      apiKey: key,
    });
    if (!created.ok) throw new Error(created.error);
    const response = await route.POST(
      new Request("http://127.0.0.1:4817/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId: created.provider.id,
          chatId: "verify-cursor",
          messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "查看现有的询价单" }] }],
        }),
      }),
    );
    const text = await response.text();
    if (response.status !== 200) throw new Error(`Cursor 对话返回 ${response.status} ${clip(text)}`);
    if (text.includes(key)) throw new Error("Cursor 响应含有密钥");
    if (text.includes('"type":"error"')) throw new Error(`Cursor 流出现错误：${clip(text)}`);
    if (!text.includes("list_capabilities") || !text.includes("正在查看询价单")) {
      throw new Error(`Cursor 流缺少文本或业务工具：${clip(text)}`);
    }
    const createdCall = fake.calls.find((call) => call.op === "create");
    if (!createdCall?.options?.mcpServers["agent-native"]?.url.endsWith("/api/mcp")) {
      throw new Error("没有把本服务的 MCP 地址交给 Cursor");
    }
    if (!fake.calls.some((call) => call.op === "dispose")) throw new Error("Cursor 智能体没有释放");
    return "进程内假 SDK 完成一轮：文本、list_capabilities、MCP 地址、无错误块、响应不含密钥";
  } catch (error) {
    if (ready || error instanceof SkipCheck) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new SkipCheck(`无法在进程内注入 Cursor SDK：${message}`);
  } finally {
    const sdk = await import("@/lib/server/cursor-sdk").catch(() => null);
    sdk?.setCursorSdkForTests(null);
    if (previousData === undefined) delete process.env.AGENT_DATA_DIR;
    else process.env.AGENT_DATA_DIR = previousData;
    if (previousCursor === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = previousCursor;
    if (previousTimeout === undefined) delete process.env.CURSOR_TIMEOUT_MS;
    else process.env.CURSOR_TIMEOUT_MS = previousTimeout;
    rmSync(data, { recursive: true, force: true });
  }
}

async function runCheck(name: string, run: () => Promise<string>): Promise<CheckResult> {
  try {
    await resetStore();
    const evidence = await run();
    return { name, status: "PASS", evidence: clip(evidence, 280) };
  } catch (error) {
    if (error instanceof SkipCheck) return { name, status: "SKIP", evidence: clip(error.message, 280) };
    const message = error instanceof Error ? error.message : String(error);
    return { name, status: "FAIL", evidence: clip(message, 320) };
  }
}

function printReport(results: CheckResult[]) {
  const lines = ["| 检查 | 结果 | 说明 |", "| --- | --- | --- |"];
  for (const item of results) lines.push(`| ${item.name} | ${item.status} | ${item.evidence.replaceAll("|", "/")} |`);
  console.log(lines.join("\n"));
  console.log(`
手动验证项（不计分）
- 零学习成本：请一位没用过本系统的人，不看说明，只用对话里的建议卡片、/ 或 + 完成一次「建产品 → 建询价 → 发布」。
- ChatGPT 开发者模式：用公网 HTTPS 隧道把本机 4817 暴露出去，在 ChatGPT 里添加指向 /api/mcp 的自定义连接器，确认能看到并提交智能界面。`);
}

async function reachable(): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/state`, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

function startDev() {
  dataDir = mkdtempSync(path.join(tmpdir(), "verify-providers-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_DATA_DIR: dataDir,
    NEXT_TELEMETRY_DISABLED: "1",
  };
  delete env.LLM_BASE_URL;
  delete env.LLM_MODEL;
  delete env.LLM_API_KEY;
  delete env.CURSOR_API_KEY;
  delete env.CURSOR_AUTH_TOKEN;
  const child = spawn("npm", ["run", "dev"], {
    cwd: root,
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk: Buffer) => {
    serverLog += chunk.toString();
    if (serverLog.length > 200_000) serverLog = serverLog.slice(-120_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return child;
}

async function waitReady(child: ChildProcess) {
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    if (child.exitCode !== null) {
      throw new Error(`next dev 已退出 ${child.exitCode}：${clip(serverLog, 800)}`);
    }
    if (await reachable()) return;
    await sleep(400);
  }
  throw new Error(`等待 ${baseUrl} 超时：${clip(serverLog, 800)}`);
}

async function stopDev(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return;
  const pid = child.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    sleep(5_000).then(() => false),
  ]);
  if (!exited) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      sleep(2_000).then(() => undefined),
    ]);
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (await reachable()) {
    for (const id of [...createdProviders]) {
      await deleteProvider(id).catch(() => undefined);
    }
    await resetStore().catch(() => undefined);
  }
  await mock?.close().catch(() => undefined);
  mock = undefined;
  if (devProcess) {
    await stopDev(devProcess);
    devProcess = undefined;
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}

async function main() {
  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(143));
  });
  let code = 0;
  try {
    if (!(await reachable())) {
      devProcess = startDev();
      await waitReady(devProcess);
    }
    mock = await startMockLlm({
      port: 0,
      key: API_KEY,
      requiredHeader: { name: HEADER_NAME, value: HEADER_SECRET, models: ["mock-beta"] },
    });
    const results = [
      await runCheck("一致性", checkConsistency),
      await runCheck("无界面", checkHeadless),
      await runCheck("验证机制", checkVerification),
      await runCheck("策略", checkPolicy),
      await runCheck("外发 UI", checkWidget),
      await runCheck("模型可换", checkModelsClean),
      await runCheck("Cursor 引擎", checkCursorEngine),
    ];
    printReport(results);
    if (results.some((item) => item.status === "FAIL")) code = 1;
  } catch (error) {
    code = 1;
    console.error(clip(error instanceof Error ? error.message : String(error), 1000));
  } finally {
    await shutdown();
  }
  process.exit(code);
}

void main();
