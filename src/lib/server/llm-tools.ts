import { InvalidToolInputError, tool, type ToolSet } from "ai";
import * as z from "zod";
import { toZod, zodIssuesToErrors } from "@/lib/contract/derive";
import { capabilities, getCapability } from "@/lib/contract/registry";
import { toolNameForCapability } from "@/lib/mcp/names";
import {
  approvalToolResult,
  errorToolResult,
  invokeToolResult,
} from "@/lib/mcp/results";
import { capabilityInputSchema, capabilityToolDescription } from "@/lib/mcp/schema";
import type { Actor } from "@/lib/contract/types";
import { findApproval } from "@/lib/server/governance";
import { invoke } from "@/lib/server/invoke";

export const LLM_ACTOR: Actor = { kind: "agent", surface: "llm" };
export const SHOW_FORM_TOOL = "show_form";
export const APPROVAL_STATUS_TOOL = "get_approval_status";

const RESERVED = new Set([SHOW_FORM_TOOL, APPROVAL_STATUS_TOOL, "list_capabilities", "get_ui_spec"]);

function hintForToolValue(toolName: string, value: unknown): string | undefined {
  const capability = getCapability(toolName.replaceAll("_", "."));
  if (!capability) return undefined;
  const parsed = toZod(capability.fields).safeParse(value);
  if (parsed.success) return undefined;
  const messages = zodIssuesToErrors(parsed.error)
    .map((item) => item.message)
    .filter((message) => message.length > 0);
  return messages.length > 0 ? messages.join("；") : undefined;
}

function hintForToolInput(toolName: string, toolInput: string): string | undefined {
  const raw = toolInput.trim();
  if (!raw) return hintForToolValue(toolName, {});
  try {
    return hintForToolValue(toolName, JSON.parse(raw) as unknown);
  } catch {
    return getCapability(toolName.replaceAll("_", ".")) ? "输入必须是一个 JSON 对象" : undefined;
  }
}

function jsonPrefix(text: string): unknown | undefined {
  const start = text.search(/\S/);
  if (start < 0) return undefined;
  const slice = text.slice(start);
  if (slice.startsWith("{") || slice.startsWith("[")) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < slice.length; index += 1) {
      const char = slice[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") inString = false;
        continue;
      }
      if (char === "\"") inString = true;
      else if (char === "{" || char === "[") depth += 1;
      else if (char === "}" || char === "]") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(slice.slice(0, index + 1)) as unknown;
          } catch {
            return undefined;
          }
        }
      }
    }
    return undefined;
  }
  const primitive = /^(?:null|true|false|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|"(?:\\.|[^"\\])*")/.exec(slice);
  if (!primitive) return undefined;
  try {
    return JSON.parse(primitive[0]) as unknown;
  } catch {
    return undefined;
  }
}

export function chineseToolInputHint(error: unknown): string | undefined {
  if (InvalidToolInputError.isInstance(error)) {
    return hintForToolInput(error.toolName, error.toolInput);
  }
  if (typeof error !== "string") return undefined;
  const match = /Invalid input for tool ([A-Za-z0-9_]+):[\s\S]*?\bValue: /.exec(error);
  if (!match || match.index === undefined) return undefined;
  const value = jsonPrefix(error.slice(match.index + match[0].length));
  if (value === undefined) return undefined;
  return hintForToolValue(match[1], value);
}

function stripActor(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input ?? {};
  const record = { ...(input as Record<string, unknown>) };
  delete record.actor;
  return record;
}

export function buildLlmTools(): ToolSet {
  const tools: ToolSet = {};
  for (const capability of capabilities) {
    const name = toolNameForCapability(capability.id);
    if (RESERVED.has(name)) {
      throw new Error(`Capability ${capability.id} cannot use tool name ${name}`);
    }
    tools[name] = tool({
      description: capabilityToolDescription(capability),
      inputSchema: capabilityInputSchema(capability),
      execute: async (input) => {
        const result = invoke({
          capabilityId: capability.id,
          input: stripActor(input),
          actor: LLM_ACTOR,
        });
        return invokeToolResult(result).structuredContent;
      },
    });
  }

  tools[SHOW_FORM_TOOL] = tool({
    description:
      "当需要用户一次填写或确认多个字段时，把智能表单放进对话。不要用它执行写入。capabilityId 是能力编号；prefill 可选，用来预填已经知道的字段。",
    inputSchema: z.object({
      capabilityId: z.string().min(1).describe("能力编号，例如 product.create"),
      prefill: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("可选。要预填的字段，键是字段名"),
    }),
  });

  tools[APPROVAL_STATUS_TOOL] = tool({
    description:
      "查询一张审批的状态（pending、approved 或 rejected）和结果摘要。不能代替人工批准或驳回。",
    inputSchema: z.object({
      approvalId: z.string().describe("审批号，例如 A-001"),
    }),
    execute: async ({ approvalId }) => {
      const approval = findApproval(approvalId);
      if (!approval) {
        return errorToolResult(`找不到审批「${approvalId}」`, { approvalId }).structuredContent;
      }
      return approvalToolResult(approval).structuredContent;
    },
  });

  return tools;
}
