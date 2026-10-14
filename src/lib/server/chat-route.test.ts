import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/chat/route";
import { getStore, reset } from "@/lib/server/db";
import { findApproval, setPolicy } from "@/lib/server/governance";
import { createProvider, resetProvidersForTests, updateProvider } from "@/lib/server/providers";
import { MODEL_UNAVAILABLE } from "@/lib/server/system-prompt";
import { startMockLlm, type MockLlmHandle } from "../../../scripts/mock-llm";

const SECRET = "sk-chat-route-secret-77aa";
const dir = mkdtempSync(path.join(tmpdir(), "chat-providers-"));
const previous = {
  AGENT_DATA_DIR: process.env.AGENT_DATA_DIR,
  LLM_BASE_URL: process.env.LLM_BASE_URL,
  LLM_MODEL: process.env.LLM_MODEL,
  LLM_API_KEY: process.env.LLM_API_KEY,
  CURSOR_API_KEY: process.env.CURSOR_API_KEY,
  CURSOR_AUTH_TOKEN: process.env.CURSOR_AUTH_TOKEN,
};

let mock: MockLlmHandle;
let providerId = "";

function restoreEnv() {
  for (const key of ["AGENT_DATA_DIR", "LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"] as const) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(async () => {
  process.env.AGENT_DATA_DIR = dir;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_API_KEY;
  delete process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_AUTH_TOKEN;
  reset();
  resetProvidersForTests();
  await mock?.close();
  mock = await startMockLlm({ port: 0, key: SECRET });
  const created = createProvider({
    name: "Mock",
    baseUrl: mock.url,
    model: "mock-model",
    apiKey: SECRET,
  });
  if (!created.ok) throw new Error(created.error);
  providerId = created.provider.id;
});

afterAll(async () => {
  await mock?.close();
  restoreEnv();
  rmSync(dir, { recursive: true, force: true });
});

function chat(text: string, id = providerId) {
  return POST(
    new Request("http://local/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerId: id,
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text }] }],
      }),
    }),
  );
}

async function capture<T>(run: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const logs: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const spies = methods.map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(
        args
          .map((item) => {
            if (typeof item === "string") return item;
            if (item instanceof Error) return `${item.name} ${item.message} ${item.stack ?? ""}`;
            try {
              return JSON.stringify(item);
            } catch {
              return String(item);
            }
          })
          .join(" "),
      );
    }),
  );
  try {
    const result = await run();
    return { result, logs: logs.join("\n") };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

async function readResponse(response: Response) {
  const text = await response.text();
  const chunks: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed && typeof parsed === "object") chunks.push(parsed as Record<string, unknown>);
    } catch {
      // Non-JSON lines are still scanned as text.
    }
  }
  return { status: response.status, text, chunks };
}

function toolOutputs(chunks: Record<string, unknown>[]) {
  return chunks.filter((chunk) => chunk.type === "tool-output-available" || chunk.type === "tool-input-available");
}

function lastToolPayload() {
  const call = mock.calls.filter((item) => item.pathname.endsWith("/chat/completions")).at(-1);
  return JSON.stringify(call?.body ?? {});
}

