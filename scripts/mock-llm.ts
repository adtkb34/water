import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

export interface MockHeaderRule {
  name: string;
  value: string;
  models: string[];
}

export interface MockLlmOptions {
  port?: number;
  host?: string;
  key?: string;
  requiredHeader?: MockHeaderRule;
}

export interface MockLlmCall {
  method: string;
  pathname: string;
  authorization: string;
  sawXApiKey: boolean;
  headers: Record<string, string>;
  body?: unknown;
}

export interface MockLlmHandle {
  port: number;
  url: string;
  calls: MockLlmCall[];
  close: () => Promise<void>;
}

interface ChatMessage {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
}

type MockReply =
  | { kind: "error"; status: number; body: Record<string, unknown> }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; arguments: Record<string, unknown> };

const FAKE_ACTOR = { kind: "human", surface: "workbench" };

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const record = part as { text?: unknown; content?: unknown };
        if (typeof record.text === "string") return record.text;
        if (typeof record.content === "string") return record.content;
        return "";
      })
      .join("");
  }
  if (content && typeof content === "object") return JSON.stringify(content);
  return "";
}

function lastUserIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

function summarizeTool(raw: string): string {
  try {
    const data = JSON.parse(raw) as {
      status?: unknown;
      summary?: unknown;
      approvalId?: unknown;
    };
    const summary = typeof data.summary === "string" ? data.summary : "";
    if (data.status === "pending_approval") {
      const approval = typeof data.approvalId === "string" && data.approvalId ? `审批号 ${data.approvalId}` : "";
      return `操作尚未执行，需要人工审核。${summary}${approval ? ` ${approval}` : ""}`.trim();
    }
    if (data.status === "rejected") return `操作被拒绝。${summary}`.trim();
    if (data.status === "executed") return `操作已执行。${summary}`.trim();
    return summary || raw.slice(0, 200);
  } catch {
    return raw.slice(0, 200);
  }
}

function readJsonObject(text: string): string | null {
  if (text[0] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(0, index + 1);
    }
  }
  return null;
}

/** 用户消息中的 `[[call:<tool_name>:<json>]]` 会原样变成一次工具调用。json 必须是对象。 */
export function scriptedToolCall(
  userText: string,
): { name: string; arguments: Record<string, unknown> } | null {
  const marker = "[[call:";
  const at = userText.lastIndexOf(marker);
  if (at < 0) return null;
  const rest = userText.slice(at + marker.length);
  const split = rest.indexOf(":");
  if (split <= 0) return null;
  const name = rest.slice(0, split);
  if (!/^[A-Za-z0-9_]+$/.test(name)) return null;
  const jsonStart = rest.indexOf("{", split + 1);
  if (jsonStart < 0) return null;
  const json = readJsonObject(rest.slice(jsonStart));
  if (!json) return null;
  if (!rest.slice(jsonStart + json.length).trimStart().startsWith("]]")) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return { name, arguments: parsed as Record<string, unknown> };
  } catch {
    return null;
  }
}

export function decideReply(messages: ChatMessage[]): MockReply {
  const userIndex = lastUserIndex(messages);
  const userText = userIndex >= 0 ? textOf(messages[userIndex]?.content) : "";
  if (userText.includes("触发错误")) {
    return { kind: "error", status: 500, body: { error: "triggered" } };
  }
  const toolMessages = messages.slice(userIndex + 1).filter((message) => message.role === "tool");
  if (toolMessages.length > 0) {
    const latest = toolMessages[toolMessages.length - 1];
    return { kind: "text", text: summarizeTool(textOf(latest?.content)) };
  }
  if (userText.includes("[[call:")) {
    const scripted = scriptedToolCall(userText);
    if (!scripted) {
      return { kind: "text", text: "脚本指令无法解析。格式是 [[call:<tool_name>:<json>]]。" };
    }
    return { kind: "tool", name: scripted.name, arguments: scripted.arguments };
  }
  if (userText.includes("新建产品") || (userText.includes("新建") && userText.includes("产品"))) {
    return {
      kind: "tool",
      name: "show_form",
      arguments: { capabilityId: "product.create", actor: FAKE_ACTOR },
    };
  }
  if (userText.includes("发布询价")) {
    const inquiryId = userText.match(/Q-\d+/)?.[0];
    if (!inquiryId) return { kind: "text", text: "请提供要发布的询价单编号。" };
    return {
      kind: "tool",
      name: "inquiry_publish",
      arguments: { inquiryId, actor: FAKE_ACTOR },
    };
  }
  if (userText.includes("确认中标")) {
    const inquiryId = userText.match(/Q-\d+/)?.[0];
    const supplierId = userText.match(/S-\d+/)?.[0];
    const price = userText.match(/价格\s*([0-9]+(?:\.[0-9]+)?)/)?.[1];
    if (!inquiryId || !supplierId || price === undefined) {
      return { kind: "text", text: "请提供询价单编号、供应商编号和价格。" };
    }
    return {
      kind: "tool",
      name: "inquiry_award",
      arguments: { inquiryId, supplierId, price: Number(price), actor: FAKE_ACTOR },
    };
  }
  return { kind: "text", text: "请说明要办的事，例如新建产品、发布询价或确认中标。" };
}

