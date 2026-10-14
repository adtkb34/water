import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@/lib/mcp/server";

function jsonRpcError(message: string, status: number, code: number) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
}

function methodNotAllowed(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    }),
    {
      status: 405,
      headers: {
        Allow: "POST",
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
}

export async function handleMcpRequest(request: Request): Promise<Response> {
  // SDK 1.32 leaves GET/DELETE open in stateless mode (an SSE stream, or a
  // session delete). This endpoint is one fresh server per POST with JSON
  // responses, so those methods are refused the way the Streamable HTTP spec
  // allows: 405 means there is no server stream and no session to terminate.
  if (request.method !== "POST") return methodNotAllowed();

  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "MCP 请求失败";
    return jsonRpcError(message, 500, -32603);
  } finally {
    await server.close();
  }
}
