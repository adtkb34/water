import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/chat/route";
import { POST as testProvider } from "@/app/api/providers/[id]/test/route";
import { createFakeCursorSdk, type FakeCursorScript } from "@/lib/server/cursor-fake";
import { resetCursorSessionsForTests } from "@/lib/server/cursor-engine";
import { CURSOR_PREAMBLE } from "@/lib/server/cursor-prompt";
import { setCursorSdkForTests } from "@/lib/server/cursor-sdk";
import { createProvider, resetProvidersForTests } from "@/lib/server/providers";

const KEY = "cursor_test_KEY_should_not_leak_zz91";
const dir = mkdtempSync(path.join(tmpdir(), "cursor-engine-"));
const previous = {
  AGENT_DATA_DIR: process.env.AGENT_DATA_DIR,
  CURSOR_API_KEY: process.env.CURSOR_API_KEY,
  CURSOR_TIMEOUT_MS: process.env.CURSOR_TIMEOUT_MS,
  CURSOR_DEBUG: process.env.CURSOR_DEBUG,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
};

function restore(name: keyof typeof previous) {
  const value = previous[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  process.env.AGENT_DATA_DIR = dir;
  delete process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_TIMEOUT_MS;
  delete process.env.CURSOR_DEBUG;
  delete process.env.PUBLIC_BASE_URL;
  resetProvidersForTests();
  resetCursorSessionsForTests();
  setCursorSdkForTests(null);
});

afterEach(() => {
  setCursorSdkForTests(null);
  resetCursorSessionsForTests();
});

afterAll(() => {
  for (const name of Object.keys(previous) as Array<keyof typeof previous>) restore(name);
  rmSync(dir, { recursive: true, force: true });
});

function provider(apiKey = KEY, model = "composer-2") {
  const created = createProvider({ kind: "cursor", name: "Cursor 测试", model, apiKey });
  if (!created.ok) throw new Error(created.error);
  return created.provider.id;
}

function chatRequest(id: string, text = "查看现有的询价单", chatId = "chat-1", signal?: AbortSignal) {
  return new Request("http://127.0.0.1:4817/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      providerId: id,
      chatId,
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text }] }],
    }),
    signal,
  });
}

async function readStream(response: Response) {
  const text = await response.text();
  const chunks: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    chunks.push(JSON.parse(payload) as Record<string, unknown>);
  }
  return { status: response.status, text, chunks };
}

function install(script: FakeCursorScript) {
  const fake = createFakeCursorSdk(script);
  setCursorSdkForTests(fake.sdk);
  return fake;
}

const listResult = {
  status: "success",
  value: {
    content: [{ text: { text: JSON.stringify({ capabilities: ["inquiry.list"] }) } }],
    isError: false,
  },
};