describe("POST /api/chat", () => {
  it("publishes through the agent actor and stops at pending approval", async () => {
    const { result, logs } = await capture(() => chat("发布询价 Q-001"));
    const response = await readResponse(result);
    expect(response.text).not.toContain(SECRET);
    expect(logs).not.toContain(SECRET);
    expect(response.text).toContain("需要人工审核");
    expect(getStore().inquiries.find((item) => item.id === "Q-001")?.status).toBe("draft");
    const approval = getStore().approvals[0];
    expect(approval?.capabilityId).toBe("inquiry.publish");
    expect(approval?.actor).toEqual({ kind: "agent", surface: "llm" });
    expect(approval?.input).toEqual({ inquiryId: "Q-001" });
    expect(lastToolPayload()).toContain("pending_approval");
    const output = toolOutputs(response.chunks).find((chunk) => chunk.type === "tool-output-available");
    expect(output?.output).toMatchObject({ status: "pending_approval", capabilityId: "inquiry.publish" });
  });

  it("executes publish when the policy threshold is above the weight", async () => {
    expect(setPolicy({ threshold: 10, alwaysReview: ["inquiry.award"] }).ok).toBe(true);
    const response = await readResponse(await chat("发布询价 Q-001"));
    expect(response.text).not.toContain(SECRET);
    expect(response.text).toContain("操作已执行");
    expect(getStore().inquiries.find((item) => item.id === "Q-001")?.status).toBe("published");
    expect(getStore().approvals).toHaveLength(0);
  });

  it("always leaves award pending under the default always-review rule", async () => {
    expect(setPolicy({ threshold: 10, alwaysReview: ["inquiry.award"] }).ok).toBe(true);
    const response = await readResponse(await chat("确认中标 Q-002 供应商 S-002 价格 0.1"));
    expect(response.text).not.toContain(SECRET);
    expect(response.text).toContain("需要人工审核");
    expect(getStore().inquiries.find((item) => item.id === "Q-002")?.status).toBe("published");
    expect(findApproval(getStore().approvals[0]?.id ?? "")?.capabilityId).toBe("inquiry.award");
    expect(getStore().approvals[0]?.actor).toEqual({ kind: "agent", surface: "llm" });
  });

  it("returns a verifier rejection as a tool output the model can read", async () => {
    const inquiry = getStore().inquiries.find((item) => item.id === "Q-001");
    if (!inquiry) throw new Error("missing Q-001");
    inquiry.deadline = "2000-01-01";
    const response = await readResponse(await chat("发布询价 Q-001"));
    expect(response.text).not.toContain(SECRET);
    expect(response.text).toContain("操作被拒绝");
    expect(getStore().inquiries.find((item) => item.id === "Q-001")?.status).toBe("draft");
    expect(getStore().approvals).toHaveLength(0);
    expect(lastToolPayload()).toContain("rejected");
    const output = toolOutputs(response.chunks).find((chunk) => chunk.type === "tool-output-available");
    expect(output?.output).toMatchObject({ status: "rejected" });
  });

  it("does not execute show_form on the server", async () => {
    const response = await readResponse(await chat("帮我新建一个产品"));
    expect(response.text).not.toContain(SECRET);
    expect(getStore().products).toHaveLength(6);
    const inputs = toolOutputs(response.chunks).filter((chunk) => chunk.type === "tool-input-available");
    expect(inputs).toEqual([
      expect.objectContaining({ toolName: "show_form", input: expect.objectContaining({ capabilityId: "product.create" }) }),
    ]);
    expect(toolOutputs(response.chunks).some((chunk) => chunk.type === "tool-output-available")).toBe(false);
    expect(mock.calls.filter((item) => item.pathname.endsWith("/chat/completions"))).toHaveLength(1);
  });

  it("maps a provider failure to a Chinese message without the key", async () => {
    const { result, logs } = await capture(() => chat("触发错误"));
    const response = await readResponse(result);
    expect(response.status === 200 || response.status === 502).toBe(true);
    expect(response.text).toContain(MODEL_UNAVAILABLE);
    expect(response.text).not.toContain(SECRET);
    expect(response.text).not.toContain("Bearer");
    expect(response.text).not.toContain("triggered");
    expect(logs).not.toContain(SECRET);
    expect(logs).not.toContain("Bearer");
  });

  it("keeps a custom header secret out of a provider failure", async () => {
    const headerSecret = "SECRETHEADER123";
    const updated = updateProvider(providerId, { headers: { "x-api-key": headerSecret } });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.provider.headerNames).toEqual(["x-api-key"]);
      expect(JSON.stringify(updated.provider)).not.toContain(headerSecret);
    }
    const { result, logs } = await capture(() => chat("触发错误"));
    const response = await readResponse(result);
    expect(response.text).toContain(MODEL_UNAVAILABLE);
    expect(response.text).not.toContain(headerSecret);
    expect(response.text).not.toContain(SECRET);
    expect(logs).not.toContain(headerSecret);
    expect(mock.calls.some((call) => call.sawXApiKey)).toBe(true);
  });

  it("reports a missing provider without reading a key", async () => {
    const response = await readResponse(await chat("发布询价 Q-001", "missing-provider"));
    expect(response.status).toBe(404);
    expect(response.text).toContain("provider_missing");
    expect(response.text).not.toContain(SECRET);
  });

  it("returns the contract's Chinese hint when a model tool call fails schema checks", async () => {
    const before = getStore().products.length;
    const response = await readResponse(await chat("[[call:product_create:{}]]"));
    expect(response.status).toBe(200);
    expect(response.text).toContain("请填写名称");
    expect(response.text).not.toContain(MODEL_UNAVAILABLE);
    expect(getStore().products).toHaveLength(before);
    const errors = response.chunks.filter(
      (chunk) => chunk.type === "tool-input-error" || chunk.type === "tool-output-error",
    );
    expect(errors.map((chunk) => chunk.type).sort()).toEqual(["tool-input-error", "tool-output-error"]);
    for (const chunk of errors) {
      expect(String(chunk.errorText)).toContain("请填写名称");
    }
  });

  it("follows a scripted tool directive and keeps the agent actor", async () => {
    const response = await readResponse(
      await chat('[[call:product_create:{"name":"脚本螺栓","category":"五金","unit":"件","referencePrice":3}]]'),
    );
    const created = getStore().products.find((item) => item.name === "脚本螺栓");
    expect(created?.referencePrice).toBe(3);
    const output = toolOutputs(response.chunks).find((chunk) => chunk.type === "tool-output-available");
    expect(output?.output).toMatchObject({ status: "executed", capabilityId: "product.create" });
    expect(getStore().audit.at(-1)?.actor).toEqual({ kind: "agent", surface: "llm" });
  });
});
