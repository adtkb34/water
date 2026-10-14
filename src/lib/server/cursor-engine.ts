import { mkdirSync } from "node:fs";
import path from "node:path";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import { latestUserPrompt } from "@/lib/server/cursor-prompt";
import { classifyCursorFailure, cursorErrorText, cursorFailureMessage, isUnknownCursorAgent, maskCursorAccount } from "@/lib/server/cursor-errors";
import { closeCursorText, createCursorMapState, mapCursorEvent } from "@/lib/server/cursor-map";
import { cursorMcpUrl } from "@/lib/server/cursor-origin";
import { getCursorSdk, type CursorAgentHandle, type CursorAgentOptions, type CursorRunHandle } from "@/lib/server/cursor-sdk";
import { providerSecrets, type StoredProvider } from "@/lib/server/providers";
import { redactSecrets } from "@/lib/server/redact";

const agents = cursorAgentMap();

function cursorAgentMap(): Map<string, string> {
  const holder = globalThis as { __agentNativeCursorAgents?: Map<string, string> };
  if (!holder.__agentNativeCursorAgents) holder.__agentNativeCursorAgents = new Map();
  return holder.__agentNativeCursorAgents;
}

export function resetCursorSessionsForTests() {
  agents.clear();
}

export function cursorTimeoutMs(): number {
  const raw = process.env.CURSOR_TIMEOUT_MS?.trim();
  if (!raw) return 120_000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return 120_000;
  return Math.floor(value);
}

export async function probeCursorAccount(apiKey: string): Promise<{
  ok: boolean;
  message: string;
  latencyMs: number;
  models?: string[];
}> {
  const started = Date.now();
  const secrets = [apiKey];
  if (!apiKey.trim()) {
    return {
      ok: false,
      message: cursorFailureMessage("auth", false),
      latencyMs: Date.now() - started,
    };
  }
  try {
    const sdk = await getCursorSdk();
    const account = await sdk.Cursor.me({ apiKey });
    let models: string[] | undefined;
    try {
      const listed = await sdk.Cursor.models.list({ apiKey });
      models = listed.map((item) => item.id).filter((id) => id.length > 0);
    } catch {
      models = undefined;
    }
    return {
      ok: true,
      message: redactSecrets(`已连接 ${maskCursorAccount(account)}`, secrets),
      latencyMs: Date.now() - started,
      ...(models ? { models } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      message: cursorErrorText(error, secrets),
      latencyMs: Date.now() - started,
    };
  }
}

export function runCursorChat(options: {
  request: Request;
  provider: StoredProvider;
  messages: UIMessage[];
  chatId: string;
}): Response {
  const secrets = providerSecrets(options.provider);
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const write = (chunk: { type: string; [key: string]: unknown }) => {
        writer.write(chunk as never);
      };
      try {
        await executeCursorTurn({ ...options, secrets, write });
      } catch (error) {
        write({ type: "error", errorText: cursorErrorText(error, secrets) });
      }
    },
    onError: (error) => cursorErrorText(error, secrets),
  });
  return createUIMessageStreamResponse({ stream });
}

