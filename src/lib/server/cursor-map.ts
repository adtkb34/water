import { redactSecrets } from "@/lib/server/redact";
import {
  isGenericMcpName,
  normalizeCursorToolCall,
  parseCursorToolResult,
} from "@/lib/server/cursor-tools";

export type CursorUiChunk =
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "tool-input-available"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-output-available"; toolCallId: string; output: unknown }
  | { type: "tool-output-error"; toolCallId: string; errorText: string };

export interface CursorMapState {
  emitted: string;
  textOpen: boolean;
  textSeq: number;
  textId: string;
  notedForbidden: boolean;
  forbidden: string[];
  tools: Map<string, { inputSent: boolean }>;
  toolSeq: number;
  secrets: readonly string[];
}

export function createCursorMapState(secrets: readonly string[]): CursorMapState {
  return {
    emitted: "",
    textOpen: false,
    textSeq: 0,
    textId: "",
    notedForbidden: false,
    forbidden: [],
    tools: new Map(),
    toolSeq: 0,
    secrets,
  };
}

export function mapCursorEvent(state: CursorMapState, event: unknown): CursorUiChunk[] {
  const record = asRecord(event);
  if (!record) return [];
  if (record.type === "assistant") return mapAssistant(state, record);
  if (record.type === "tool_call") return mapTool(state, record);
  return [];
}

export function closeCursorText(state: CursorMapState): CursorUiChunk[] {
  if (!state.textOpen) return [];
  state.textOpen = false;
  return [{ type: "text-end", id: state.textId }];
}

function mapAssistant(state: CursorMapState, event: Record<string, unknown>): CursorUiChunk[] {
  const message = asRecord(event.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const chunks: CursorUiChunk[] = [];
  for (const block of content) {
    const item = asRecord(block);
    if (!item || item.type !== "text" || typeof item.text !== "string") continue;
    const delta = takeDelta(state, item.text);
    if (!delta) continue;
    chunks.push(...openText(state), { type: "text-delta", id: state.textId, delta: scrub(delta, state.secrets) });
  }
  return chunks;
}

function mapTool(state: CursorMapState, event: Record<string, unknown>): CursorUiChunk[] {
  const name = typeof event.name === "string" ? event.name : "";
  const status = typeof event.status === "string" ? event.status : "";
  const normalized = normalizeCursorToolCall({ name, args: event.args });
  if (!normalized) {
    if (status === "running" && isGenericMcpName(name)) return [];
    return noteForbidden(state, name || "unknown");
  }
  const callId = typeof event.call_id === "string" && event.call_id ? event.call_id : nextToolId(state);
  const tracked = state.tools.get(callId) ?? { inputSent: false };
  state.tools.set(callId, tracked);
  const chunks: CursorUiChunk[] = [...closeCursorText(state)];
  if (!tracked.inputSent && (status === "running" || status === "completed" || status === "error")) {
    tracked.inputSent = true;
    chunks.push({
      type: "tool-input-available",
      toolCallId: callId,
      toolName: normalized.toolName,
      input: scrubValue(normalized.input, state.secrets),
    });
  }
  if (status === "running") return chunks;
  const parsed = parseCursorToolResult(event.result);
  if (status === "error" || parsed.errorText) {
    chunks.push({
      type: "tool-output-error",
      toolCallId: callId,
      errorText: scrub(parsed.errorText || "工具执行失败", state.secrets),
    });
    return chunks;
  }
  chunks.push({
    type: "tool-output-available",
    toolCallId: callId,
    output: scrubValue(parsed.output, state.secrets),
  });
  return chunks;
}

function noteForbidden(state: CursorMapState, name: string): CursorUiChunk[] {
  state.forbidden.push(name);
  if (state.notedForbidden) return [...closeCursorText(state)];
  state.notedForbidden = true;
  const chunks = [...closeCursorText(state), ...openText(state)];
  chunks.push({ type: "text-delta", id: state.textId, delta: "智能体尝试使用了非业务工具，已忽略" });
  chunks.push(...closeCursorText(state));
  return chunks;
}

function openText(state: CursorMapState): CursorUiChunk[] {
  if (state.textOpen) return [];
  state.textSeq += 1;
  state.textId = `cursor-text-${state.textSeq}`;
  state.textOpen = true;
  return [{ type: "text-start", id: state.textId }];
}

function nextToolId(state: CursorMapState): string {
  state.toolSeq += 1;
  return `cursor-tool-${state.toolSeq}`;
}

export function takeDelta(state: Pick<CursorMapState, "emitted">, text: string): string {
  if (!text) return "";
  if (text === state.emitted || state.emitted.includes(text)) return "";
  if (text.startsWith(state.emitted)) {
    const delta = text.slice(state.emitted.length);
    state.emitted = text;
    return delta;
  }
  state.emitted += text;
  return text;
}

function scrub(text: string, secrets: readonly string[]): string {
  return redactSecrets(text, secrets);
}

function scrubValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, secrets));
  if (!value || typeof value !== "object") return value;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) copy[key] = scrubValue(item, secrets);
  return copy;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
