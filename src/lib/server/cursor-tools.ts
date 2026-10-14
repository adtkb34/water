import { capabilities } from "@/lib/contract/registry";
import { toolNameForCapability } from "@/lib/mcp/names";

const EXTRA_TOOLS = ["show_form", "list_capabilities", "get_ui_spec", "get_approval_status"] as const;

export function knownCursorToolNames(): Set<string> {
  const names = new Set<string>(EXTRA_TOOLS);
  for (const capability of capabilities) names.add(toolNameForCapability(capability.id));
  return names;
}

export function matchKnownToolName(raw: string, known: ReadonlySet<string> = knownCursorToolNames()): string | null {
  const name = raw.trim();
  if (!name || name === "mcp") return null;
  if (known.has(name)) return name;
  const pieces = name.split(/__+|[/]/).flatMap((part) => part.split("-")).filter(Boolean);
  const last = pieces[pieces.length - 1];
  if (last && known.has(last)) return last;
  return null;
}

export function normalizeCursorToolCall(event: {
  name?: unknown;
  args?: unknown;
}): { toolName: string; input: unknown } | null {
  const known = knownCursorToolNames();
  const name = typeof event.name === "string" ? event.name : "";
  const matched = matchKnownToolName(name, known);
  if (matched) return { toolName: matched, input: inputForDirectCall(event.args) };
  return toolFromArgs(event.args, known);
}

export function isGenericMcpName(name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed || trimmed === "mcp" || trimmed === "mcp_tool" || trimmed === "call_mcp_tool") return true;
  return trimmed.endsWith("__mcp");
}

export interface ParsedCursorToolResult {
  errorText?: string;
  output?: unknown;
}

export function parseCursorToolResult(result: unknown): ParsedCursorToolResult {
  return interpretResult(result, 0);
}

function inputForDirectCall(args: unknown): unknown {
  const record = asRecord(args);
  if (!record) return args ?? {};
  if (record.args !== undefined && (typeof record.toolName === "string" || typeof record.name === "string")) {
    return record.args;
  }
  return record;
}

function toolFromArgs(args: unknown, known: ReadonlySet<string>): { toolName: string; input: unknown } | null {
  const record = asRecord(args);
  if (!record) return null;
  const nested = asRecord(record.args);
  const candidates = [record.toolName, record.name, record.tool, nested?.toolName, nested?.name];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const matched = matchKnownToolName(candidate, known);
    if (!matched) continue;
    return { toolName: matched, input: payloadFrom(record) };
  }
  return null;
}

function payloadFrom(record: Record<string, unknown>): unknown {
  const nested = asRecord(record.args);
  if (nested && (typeof nested.toolName === "string" || typeof nested.name === "string")) {
    return nested.args ?? {};
  }
  if (record.args !== undefined && (typeof record.toolName === "string" || typeof record.name === "string" || typeof record.tool === "string")) {
    return record.args;
  }
  if (record.arguments !== undefined) return record.arguments;
  if (record.input !== undefined) return record.input;
  return withoutMeta(record);
}

function withoutMeta(record: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...record };
  for (const key of ["toolName", "name", "tool", "providerIdentifier", "server", "provider", "type"]) {
    delete copy[key];
  }
  return copy;
}

function interpretResult(value: unknown, depth: number): ParsedCursorToolResult {
  if (depth > 6) return unknownResult("");
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return unknownResult("");
    const parsed = parseJsonValue(trimmed);
    if (parsed !== undefined) return interpretResult(parsed, depth + 1);
    const embedded = jsonFromText(trimmed);
    if (embedded !== undefined) return interpretResult(embedded, depth + 1);
    return unknownResult(trimmed);
  }
  const record = asRecord(value);
  if (!record) return unknownResult("");
  if (record.status === "error" || record.isError === true) {
    return { errorText: "工具执行失败" };
  }
  const structured = asRecord(record.structuredContent);
  if (structured) return { output: structured };
  if (shouldUnwrap(record)) return interpretResult(record.value, depth + 1);
  if (Array.isArray(record.content)) {
    const text = textFromContent(record.content);
    if (text) {
      const embedded = jsonFromText(text);
      if (embedded !== undefined && typeof embedded === "object") return interpretResult(embedded, depth + 1);
      return unknownResult(text);
    }
  }
  if (typeof record.status === "string" || typeof record.kind === "string" || typeof record.summary === "string") {
    return { output: record };
  }
  return { output: record };
}

function shouldUnwrap(record: Record<string, unknown>): boolean {
  if (record.value === undefined || record.structuredContent || record.kind) return false;
  if (record.status === "executed" || record.status === "rejected" || record.status === "pending_approval" || record.status === "pending") {
    return false;
  }
  return record.status === "success" || record.status === undefined || isValueWrapper(record);
}

function isValueWrapper(record: Record<string, unknown>): boolean {
  return Object.keys(record).every((key) => key === "value" || key === "status" || key === "isError" || key === "type");
}

function unknownResult(summary: string): ParsedCursorToolResult {
  return { output: { status: "unknown", summary: summary.slice(0, 500) } };
}

function textFromContent(content: unknown[]): string {
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    const record = asRecord(item);
    if (!record) continue;
    if (typeof record.text === "string") parts.push(record.text);
    else {
      const nested = asRecord(record.text);
      if (nested && typeof nested.text === "string") parts.push(nested.text);
    }
  }
  return parts.join("\n").trim();
}

function jsonFromText(text: string): unknown | undefined {
  const trimmed = text.trim();
  const direct = parseJsonValue(trimmed);
  if (direct !== undefined) return direct;
  const start = trimmed.search(/[{[]/);
  if (start < 0) return undefined;
  return parseJsonValue(extractBalanced(trimmed.slice(start)));
}

function parseJsonValue(text: string): unknown | undefined {
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function extractBalanced(text: string): string {
  const opening = text[0];
  if (opening !== "{" && opening !== "[") return text;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
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
      if (depth === 0) return text.slice(0, index + 1);
    }
  }
  return text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
