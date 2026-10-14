import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/mcp/route";
import { capabilities } from "@/lib/contract/registry";
import { toolNameForCapability, WIDGET_RESOURCE_URI } from "@/lib/mcp/names";
import { originFromRequestInfo } from "@/lib/mcp/origin";
import { createMcpServer } from "@/lib/mcp/server";
import { WIDGET_HTML_PATH, WIDGET_MISSING_MESSAGE } from "@/lib/mcp/widget-file";

interface ToolMeta {
  ui?: { resourceUri?: string; visibility?: string[] };
  "openai/outputTemplate"?: string;
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: {
    kind?: string;
    status?: string;
    mcpToolName?: string;
    workbenchUrl?: string;
    uiSpec?: { capabilityId?: string; fields?: { name?: string }[] };
    prefill?: Record<string, unknown>;
    capabilities?: { id?: string; hasUi?: boolean; uiResourceUri?: string }[];
    uiTools?: string[];
    uiResourceUri?: string;
    records?: unknown;
  };
}

function textOf(result: ToolResult): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

function externalRefs(html: string): string[] {
  const found: string[] = [];
  const tags =
    /<(?:script|link|img|source|iframe)\b[^>]*?\s(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
  for (const match of html.matchAll(tags)) {
    const url = match[1];
    if (url) found.push(url);
  }
  const css = /url\(\s*["']?(https?:\/\/[^"')]+)["']?\s*\)/gi;
  for (const match of html.matchAll(css)) {
    const url = match[1];
    if (url) found.push(url);
  }
  return found;
}

async function withClient(
  options: { widgetHtmlPath?: string },
  run: (client: Client) => Promise<void>,
) {
  const server = createMcpServer(options);
  const client = new Client({ name: "mcp-apps-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

describe("mcp apps binding", () => {
  it("binds show_form, capability tools, and the shared widget resource", async () => {
    await withClient({}, async (client) => {
      expect(client.getInstructions()).toContain("show_form");
      const listed = await client.listTools();
      const show = listed.tools.find((tool) => tool.name === "show_form");
      const showMeta = show?._meta as ToolMeta | undefined;
      expect(showMeta?.ui?.resourceUri).toBe(WIDGET_RESOURCE_URI);
      expect(showMeta?.["openai/outputTemplate"]).toBe(WIDGET_RESOURCE_URI);
      expect(showMeta?.ui?.visibility).toEqual(["model", "app"]);

      for (const capability of capabilities) {
        const tool = listed.tools.find(
          (item) => item.name === toolNameForCapability(capability.id),
        );
        const meta = tool?._meta as ToolMeta | undefined;
        expect(meta?.ui?.resourceUri).toBe(WIDGET_RESOURCE_URI);
        expect(meta?.["openai/outputTemplate"]).toBe(WIDGET_RESOURCE_URI);
        expect(meta?.ui?.visibility).toEqual(["model", "app"]);
      }

      const approval = listed.tools.find((tool) => tool.name === "get_approval_status");
      const approvalMeta = approval?._meta as ToolMeta | undefined;
      expect(approvalMeta?.ui?.resourceUri).toBe(WIDGET_RESOURCE_URI);

      const resources = await client.listResources();
      const widget = resources.resources.find((item) => item.uri === WIDGET_RESOURCE_URI);
      expect(widget?.mimeType).toBe(RESOURCE_MIME_TYPE);
      expect(widget?.mimeType).toBe("text/html;profile=mcp-app");
      expect(widget?.description?.length).toBeGreaterThan(0);

      const read = await client.readResource({ uri: WIDGET_RESOURCE_URI });
      const content = read.contents[0];
      expect(content?.mimeType).toBe(RESOURCE_MIME_TYPE);
      expect("text" in (content ?? {})).toBe(true);
      if (!content || !("text" in content)) return;
      expect(content.text).toContain("正在等待宿主发送数据");
      expect(externalRefs(content.text)).toEqual([]);

      const search = await call(client, "product_search", { keyword: "螺栓" });
      expect(search.content[0]?.text?.length).toBeGreaterThan(0);
      expect(search.structuredContent?.status).toBe("executed");
      expect(search.structuredContent?.records).toBeTruthy();

      const catalog = await call(client, "list_capabilities");
      expect(catalog.structuredContent?.uiResourceUri).toBe(WIDGET_RESOURCE_URI);
      expect(catalog.structuredContent?.uiTools).toContain("show_form");
      expect(catalog.structuredContent?.uiTools).toContain("get_approval_status");
      for (const capability of capabilities) {
        expect(catalog.structuredContent?.uiTools).toContain(
          toolNameForCapability(capability.id),
        );
        expect(
          catalog.structuredContent?.capabilities?.find((item) => item.id === capability.id),
        ).toMatchObject({ hasUi: true, uiResourceUri: WIDGET_RESOURCE_URI });
      }
    });
  });

  it("describes every capability's required fields from the registry", async () => {
    await withClient({}, async (client) => {
      for (const capability of capabilities) {
        const result = await call(client, "show_form", { capabilityId: capability.id });
        expect(result.isError).toBeFalsy();
        const text = textOf(result);
        expect(text).toContain(toolNameForCapability(capability.id));
        expect(text).toContain("可以在界面中填写");
        expect(result.structuredContent?.kind).toBe("form");
        expect(result.structuredContent?.mcpToolName).toBe(
          toolNameForCapability(capability.id),
        );
        expect(result.structuredContent?.uiSpec?.capabilityId).toBe(capability.id);
        expect(result.content.length).toBeGreaterThan(0);
        expect(result.structuredContent).toBeTruthy();
        for (const field of capability.fields) {
          if (!field.required) continue;
          expect(text).toContain(field.name);
          expect(text).toContain(field.label);
        }
      }
    });
  });

  it("lists valid capability ids when show_form is unknown", async () => {
    await withClient({}, async (client) => {
      const missing = await call(client, "show_form", { capabilityId: "no.such" });
      expect(missing.isError).toBe(true);
      const text = textOf(missing);
      for (const capability of capabilities) {
        expect(text).toContain(capability.id);
      }
    });
  });

  it("fails resource reads with a build hint when the widget file is missing", async () => {
    await withClient({ widgetHtmlPath: `${WIDGET_HTML_PATH}.missing` }, async (client) => {
      await expect(client.readResource({ uri: WIDGET_RESOURCE_URI })).rejects.toThrow(
        /npm run build:widget/,
      );
    });
    expect(WIDGET_MISSING_MESSAGE).toContain("npm run build:widget");
  });
});

describe("workbench origin", () => {
  it("uses a safe forwarded host and ignores an unsafe one", () => {
    expect(
      originFromRequestInfo({
        url: new URL("http://127.0.0.1:4817/api/mcp"),
        headers: {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "agent.example.com",
        },
      }),
    ).toBe("https://agent.example.com");
    expect(
      originFromRequestInfo({
        url: new URL("http://127.0.0.1:4817/api/mcp"),
        headers: {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "user@evil.example",
        },
      }),
    ).toBe("http://127.0.0.1:4817");
  });

  it("returns the request origin from show_form over HTTP", async () => {
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
      "x-forwarded-proto": "https",
      "x-forwarded-host": "tunnel.example.com",
    };
    const response = await POST(
      new Request("http://127.0.0.1:4817/api/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "show_form",
            arguments: { capabilityId: "inquiry.create", prefill: { quantity: 2 } },
          },
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result?: { structuredContent?: { workbenchUrl?: string; prefill?: { quantity?: number } } };
    };
    expect(body.result?.structuredContent?.workbenchUrl).toBe("https://tunnel.example.com");
    expect(body.result?.structuredContent?.prefill?.quantity).toBe(2);
  });
});
