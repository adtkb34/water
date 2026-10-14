import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { capabilities } from "@/lib/contract/registry";
import { toolNameForCapability } from "@/lib/mcp/names";
import { invokeToolResult } from "@/lib/mcp/results";
import { findApproval } from "@/lib/server/governance";
import { getStore, reset } from "@/lib/server/db";
import { APPROVAL_STATUS_TOOL, buildLlmTools, SHOW_FORM_TOOL } from "@/lib/server/llm-tools";

beforeEach(() => {
  reset();
});

async function run(name: string, input: Record<string, unknown>) {
  const tool = buildLlmTools()[name];
  if (!tool?.execute) throw new Error(`missing execute for ${name}`);
  const execute = tool.execute as (value: Record<string, unknown>) => Promise<Record<string, unknown>>;
  return execute(input);
}

describe("llm tools derived from the registry", () => {
  it("matches the registry plus the form and approval tools, and reuses the MCP result builder", async () => {
    const source = readFileSync(path.join(process.cwd(), "src/lib/server/llm-tools.ts"), "utf8");
    expect(source).toContain('from "@/lib/mcp/results"');
    expect(source).toContain("invokeToolResult");
    expect(source).not.toContain("function nextStepFor");
    expect(source).not.toContain("function invokeToolResult");
    expect(source).not.toContain("function errorToolResult");

    const tools = buildLlmTools();
    expect(Object.keys(tools).sort()).toEqual(
      [...capabilities.map((capability) => toolNameForCapability(capability.id)), SHOW_FORM_TOOL, APPROVAL_STATUS_TOOL].sort(),
    );
    expect(tools[SHOW_FORM_TOOL]?.execute).toBeUndefined();
    expect(tools.inquiry_publish?.description).toContain("影响权重");

    const output = await run("inquiry_publish", {
      inquiryId: "Q-001",
      actor: { kind: "human", surface: "workbench" },
    });
    const shape = invokeToolResult({
      status: "rejected",
      capabilityId: "sample",
      impact: 1,
      effectiveImpact: 1,
      summary: "样例",
    }).structuredContent;
    expect(Object.keys(output).sort()).toEqual(Object.keys(shape).sort());
    expect(output.status).toBe("pending_approval");
    expect(output.nextStep).toContain("请告知用户");
    const approval = findApproval(String(output.approvalId));
    expect(approval?.actor).toEqual({ kind: "agent", surface: "llm" });
    expect(approval?.input).toEqual({ inquiryId: "Q-001" });
    expect(getStore().inquiries.find((item) => item.id === "Q-001")?.status).toBe("draft");

    const status = await run(APPROVAL_STATUS_TOOL, { approvalId: String(output.approvalId) });
    expect(status.status).toBe("pending");
  });
});