async function executeCursorTurn(options: {
  request: Request;
  provider: StoredProvider;
  messages: UIMessage[];
  chatId: string;
  secrets: string[];
  write: (chunk: { type: string; [key: string]: unknown }) => void;
}) {
  const { request, provider, secrets, write } = options;
  write({ type: "start" });
  if (!provider.apiKey.trim()) {
    write({ type: "error", errorText: cursorFailureMessage("auth", false) });
    write({ type: "finish" });
    return;
  }

  let mcpUrl = "";
  try {
    mcpUrl = cursorMcpUrl(request);
  } catch (error) {
    write({ type: "error", errorText: cursorErrorText(error, secrets) });
    write({ type: "finish" });
    return;
  }

  const persist = options.chatId.trim().length > 0;
  const chatId = safeChatId(options.chatId);
  const cwd = ensureWorkdir(persist ? chatId : `once-${crypto.randomUUID()}`);
  const agentOptions: CursorAgentOptions = {
    apiKey: provider.apiKey,
    model: { id: provider.model.trim() || "composer-2" },
    local: { cwd },
    mcpServers: { "agent-native": { type: "http", url: mcpUrl } },
    tools: ["mcp"],
  };

  let agent: CursorAgentHandle | undefined;
  let run: CursorRunHandle | undefined;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const remembered = persist ? agents.get(chatId) : undefined;
  let firstTurn = !remembered;

  const cancelRun = () => {
    if (run?.supports("cancel")) void run.cancel().catch(() => undefined);
  };
  const onAbort = () => cancelRun();
  request.signal.addEventListener("abort", onAbort);

  try {
    const sdk = await getCursorSdk();
    if (remembered) {
      try {
        agent = await sdk.Agent.resume(remembered, agentOptions);
        firstTurn = false;
      } catch (error) {
        if (!isUnknownCursorAgent(error)) throw error;
        if (persist) agents.delete(chatId);
        agent = undefined;
        firstTurn = true;
      }
    }
    if (!agent) {
      agent = await sdk.Agent.create(agentOptions);
      if (persist) agents.set(chatId, agent.agentId);
    }
    const prompt = latestUserPrompt(options.messages, firstTurn);
    run = await agent.send(prompt);
    if (request.signal.aborted) cancelRun();
    timer = setTimeout(() => {
      timedOut = true;
      cancelRun();
    }, cursorTimeoutMs());

    const state = createCursorMapState(secrets);
    const eventTypes: string[] = [];
    if (run.supports("stream")) {
      for await (const event of run.stream()) {
        const record = event && typeof event === "object" ? (event as { type?: unknown }) : {};
        const eventType = typeof record.type === "string" ? record.type : "unknown";
        eventTypes.push(eventType);
        debugEvent(event, secrets);
        if (request.signal.aborted || timedOut) break;
        const before = state.forbidden.length;
        for (const chunk of mapCursorEvent(state, event)) write(chunk);
        for (const name of state.forbidden.slice(before)) {
          console.warn(`cursor ignored non-business tool: ${redactSecrets(name, secrets)}`);
        }
      }
    }
    for (const chunk of closeCursorText(state)) write(chunk);
    console.info(`cursor-event-types ${eventTypes.join(",")}`);

    const result = await run.wait();
    if (request.signal.aborted) return;
    if (timedOut) {
      write({ type: "error", errorText: redactSecrets(cursorFailureMessage("timeout", true), secrets) });
      return;
    }
    if (result.status === "error") {
      const classified = classifyCursorFailure({
        message: result.error?.message ?? "",
        code: result.error?.code ?? "",
      });
      write({
        type: "error",
        errorText: redactSecrets(cursorFailureMessage(classified.kind, classified.isRetryable), secrets),
      });
    }
  } catch (error) {
    if (request.signal.aborted) return;
    if (timedOut) {
      write({ type: "error", errorText: redactSecrets(cursorFailureMessage("timeout", true), secrets) });
      return;
    }
    write({ type: "error", errorText: cursorErrorText(error, secrets) });
  } finally {
    if (timer) clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
    write({ type: "finish" });
    if (agent) {
      try {
        await agent[Symbol.asyncDispose]();
      } catch (error) {
        console.warn(`cursor agent dispose failed: ${cursorErrorText(error, secrets)}`);
      }
    }
  }
}

function debugEvent(event: unknown, secrets: readonly string[]) {
  if (process.env.CURSOR_DEBUG !== "1") return;
  let raw = "";
  try {
    raw = JSON.stringify(event);
  } catch {
    raw = String(event);
  }
  console.debug(redactSecrets(raw, secrets));
}

function safeChatId(chatId: string): string {
  const safe = chatId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  return safe || "anonymous";
}

function ensureWorkdir(chatId: string): string {
  const root = process.env.AGENT_DATA_DIR?.trim() || path.join(process.cwd(), "data");
  const dir = path.join(root, "cursor-workdirs", chatId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