describe("cursor chat route", () => {
  it("maps text, our tools in each name variant, and a single forbidden-tool note", async () => {
    const fake = install({
      events: [
        { type: "thinking", text: "secret plan" },
        { type: "assistant", message: { content: [{ type: "text", text: "正在查" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "正在查" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "正在查看询价。" }] } },
        {
          type: "tool_call",
          call_id: "a",
          name: "mcp__agent-native__inquiry_publish",
          status: "running",
          args: { inquiryId: "Q-001" },
        },
        {
          type: "tool_call",
          call_id: "a",
          name: "mcp__agent-native__inquiry_publish",
          status: "completed",
          result: { structuredContent: { status: "pending_approval", summary: "待审", capabilityId: "inquiry.publish" } },
        },
        {
          type: "tool_call",
          call_id: "b",
          name: "agent-native-list_capabilities",
          status: "completed",
          args: {},
          result: listResult,
        },
        {
          type: "tool_call",
          call_id: "c",
          name: "show_form",
          status: "running",
          args: { capabilityId: "inquiry.create" },
        },
        {
          type: "tool_call",
          call_id: "c",
          name: "show_form",
          status: "completed",
          result: { kind: "form", uiSpec: { capabilityId: "inquiry.create" }, prefill: {} },
        },
        {
          type: "tool_call",
          call_id: "d",
          name: "mcp",
          status: "running",
          args: { toolName: "get_approval_status", args: { approvalId: "A-001" } },
        },
        {
          type: "tool_call",
          call_id: "d",
          name: "mcp",
          status: "completed",
          args: { toolName: "get_approval_status", args: { approvalId: "A-001" } },
          result: { content: [{ type: "text", text: "状态未知" }] },
        },
        { type: "tool_call", call_id: "s1", name: "shell", status: "running", args: { command: "ls" } },
        { type: "tool_call", call_id: "s2", name: "read", status: "completed", args: { path: "x" }, result: "no" },
      ],
    });
    const logs: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const body = await readStream(await POST(chatRequest(provider())));
      expect(body.status).toBe(200);
      expect(body.text).not.toContain(KEY);
      const text = body.chunks
        .filter((chunk) => chunk.type === "text-delta")
        .map((chunk) => chunk.delta)
        .join("");
      expect(text).toContain("正在查看询价。");
      expect(text.match(/正在查/g)?.length).toBe(1);
      expect(text.split("智能体尝试使用了非业务工具，已忽略")).toHaveLength(2);
      const tools = body.chunks.filter((chunk) => chunk.type === "tool-input-available");
      expect(tools.map((chunk) => chunk.toolName)).toEqual([
        "inquiry_publish",
        "list_capabilities",
        "show_form",
        "get_approval_status",
      ]);
      const outputs = body.chunks.filter((chunk) => chunk.type === "tool-output-available");
      expect(outputs[0]?.output).toMatchObject({ status: "pending_approval" });
      expect(outputs[1]?.output).toMatchObject({ capabilities: ["inquiry.list"] });
      expect(outputs[2]?.output).toMatchObject({ kind: "form" });
      expect(outputs[3]?.output).toEqual({ status: "unknown", summary: "状态未知" });
      expect(body.chunks.some((chunk) => chunk.type === "error")).toBe(false);
      expect(logs.join("\n")).toContain("shell");
      expect(logs.join("\n")).not.toContain(KEY);
      expect(info).toHaveBeenCalled();
      const created = fake.calls.find((call) => call.op === "create");
      expect(created?.options?.tools).toEqual(["mcp"]);
      expect(created?.options?.mcpServers["agent-native"]?.url).toBe("http://127.0.0.1:4817/api/mcp");
      expect(created?.options?.model).toEqual({ id: "composer-2" });
      expect(fake.calls.some((call) => call.op === "dispose")).toBe(true);
      expect(fake.calls.find((call) => call.op === "send")?.prompt?.startsWith(CURSOR_PREAMBLE)).toBe(true);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  it("resumes with inline mcp servers and falls back to create when the agent is unknown", async () => {
    const fake = install({ resumeFailures: 1 });
    const id = provider();
    await readStream(await POST(chatRequest(id, "第一轮", "thread-a")));
    await readStream(await POST(chatRequest(id, "第二轮", "thread-a")));
    await readStream(await POST(chatRequest(id, "第三轮", "thread-a")));
    const creates = fake.calls.filter((call) => call.op === "create");
    const resumes = fake.calls.filter((call) => call.op === "resume");
    expect(creates).toHaveLength(2);
    expect(resumes).toHaveLength(2);
    for (const call of [...creates, ...resumes]) {
      expect(call.options?.tools).toEqual(["mcp"]);
      expect(call.options?.mcpServers["agent-native"]?.url).toBe("http://127.0.0.1:4817/api/mcp");
    }
    const prompts = fake.calls.filter((call) => call.op === "send").map((call) => call.prompt ?? "");
    expect(prompts[0]?.startsWith(CURSOR_PREAMBLE)).toBe(true);
    expect(prompts[1]?.startsWith(CURSOR_PREAMBLE)).toBe(true);
    expect(prompts[2]?.includes(CURSOR_PREAMBLE)).toBe(false);
    expect(fake.calls.filter((call) => call.op === "dispose")).toHaveLength(3);
  });

  it("uses PUBLIC_BASE_URL for the MCP server", async () => {
    process.env.PUBLIC_BASE_URL = "https://public.example/app/";
    const fake = install({ events: [{ type: "assistant", message: { content: [{ type: "text", text: "好" }] } }] });
    await readStream(await POST(chatRequest(provider())));
    expect(fake.calls.find((call) => call.op === "create")?.options?.mcpServers["agent-native"]?.url).toBe(
      "https://public.example/app/api/mcp",
    );
  });

  it("maps auth, rate limit, and result errors without leaking the key", async () => {
    const auth = install({
      throwOnSend: { name: "AuthenticationError", message: `invalid ${KEY}`, isRetryable: false },
    });
    const authBody = await readStream(await POST(chatRequest(provider())));
    expect(authBody.text).toContain("Cursor API Key 无效或已过期，请到 模型设置 更新");
    expect(authBody.text).not.toContain(KEY);
    expect(auth.calls.some((call) => call.op === "dispose")).toBe(true);

    resetCursorSessionsForTests();
    install({ throwOnSend: { name: "RateLimitError", message: "quota" } });
    const rate = await readStream(await POST(chatRequest(provider(), "再试", "chat-rate")));
    expect(rate.text).toContain("Cursor 额度或频率受限，请稍后重试");
    expect(rate.text).not.toContain(KEY);

    resetCursorSessionsForTests();
    install({
      events: [{ type: "assistant", message: { content: [{ type: "text", text: KEY }] } }],
      waitStatus: "error",
      waitError: { code: "unauthenticated", message: KEY },
    });
    const result = await readStream(await POST(chatRequest(provider(), "第三", "chat-result")));
    expect(result.text).toContain("Cursor API Key 无效或已过期");
    expect(result.text).not.toContain(KEY);
  });

  it("does not call the SDK when the key is empty", async () => {
    const fake = install({});
    const body = await readStream(await POST(chatRequest(provider(""))));
    expect(body.text).toContain("Cursor API Key 无效或已过期");
    expect(fake.calls).toEqual([]);
  });

  it("cancels on abort and does not emit an error bubble", async () => {
    const controller = new AbortController();
    const fake = install({ hangUntilCancel: true, onSend: () => controller.abort() });
    const body = await readStream(await POST(chatRequest(provider(), "停", "chat-abort", controller.signal)));
    expect(fake.calls.some((call) => call.op === "cancel")).toBe(true);
    expect(body.chunks.some((chunk) => chunk.type === "error")).toBe(false);
    expect(fake.calls.some((call) => call.op === "dispose")).toBe(true);
  });

  it("cancels and reports a timeout", async () => {
    process.env.CURSOR_TIMEOUT_MS = "40";
    const fake = install({ hangUntilCancel: true });
    const body = await readStream(await POST(chatRequest(provider(), "慢", "chat-timeout")));
    expect(fake.calls.some((call) => call.op === "cancel")).toBe(true);
    expect(body.text).toContain("Cursor 智能体超时，已取消本次运行");
    expect(body.text).not.toContain(KEY);
  });

  it("maps a successful account probe and an auth failure", async () => {
    install({ me: { userEmail: "ada@example.com" }, models: ["composer-2", "auto"] });
    const id = provider();
    const ok = await testProvider(
      new Request(`http://local/api/providers/${id}/test`, { method: "POST" }),
      { params: Promise.resolve({ id }) },
    );
    const okBody = await ok.json() as { ok: boolean; message: string; models?: string[] };
    expect(okBody.ok).toBe(true);
    expect(okBody.message).toContain("a***@example.com");
    expect(okBody.message).not.toContain(KEY);
    expect(okBody.models).toEqual(["composer-2", "auto"]);

    setCursorSdkForTests(null);
    install({ meError: { name: "AuthenticationError", message: KEY } });
    const bad = await testProvider(
      new Request(`http://local/api/providers/${id}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: KEY }),
      }),
      { params: Promise.resolve({ id }) },
    );
    const badText = await bad.text();
    expect(badText).toContain("Cursor API Key 无效或已过期");
    expect(badText).not.toContain(KEY);
  });
});
