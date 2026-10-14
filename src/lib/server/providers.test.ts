import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, PUT } from "@/app/api/providers/[id]/route";
import { POST as testProvider } from "@/app/api/providers/[id]/test/route";
import { PUT as putDefault } from "@/app/api/providers/default/route";
import { GET, POST } from "@/app/api/providers/route";
import { ENV_CURSOR_PROVIDER_ID } from "@/lib/providers/public";
import { startMockLlm } from "../../../scripts/mock-llm";
import {
  createProvider,
  getStoredProvider,
  listProviders,
  providersPath,
  resetProvidersForTests,
  updateProvider,
} from "@/lib/server/providers";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: async () => undefined };
});

const SECRET = "sk-stage5-secret-key-9f3a";
const dir = mkdtempSync(path.join(tmpdir(), "providers-"));
const previous = {
  AGENT_DATA_DIR: process.env.AGENT_DATA_DIR,
  LLM_BASE_URL: process.env.LLM_BASE_URL,
  LLM_MODEL: process.env.LLM_MODEL,
  LLM_API_KEY: process.env.LLM_API_KEY,
  CURSOR_API_KEY: process.env.CURSOR_API_KEY,
  CURSOR_AUTH_TOKEN: process.env.CURSOR_AUTH_TOKEN,
};

