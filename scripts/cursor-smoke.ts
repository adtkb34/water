/**
 * 用真实 Cursor API Key 打一轮对话，核对 UI 消息流里出现了我们的工具。
 *
 * 用法：
 *   CURSOR_API_KEY=... npm run cursor:smoke
 * 已有服务时设置 BASE_URL（默认 http://127.0.0.1:4817），否则脚本会自己启动并在结束时关掉。
 * 密钥不会打印；最多显示前 6 个字符。CURSOR_DEBUG=1 时，本脚本启动的服务会把脱敏后的原始事件打到标准错误。
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { knownCursorToolNames } from "@/lib/server/cursor-tools";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:4817";
const key = process.env.CURSOR_API_KEY?.trim() ?? "";

class SmokeError extends Error {}

function fail(message: string): never {
  throw new SmokeError(message);
}

if (!key) {
  console.error("缺少 CURSOR_API_KEY。请在 https://cursor.com/dashboard/cloud-agents 创建个人 API Key，然后执行：CURSOR_API_KEY=你的密钥 npm run cursor:smoke");
  process.exit(1);
}

const prefix = key.slice(0, 6);
let serverLog = "";
let startedHere = false;
let devProcess: ChildProcess | undefined;
let providerId = "";

function clip(text: string, max = 500) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
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
  const env: NodeJS.ProcessEnv = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };
  delete env.CURSOR_AUTH_TOKEN;
  const child = spawn("npm", ["run", "dev"], {
    cwd: root,
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk: Buffer) => {
    const text = chunk.toString();
    serverLog += text;
    if (serverLog.length > 400_000) serverLog = serverLog.slice(-200_000);
    if (process.env.CURSOR_DEBUG === "1") process.stderr.write(text);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return child;
}

async function waitReady(child: ChildProcess) {
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    if (child.exitCode !== null) fail(`开发服务已退出 ${child.exitCode}：${clip(serverLog, 800)}`);
    if (await reachable()) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  fail(`等待 ${baseUrl} 超时：${clip(serverLog, 800)}`);
}

async function stopDev(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
}

async function request(pathname: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const text = await response.text();
  if (text.includes(key)) fail("接口响应里出现了 API Key");
  return { status: response.status, text, json: text ? safeJson(text) : null };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function chunksOf(text: string): Record<string, unknown>[] {
  const chunks: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const parsed = safeJson(payload);
    if (parsed && typeof parsed === "object") chunks.push(parsed as Record<string, unknown>);
  }
  return chunks;
}

async function main() {
  console.log(`Cursor 冒烟：密钥前缀 ${prefix}，地址 ${baseUrl}`);
  if (!(await reachable())) {
    startedHere = true;
    devProcess = startDev();
    await waitReady(devProcess);
    console.log("已启动开发服务");
  } else {
    console.log("使用已经在运行的服务。原始事件类型请看该服务的标准输出（本脚本启动服务时会摘录 cursor-event-types）。");
  }

  const created = await request("/api/providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "cursor",
      name: `cursor-smoke-${Date.now()}`,
      model: process.env.CURSOR_SMOKE_MODEL?.trim() || "composer-2",
      apiKey: key,
    }),
  });
  const createdBody = created.json as { provider?: { id?: string }; error?: string } | null;
  providerId = createdBody?.provider?.id ?? "";
  if (created.status !== 200 || !providerId) {
    fail(`注册临时 Cursor 提供方失败 ${created.status} ${clip(created.text)}`);
  }

  const chat = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      providerId,
      chatId: `smoke-${Date.now()}`,
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "查看现有的询价单" }] }],
    }),
    signal: AbortSignal.timeout(150_000),
  });
  const text = await chat.text();
  if (text.includes(key)) fail("对话流里出现了 API Key");
  if (chat.status !== 200) fail(`对话失败 ${chat.status} ${clip(text)}`);

  const chunks = chunksOf(text);
  const transcript: string[] = [];
  const tools: string[] = [];
  let errorText = "";
  for (const chunk of chunks) {
    if (chunk.type === "text-delta" && typeof chunk.delta === "string") transcript.push(chunk.delta);
    if (chunk.type === "tool-input-available" && typeof chunk.toolName === "string") {
      tools.push(chunk.toolName);
      transcript.push(`\n[工具 ${chunk.toolName} 开始]\n`);
    }
    if (chunk.type === "tool-output-available") transcript.push("[工具完成]\n");
    if (chunk.type === "tool-output-error") transcript.push(`[工具失败 ${String(chunk.errorText ?? "")}]\n`);
    if (chunk.type === "error" && typeof chunk.errorText === "string") errorText = chunk.errorText;
  }
  console.log("--- 对话记录 ---");
  console.log(transcript.join("") || "（没有文本或工具）");
  console.log("--- 工具 ---");
  console.log(tools.length > 0 ? tools.join(", ") : "（没有）");
  const eventLine = serverLog.split("\n").filter((line) => line.includes("cursor-event-types")).at(-1);
  if (eventLine) console.log(eventLine.trim());
  else if (!startedHere) console.log("未捕获 cursor-event-types（服务不是本脚本启动的）");
  else console.log("日志里没有 cursor-event-types");

  const known = knownCursorToolNames();
  const ours = tools.filter((name) => known.has(name));
  if (errorText) fail(`流以错误结束：${errorText}`);
  if (ours.length === 0) fail("没有调用我们的 MCP 工具");
  console.log(`通过：调用了 ${ours.join(", ")}`);
}

let code = 0;
try {
  await main();
} catch (error: unknown) {
  code = 1;
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.includes(key) ? "冒烟失败（已隐藏密钥）" : clip(message, 800));
} finally {
  if (providerId) {
    await fetch(`${baseUrl}/api/providers/${providerId}`, { method: "DELETE" }).catch(() => undefined);
  }
  if (startedHere && devProcess) await stopDev(devProcess);
}
process.exit(code);