function completionBody(reply: Extract<MockReply, { kind: "text" | "tool" }>) {
  if (reply.kind === "text") {
    return {
      id: "chatcmpl-mock",
      object: "chat.completion",
      created: 0,
      model: "mock-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: reply.text },
          finish_reason: "stop",
        },
      ],
    };
  }
  return {
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: 0,
    model: "mock-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_mock",
              type: "function",
              function: {
                name: reply.name,
                arguments: JSON.stringify(reply.arguments),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function streamChunks(reply: Extract<MockReply, { kind: "text" | "tool" }>): unknown[] {
  const base = {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock-model",
  };
  if (reply.kind === "text") {
    return [
      { ...base, choices: [{ index: 0, delta: { role: "assistant", content: reply.text }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
  }
  return [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_mock",
                type: "function",
                function: {
                  name: reply.name,
                  arguments: JSON.stringify(reply.arguments),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}

function headerValue(request: IncomingMessage, name: string): string {
  const raw = request.headers[name.toLowerCase()];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.find((item) => item.length > 0) ?? "";
  return "";
}

function flatHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers[key] = value;
    else if (Array.isArray(value)) headers[key] = value.join(", ");
  }
  return headers;
}

function sawXApiKey(request: IncomingMessage): boolean {
  return headerValue(request, "x-api-key").length > 0;
}

function markXApiKey(response: ServerResponse, saw: boolean) {
  response.setHeader("x-mock-saw-x-api-key", saw ? "yes" : "no");
  if (saw) {
    process.stdout.write("mock x-api-key: yes\n");
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sendSse(response: ServerResponse, chunks: unknown[]) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.write("data: [DONE]\n\n");
  response.end();
}

function authorized(request: IncomingMessage, key: string | undefined): boolean {
  if (!key) return true;
  return request.headers.authorization === `Bearer ${key}`;
}

export function startMockLlm(options: MockLlmOptions = {}): Promise<MockLlmHandle> {
  const key = options.key;
  const requiredHeader = options.requiredHeader;
  const calls: MockLlmCall[] = [];
  const server = createServer((request, response) => {
    void handle(request, response, key, requiredHeader, calls);
  });
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      resolve({
        port: actual,
        url: `http://${host}:${actual}/v1`,
        calls,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  key: string | undefined,
  requiredHeader: MockHeaderRule | undefined,
  calls: MockLlmCall[],
) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const saw = sawXApiKey(request);
  markXApiKey(response, saw);
  const record = (body?: unknown) => {
    calls.push({
      method: request.method ?? "GET",
      pathname,
      authorization: request.headers.authorization ?? "",
      sawXApiKey: saw,
      headers: flatHeaders(request),
      ...(body === undefined ? {} : { body }),
    });
  };
  if (!authorized(request, key)) {
    record();
    sendJson(response, 401, {
      error: "unauthorized",
      authorization: request.headers.authorization ?? "",
    });
    return;
  }
  if (request.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
    record();
    sendJson(response, 200, {
      object: "list",
      data: [{ id: "mock-model", object: "model", owned_by: "mock" }],
    });
    return;
  }
  if (request.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/chat/completions")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(request));
    } catch {
      sendJson(response, 400, { error: "invalid json" });
      return;
    }
    const body = parsed as { messages?: ChatMessage[]; stream?: boolean; model?: unknown };
    record(parsed);
    const requestedModel = typeof body.model === "string" ? body.model : "";
    if (
      requiredHeader &&
      requiredHeader.models.includes(requestedModel) &&
      headerValue(request, requiredHeader.name) !== requiredHeader.value
    ) {
      sendJson(response, 401, { error: "missing required header" });
      return;
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const reply = decideReply(messages);
    if (reply.kind === "error") {
      sendJson(response, reply.status, {
        ...reply.body,
        authorization: request.headers.authorization ?? "",
      });
      return;
    }
    if (body.stream) {
      sendSse(response, streamChunks(reply));
      return;
    }
    sendJson(response, 200, completionBody(reply));
    return;
  }
  sendJson(response, 404, { error: "not found" });
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const key = process.env.MOCK_LLM_KEY === undefined ? "mock-key" : process.env.MOCK_LLM_KEY;
  const port = Number(process.env.MOCK_LLM_PORT ?? 4818);
  startMockLlm({ port, key: key || undefined })
    .then((handle) => {
      process.stdout.write(`mock llm listening on ${handle.url}\n`);
      process.stdout.write("scripted tool call: [[call:<tool_name>:<json>]]\n");
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "mock llm failed";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
