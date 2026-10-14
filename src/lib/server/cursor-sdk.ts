export interface CursorAgentOptions {
  apiKey: string;
  model: { id: string };
  local: { cwd: string };
  mcpServers: Record<string, { type: "http"; url: string; headers?: Record<string, string> }>;
  tools: string[];
}

export interface CursorRunHandle {
  readonly id: string;
  supports(operation: "stream" | "wait" | "cancel" | "conversation"): boolean;
  stream(): AsyncIterable<unknown>;
  wait(): Promise<{
    id?: string;
    status?: string;
    error?: { message?: string; code?: string };
  }>;
  cancel(): Promise<void>;
}

export interface CursorAgentHandle {
  readonly agentId: string;
  send(message: string): Promise<CursorRunHandle>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface CursorAccount {
  apiKeyName?: string;
  userEmail?: string;
  userFirstName?: string;
  userLastName?: string;
}

export interface CursorModelInfo {
  id: string;
  displayName?: string;
}

export interface CursorSdkFacade {
  Agent: {
    create(options: CursorAgentOptions): Promise<CursorAgentHandle>;
    resume(agentId: string, options?: Partial<CursorAgentOptions>): Promise<CursorAgentHandle>;
  };
  Cursor: {
    me(options?: { apiKey?: string }): Promise<CursorAccount>;
    models: {
      list(options?: { apiKey?: string }): Promise<CursorModelInfo[]>;
    };
  };
}

let testSdk: CursorSdkFacade | null = null;
let realSdk: CursorSdkFacade | null = null;

export function setCursorSdkForTests(sdk: CursorSdkFacade | null) {
  testSdk = sdk;
}

export async function getCursorSdk(): Promise<CursorSdkFacade> {
  if (testSdk) return testSdk;
  if (realSdk) return realSdk;
  realSdk = await loadRealSdk();
  return realSdk;
}

async function loadRealSdk(): Promise<CursorSdkFacade> {
  try {
    const sdk = await import("@cursor/sdk");
    return {
      Agent: {
        create: (options) => sdk.Agent.create(options as never) as Promise<CursorAgentHandle>,
        resume: (agentId, options) =>
          sdk.Agent.resume(agentId, options as never) as Promise<CursorAgentHandle>,
      },
      Cursor: {
        me: (options) => sdk.Cursor.me(options) as Promise<CursorAccount>,
        models: {
          list: async (options) => {
            const models = await sdk.Cursor.models.list(options);
            return models.map((item) => ({ id: item.id, displayName: item.displayName }));
          },
        },
      },
    };
  } catch {
    throw new Error("Cursor SDK 未能加载");
  }
}