function restoreEnv() {
  for (const key of ["AGENT_DATA_DIR", "LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"] as const) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearLlmEnv() {
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_API_KEY;
  delete process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_AUTH_TOKEN;
}

beforeEach(() => {
  process.env.AGENT_DATA_DIR = dir;
  clearLlmEnv();
  resetProvidersForTests();
});

afterAll(() => {
  restoreEnv();
  rmSync(dir, { recursive: true, force: true });
});

function request(url: string, method: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

async function read(response: Response) {
  const text = await response.text();
  expect(text).not.toContain(SECRET);
  return { status: response.status, text, data: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function captureLogs<T>(run: () => Promise<T>): Promise<T> {
  const logs: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const spies = methods.map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(
        args
          .map((item) => {
            if (typeof item === "string") return item;
            if (item instanceof Error) return `${item.name} ${item.message}`;
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
    return await run();
  } finally {
    for (const spy of spies) spy.mockRestore();
    expect(logs.join("\n")).not.toContain(SECRET);
  }
}

describe("provider store", () => {
  it("creates, masks, updates without replacing an empty key, and persists to disk", async () => {
    const created = createProvider({
      name: "本地",
      baseUrl: "http://127.0.0.1:4818/v1",
      model: "mock-model",
      apiKey: SECRET,
      headers: { "X-Title": "demo" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.provider.apiKeyMasked).toBe("sk-…9f3a");
    expect(created.provider.hasKey).toBe(true);
    expect(created.provider).not.toHaveProperty("apiKey");
    expect(created.provider).not.toHaveProperty("headers");
    expect(created.provider.headerNames).toEqual(["X-Title"]);
    expect(JSON.stringify(created.provider)).not.toContain(SECRET);
    expect(JSON.stringify(created.provider)).not.toContain("demo");
    expect(listProviders().defaultId).toBe(created.provider.id);

    const file = JSON.parse(readFileSync(providersPath(), "utf8")) as {
      providers: { apiKey: string; id: string }[];
    };
    expect(file.providers[0]?.apiKey).toBe(SECRET);

    const kept = updateProvider(created.provider.id, { name: "改名", apiKey: "  " });
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    expect(kept.provider.name).toBe("改名");
    expect(kept.provider.apiKeyMasked).toBe("sk-…9f3a");
    expect(getStoredProvider(created.provider.id)?.apiKey).toBe(SECRET);
    expect(getStoredProvider(created.provider.id)?.headers).toEqual({ "X-Title": "demo" });

    const omitted = updateProvider(created.provider.id, { model: "other-model" });
    expect(omitted.ok).toBe(true);
    expect(getStoredProvider(created.provider.id)?.apiKey).toBe(SECRET);
    expect(getStoredProvider(created.provider.id)?.headers).toEqual({ "X-Title": "demo" });
    if (omitted.ok) expect(omitted.provider.headerNames).toEqual(["X-Title"]);

    const listed = await read(await GET());
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.data)).toContain("sk-…9f3a");
    expect(JSON.stringify(listed.data)).not.toContain(SECRET);
  });

  it("exposes a read-only env provider and refuses to edit it", async () => {
    process.env.LLM_BASE_URL = "http://127.0.0.1:9/v1";
    process.env.LLM_MODEL = "env-model";
    process.env.LLM_API_KEY = SECRET;
    const listed = listProviders();
    expect(listed.defaultId).toBe("env");
    expect(listed.providers).toEqual([
      expect.objectContaining({
        id: "env",
        name: "环境变量",
        model: "env-model",
        readOnly: true,
        hasKey: true,
        apiKeyMasked: "sk-…9f3a",
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(SECRET);

    const created = createProvider({
      name: "文件",
      baseUrl: "https://example.com/v1",
      model: "m",
      apiKey: "",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(listProviders().defaultId).toBe("env");
    const stored = JSON.parse(readFileSync(providersPath(), "utf8")) as { providers: { id: string }[] };
    expect(stored.providers.map((item) => item.id)).toEqual([created.provider.id]);
    expect(JSON.stringify(stored)).not.toContain(SECRET);

    const denied = await read(
      await PUT(request("http://local/api/providers/env", "PUT", { name: "改" }), {
        params: Promise.resolve({ id: "env" }),
      }),
    );
    expect(denied.status).toBe(403);
    const removed = await read(
      await DELETE(request("http://local/api/providers/env", "DELETE"), {
        params: Promise.resolve({ id: "env" }),
      }),
    );
    expect(removed.status).toBe(403);
    expect(listProviders().providers.some((item) => item.id === "env")).toBe(true);
  });

  it("ignores an invalid env provider", () => {
    process.env.LLM_BASE_URL = "ftp://keys.example/v1";
    process.env.LLM_MODEL = "env-model";
    process.env.LLM_API_KEY = SECRET;
    expect(listProviders().providers).toEqual([]);
  });

  it("keeps the key out of error responses", async () => {
    await captureLogs(async () => {
      const badJson = await read(await POST(request("http://local/api/providers", "POST", `not-json ${SECRET}`)));
      expect(badJson.status).toBe(400);

      const invalid = await read(
        await POST(
          request("http://local/api/providers", "POST", {
            name: "坏地址",
            baseUrl: `http://user:${SECRET}@127.0.0.1/v1`,
            model: "m",
            apiKey: SECRET,
          }),
        ),
      );
      expect(invalid.status).toBe(422);

      writeFileSync(providersPath(), `{broken ${SECRET}`, "utf8");
      const broken = await read(await GET());
      expect(broken.status).toBe(500);
      expect(broken.text).toContain("模型配置无法读取");
    });
  });
});

describe("provider routes", () => {
  it("sets the default and probes without echoing a rejected key", async () => {
    const mock = await startMockLlm({ port: 0, key: "different-key" });
    const fallback = await startFallback(SECRET);
    try {
      await captureLogs(async () => {
        const created = await read(
          await POST(
            request("http://local/api/providers", "POST", {
              name: "Mock",
              baseUrl: mock.url,
              model: "mock-model",
              apiKey: SECRET,
            }),
          ),
        );
        expect(created.status).toBe(201);
        const provider = created.data.provider as { id: string; apiKeyMasked: string };
        expect(provider.apiKeyMasked).toBe("sk-…9f3a");

        const second = await read(
          await POST(
            request("http://local/api/providers", "POST", {
              name: "备用",
              baseUrl: "https://example.com/v1",
              model: "other",
            }),
          ),
        );
        const secondId = (second.data.provider as { id: string }).id;
        const made = await read(
          await putDefault(request("http://local/api/providers/default", "PUT", { id: secondId })),
        );
        expect(made.status).toBe(200);
        expect(made.data.defaultId).toBe(secondId);

        const rejected = await read(
          await testProvider(request(`http://local/api/providers/${provider.id}/test`, "POST", {}), {
            params: Promise.resolve({ id: provider.id }),
          }),
        );
        expect(rejected.status).toBe(200);
        expect(rejected.data.ok).toBe(false);
        expect(rejected.text).toContain("密钥被拒绝");

        const override = await read(
          await testProvider(
            request(`http://local/api/providers/${provider.id}/test`, "POST", {
              apiKey: SECRET,
              baseUrl: fallback.url,
            }),
            { params: Promise.resolve({ id: provider.id }) },
          ),
        );
        expect(override.data.ok).toBe(true);
        expect(override.text).toContain("连接成功");
        expect(getStoredProvider(provider.id)?.apiKey).toBe(SECRET);
        expect(getStoredProvider(provider.id)?.baseUrl).toBe(mock.url);

        const removed = await read(
          await DELETE(request(`http://local/api/providers/${provider.id}`, "DELETE"), {
            params: Promise.resolve({ id: provider.id }),
          }),
        );
        expect(removed.status).toBe(200);
        expect(removed.text).not.toContain(SECRET);
      });
    } finally {
      await mock.close();
      await fallback.close();
    }
  });

  it("keeps custom header values off every provider response and still sends them", async () => {
    const headerSecret = "SECRETHEADER123";
    const mock = await startMockLlm({ port: 0, key: "mock-key" });
    try {
      await captureLogs(async () => {
        const created = await read(
          await POST(
            request("http://local/api/providers", "POST", {
              name: "带请求头",
              baseUrl: mock.url,
              model: "mock-model",
              apiKey: "mock-key",
              headers: { "x-api-key": headerSecret },
            }),
          ),
        );
        expect(created.status).toBe(201);
        const provider = created.data.provider as { id: string; headerNames: string[] };
        expect(provider.headerNames).toEqual(["x-api-key"]);
        expect(created.text).not.toContain(headerSecret);
        expect(created.text).not.toContain('"headers"');

        const listed = await read(await GET());
        expect(listed.text).not.toContain(headerSecret);
        expect(listed.text).toContain("x-api-key");

        const renamed = await read(
          await PUT(request(`http://local/api/providers/${provider.id}`, "PUT", { name: "改名" }), {
            params: Promise.resolve({ id: provider.id }),
          }),
        );
        expect(renamed.status).toBe(200);
        expect(renamed.text).not.toContain(headerSecret);
        expect((renamed.data.provider as { headerNames: string[] }).headerNames).toEqual(["x-api-key"]);
        expect(getStoredProvider(provider.id)?.headers).toEqual({ "x-api-key": headerSecret });

        const direct = await fetch(`${mock.url}/models`, {
          headers: { authorization: "Bearer mock-key", "x-api-key": headerSecret },
        });
        expect(direct.headers.get("x-mock-saw-x-api-key")).toBe("yes");
        expect(await direct.text()).not.toContain(headerSecret);

        const probed = await read(
          await testProvider(request(`http://local/api/providers/${provider.id}/test`, "POST", {}), {
            params: Promise.resolve({ id: provider.id }),
          }),
        );
        expect(probed.status).toBe(200);
        expect(probed.data.ok).toBe(true);
        expect(probed.text).not.toContain(headerSecret);
        expect(mock.calls.some((call) => call.sawXApiKey)).toBe(true);

        const failed = await read(
          await testProvider(
            request(`http://local/api/providers/${provider.id}/test`, "POST", { apiKey: "wrong-key-zzzz" }),
            { params: Promise.resolve({ id: provider.id }) },
          ),
        );
        expect(failed.data.ok).toBe(false);
        expect(failed.text).not.toContain(headerSecret);
        expect(failed.text).toContain("密钥被拒绝");

        const cleared = await read(
          await PUT(request(`http://local/api/providers/${provider.id}`, "PUT", { headers: {} }), {
            params: Promise.resolve({ id: provider.id }),
          }),
        );
        expect(cleared.text).not.toContain(headerSecret);
        expect((cleared.data.provider as { headerNames: string[] }).headerNames).toEqual([]);
        expect(getStoredProvider(provider.id)?.headers).toBeUndefined();
      });
    } finally {
      await mock.close();
    }
  });
});

describe("cursor providers", () => {
  const cursorKey = "cursor_test_KEY_should_not_leak_zz91";

  it("stores a cursor provider without a base URL and keeps an omitted key", async () => {
    const created = createProvider({ kind: "cursor", name: "Cursor", apiKey: cursorKey });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.provider).toMatchObject({
      kind: "cursor",
      model: "composer-2",
      baseUrl: "",
      headerNames: [],
      hasKey: true,
    });
    expect(created.provider.apiKeyMasked.endsWith(cursorKey.slice(-4))).toBe(true);
    const listed = await read(await GET());
    expect(JSON.stringify(listed.data)).not.toContain(cursorKey);
    const kept = updateProvider(created.provider.id, { name: "Cursor 二", apiKey: "" });
    expect(kept.ok).toBe(true);
    expect(getStoredProvider(created.provider.id)?.apiKey).toBe(cursorKey);
    const switched = updateProvider(created.provider.id, { kind: "openai-compatible" });
    expect(switched.ok).toBe(false);
    if (!switched.ok) expect(switched.error).toContain("请填写 Base URL");
    const rejected = createProvider({
      kind: "cursor",
      name: "坏",
      baseUrl: "https://example.com/v1",
      model: "composer-2",
      apiKey: cursorKey,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain("不使用 Base URL");
    const headers = createProvider({
      kind: "cursor",
      name: "头",
      model: "auto",
      apiKey: cursorKey,
      headers: { "X-Title": "nope" },
    });
    expect(headers.ok).toBe(false);
    if (!headers.ok) expect(headers.error).toContain("不使用自定义请求头");
  });

  it("migrates records that have no kind", () => {
    writeFileSync(
      providersPath(),
      JSON.stringify({
        defaultId: "old",
        providers: [{
          id: "old",
          name: "旧",
          baseUrl: "https://example.com/v1",
          apiKey: SECRET,
          model: "m",
          createdAt: "2020-01-01T00:00:00.000Z",
        }],
      }),
    );
    expect(listProviders().providers[0]).toMatchObject({ id: "old", kind: "openai-compatible" });
    const updated = updateProvider("old", { name: "新" });
    expect(updated.ok).toBe(true);
    const stored = JSON.parse(readFileSync(providersPath(), "utf8")) as { providers: { kind: string }[] };
    expect(stored.providers[0]?.kind).toBe("openai-compatible");
  });

  it("exposes a read-only env-cursor provider", async () => {
    process.env.CURSOR_API_KEY = cursorKey;
    const listed = listProviders();
    expect(listed.defaultId).toBe(ENV_CURSOR_PROVIDER_ID);
    expect(listed.providers[0]).toMatchObject({
      id: ENV_CURSOR_PROVIDER_ID,
      kind: "cursor",
      name: "Cursor（环境变量）",
      model: "composer-2",
      readOnly: true,
      baseUrl: "",
    });
    expect(JSON.stringify(listed)).not.toContain(cursorKey);
    const denied = await read(
      await PUT(request("http://local/api/providers/env-cursor", "PUT", { name: "改" }), {
        params: Promise.resolve({ id: "env-cursor" }),
      }),
    );
    expect(denied.status).toBe(403);
    expect(denied.text).not.toContain(cursorKey);
    const removed = await read(
      await DELETE(request("http://local/api/providers/env-cursor", "DELETE"), {
        params: Promise.resolve({ id: "env-cursor" }),
      }),
    );
    expect(removed.status).toBe(403);
  });
});

function startFallback(secret: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname.endsWith("/models")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "no models", authorization: request.headers.authorization, secret }));
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/chat/completions")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "ok", choices: [], echoed: request.headers.authorization }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}
