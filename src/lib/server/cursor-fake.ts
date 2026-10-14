import type {
  CursorAccount,
  CursorAgentHandle,
  CursorAgentOptions,
  CursorModelInfo,
  CursorRunHandle,
  CursorSdkFacade,
} from "@/lib/server/cursor-sdk";

export interface FakeCursorCall {
  op: "create" | "resume" | "send" | "dispose" | "cancel" | "me" | "models";
  agentId?: string;
  prompt?: string;
  options?: CursorAgentOptions;
}

export interface FakeCursorScript {
  events?: unknown[];
  waitStatus?: "finished" | "error" | "cancelled";
  waitError?: { message?: string; code?: string };
  throwOnSend?: unknown;
  throwOnResume?: unknown;
  resumeFailures?: number;
  throwOnCreate?: unknown;
  hangUntilCancel?: boolean;
  supportsCancel?: boolean;
  me?: CursorAccount;
  meError?: unknown;
  models?: string[];
  modelsError?: unknown;
  onSend?: () => void;
}

export interface FakeCursorSdk {
  sdk: CursorSdkFacade;
  calls: FakeCursorCall[];
}

export function createFakeCursorSdk(script: FakeCursorScript = {}): FakeCursorSdk {
  const calls: FakeCursorCall[] = [];
  let seq = 0;
  let resumeFailuresLeft = script.resumeFailures ?? 0;
  const agents = new Map<string, CursorAgentOptions>();

  function runHandle(agentId: string): CursorRunHandle {
    let cancelled = false;
    const waiters: Array<() => void> = [];
    const release = () => {
      for (const waiter of waiters) waiter();
      waiters.length = 0;
    };
    return {
      id: `${agentId}-run`,
      supports(operation) {
        if (operation === "cancel") return script.supportsCancel !== false;
        return operation === "stream" || operation === "wait";
      },
      async *stream() {
        if (script.hangUntilCancel) {
          if (!cancelled) await new Promise<void>((resolve) => waiters.push(resolve));
          return;
        }
        for (const event of script.events ?? []) {
          if (cancelled) return;
          yield event;
        }
      },
      async wait() {
        return {
          id: `${agentId}-run`,
          status: cancelled ? "cancelled" : script.waitStatus ?? "finished",
          ...(script.waitError ? { error: script.waitError } : {}),
        };
      },
      async cancel() {
        calls.push({ op: "cancel", agentId });
        cancelled = true;
        release();
      },
    };
  }

  function handle(agentId: string, options: CursorAgentOptions): CursorAgentHandle {
    agents.set(agentId, options);
    return {
      agentId,
      async send(prompt: string) {
        calls.push({ op: "send", agentId, prompt, options });
        script.onSend?.();
        if (script.throwOnSend) throw script.throwOnSend;
        return runHandle(agentId);
      },
      async [Symbol.asyncDispose]() {
        calls.push({ op: "dispose", agentId });
      },
    };
  }

  const sdk: CursorSdkFacade = {
    Agent: {
      async create(options) {
        calls.push({ op: "create", options });
        if (script.throwOnCreate) throw script.throwOnCreate;
        seq += 1;
        const agentId = `agent-${seq}`;
        return handle(agentId, options);
      },
      async resume(agentId, options) {
        const full = { ...(agents.get(agentId) ?? {}), ...(options ?? {}) } as CursorAgentOptions;
        calls.push({ op: "resume", agentId, options: full });
        if (script.throwOnResume) throw script.throwOnResume;
        if (resumeFailuresLeft > 0) {
          resumeFailuresLeft -= 1;
          const error = new Error("agent not found");
          error.name = "AgentNotFoundError";
          throw error;
        }
        return handle(agentId, full);
      },
    },
    Cursor: {
      async me(options) {
        calls.push({ op: "me", options: options as CursorAgentOptions | undefined });
        if (script.meError) throw script.meError;
        return script.me ?? { userEmail: "ada@example.com", apiKeyName: "personal" };
      },
      models: {
        async list(options) {
          calls.push({ op: "models", options: options as CursorAgentOptions | undefined });
          if (script.modelsError) throw script.modelsError;
          const ids = script.models ?? ["composer-2", "auto"];
          return ids.map((id): CursorModelInfo => ({ id }));
        },
      },
    },
  };

  return { sdk, calls };
}
