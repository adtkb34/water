import { afterEach, describe, expect, it } from "vitest";
import { cursorMcpUrl, publicOrigin } from "@/lib/server/cursor-origin";

const previous = process.env.PUBLIC_BASE_URL;

afterEach(() => {
  if (previous === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = previous;
});

describe("cursor MCP origin", () => {
  it("uses the request origin and prefers PUBLIC_BASE_URL", () => {
    delete process.env.PUBLIC_BASE_URL;
    const request = new Request("http://127.0.0.1:4817/api/chat", {
      headers: { "x-forwarded-host": "bench.example", "x-forwarded-proto": "https" },
    });
    expect(publicOrigin(request)).toBe("https://bench.example");
    expect(cursorMcpUrl(request)).toBe("https://bench.example/api/mcp");

    const plain = new Request("http://127.0.0.1:4817/api/chat");
    expect(cursorMcpUrl(plain)).toBe("http://127.0.0.1:4817/api/mcp");

    process.env.PUBLIC_BASE_URL = "https://public.example/workbench/";
    expect(cursorMcpUrl(plain)).toBe("https://public.example/workbench/api/mcp");
  });

  it("rejects an unsafe PUBLIC_BASE_URL", () => {
    process.env.PUBLIC_BASE_URL = "https://user:secret@public.example";
    expect(() => publicOrigin(new Request("http://127.0.0.1:4817/api/chat"))).toThrow(/不能包含账号或密码/);
  });
});
