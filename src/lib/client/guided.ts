import {
  getToolName,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from "ai";
import type { InvokeResult, RefKind, UiSpec } from "@/lib/contract/types";
import { REF_KINDS } from "@/lib/domain";
import { prefillRef } from "@/lib/client/specs";

export const SHOW_FORM_TOOL = "show_form";

export const GUIDED_HINT =
  "引导模式下请用 / 或 + 选择要做的事，也可以点下面的快捷入口";

export interface ChatReference {
  id: string;
  kind: RefKind;
  label: string;
  token?: string;
}

export interface ChatMetadata {
  capabilityId?: string;
  references?: ChatReference[];
  guidedHint?: boolean;
}

export type ChatUIMessage = UIMessage<ChatMetadata>;

export interface ShowFormInput {
  capabilityId: string;
  prefill?: Record<string, unknown>;
}

export interface MentionEntity {
  id: string;
  kind: RefKind;
  label: string;
  detail: string;
}

export interface ActiveToken {
  kind: "command" | "mention";
  query: string;
  start: number;
}

export interface NextStep {
  spec: UiSpec;
  prefill: Record<string, unknown>;
}

const READ_SUGGESTION_LIMIT = 2;

export function createMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function filterCommands(specs: UiSpec[], query: string): UiSpec[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return specs;
  return specs.filter((spec) =>
    [spec.title, spec.description, spec.capabilityId].some((value) =>
      value.toLowerCase().includes(needle),
    ),
  );
}

export function groupByModule(
  specs: UiSpec[],
): { moduleLabel: string; specs: UiSpec[] }[] {
  const order: string[] = [];
  const groups = new Map<string, UiSpec[]>();
  for (const spec of specs) {
    const list = groups.get(spec.moduleLabel);
    if (list) list.push(spec);
    else {
      groups.set(spec.moduleLabel, [spec]);
      order.push(spec.moduleLabel);
    }
  }
  return order.map((moduleLabel) => ({
    moduleLabel,
    specs: groups.get(moduleLabel) ?? [],
  }));
}

export function suggestionSpecs(specs: UiSpec[]): UiSpec[] {
  const writes = specs.filter((spec) => spec.kind === "write");
  const reads = specs
    .filter((spec) => spec.kind === "read")
    .slice(0, READ_SUGGESTION_LIMIT);
  return [...writes, ...reads];
}

export function quickEntrySpecs(specs: UiSpec[]): UiSpec[] {
  const suggestions = suggestionSpecs(specs);
  const writes = suggestions.filter((spec) => spec.kind === "write").slice(0, 3);
  const reads = suggestions.filter((spec) => spec.kind === "read").slice(0, 1);
  return [...writes, ...reads];
}

export function activeToken(text: string, cursor: number): ActiveToken | null {
  const end = Math.max(0, Math.min(cursor, text.length));
  const upto = text.slice(0, end);
  const match = /(?:^|\s)([/@])([^\s]*)$/.exec(upto);
  if (!match) return null;
  const symbol = match[1];
  if (symbol !== "/" && symbol !== "@") return null;
  const query = match[2] ?? "";
  return {
    kind: symbol === "/" ? "command" : "mention",
    query,
    start: end - query.length - 1,
  };
}

export function replaceToken(
  text: string,
  token: ActiveToken,
  replacement: string,
  cursor: number,
): { text: string; cursor: number } {
  const end = Math.max(token.start + 1, Math.min(cursor, text.length));
  const next = text.slice(0, token.start) + replacement + text.slice(end);
  return { text: next, cursor: token.start + replacement.length };
}

export function mentionEntities(source: {
  products: readonly { id: string; name: string }[];
  suppliers: readonly { id: string; name: string }[];
  inquiries: readonly { id: string; productId: string }[];
}): MentionEntity[] {
  const productName = new Map(source.products.map((item) => [item.id, item.name]));
  return [
    ...source.products.map((item) => ({
      id: item.id,
      kind: "product" as const,
      label: item.name,
      detail: item.id,
    })),
    ...source.suppliers.map((item) => ({
      id: item.id,
      kind: "supplier" as const,
      label: item.name,
      detail: item.id,
    })),
    ...source.inquiries.map((item) => ({
      id: item.id,
      kind: "inquiry" as const,
      label: item.id,
      detail: productName.get(item.productId) ?? item.productId,
    })),
  ];
}

export function filterMentions(
  entities: readonly MentionEntity[],
  query: string,
): MentionEntity[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...entities];
  return entities.filter((entity) =>
    [entity.label, entity.detail, entity.id].some((value) =>
      value.toLowerCase().includes(needle),
    ),
  );
}

export function prefillFromReferences(
  spec: UiSpec,
  references: readonly ChatReference[],
): Record<string, unknown> {
  const prefill: Record<string, unknown> = {};
  for (const field of spec.fields) {
    if (!field.refKind) continue;
    const matches = references.filter((item) => item.kind === field.refKind);
    if (matches.length === 0) continue;
    if (field.type === "multiref") {
      prefill[field.name] = matches.map((item) => item.id);
      continue;
    }
    const last = matches[matches.length - 1];
    if (last) prefill[field.name] = last.id;
  }
  return prefill;
}

export function workbenchPath(spec: Pick<UiSpec, "module" | "fields">): string {
  const kinds = spec.fields.map((field) => field.refKind);
  if (spec.module === "inquiry" || kinds.includes("inquiry")) return "/workbench/inquiries";
  if (spec.module === "product" || kinds.includes("product")) return "/workbench/products";
  if (kinds.includes("supplier")) return "/workbench/suppliers";
  return "/workbench";
}

function refKindForId(id: string): RefKind | undefined {
  for (const [kind, meta] of Object.entries(REF_KINDS)) {
    if (id.startsWith(`${meta.prefix}-`)) return kind as RefKind;
  }
  return undefined;
}

function readEntity(
  value: unknown,
): { id: string; refKind: RefKind; status?: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { id?: unknown; status?: unknown };
  if (typeof record.id !== "string") return null;
  const refKind = refKindForId(record.id);
  if (!refKind) return null;
  return {
    id: record.id,
    refKind,
    ...(typeof record.status === "string" ? { status: record.status } : {}),
  };
}

export function nextSteps(specs: UiSpec[], result: InvokeResult): NextStep[] {
  if (result.status !== "executed") return [];
  const entity = readEntity(result.data) ?? readEntity(result.records?.[0]);
  if (!entity?.status) return [];
  const status = entity.status;
  const steps: NextStep[] = [];
  for (const spec of specs) {
    if (spec.kind !== "write") continue;
    const matches = spec.fields.some(
      (field) => field.refKind === entity.refKind && field.refFilter?.includes(status),
    );
    if (!matches) continue;
    const prefill = prefillRef(spec, entity.refKind, entity.id);
    if (Object.keys(prefill).length === 0) continue;
    steps.push({ spec, prefill });
  }
  return steps;
}

export function readShowFormInput(value: unknown): ShowFormInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { capabilityId?: unknown; prefill?: unknown };
  if (typeof record.capabilityId !== "string" || !record.capabilityId) return null;
  const prefill =
    record.prefill && typeof record.prefill === "object" && !Array.isArray(record.prefill)
      ? (record.prefill as Record<string, unknown>)
      : undefined;
  return {
    capabilityId: record.capabilityId,
    ...(prefill ? { prefill } : {}),
  };
}

export function readInvokeResult(value: unknown): InvokeResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<InvokeResult>;
  if (
    record.status !== "executed" &&
    record.status !== "rejected" &&
    record.status !== "pending_approval"
  ) {
    return null;
  }
  if (typeof record.capabilityId !== "string" || typeof record.summary !== "string") {
    return null;
  }
  return record as InvokeResult;
}

export function readSubmittedValues(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const submitted = (value as { submitted?: unknown }).submitted;
  if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) return {};
  return submitted as Record<string, unknown>;
}

export function parsePrefill(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function textPart(text: string): ChatUIMessage["parts"][number] {
  return { type: "text", text, state: "done" };
}

function showFormPart(
  toolCallId: string,
  input: ShowFormInput,
): ChatUIMessage["parts"][number] {
  return {
    type: "tool-show_form",
    toolCallId,
    state: "input-available",
    input,
  };
}

export function capabilityTurn(options: {
  spec: UiSpec;
  text?: string;
  references?: readonly ChatReference[];
  prefill?: Record<string, unknown>;
  nextId?: () => string;
}): ChatUIMessage[] {
  const nextId = options.nextId ?? createMessageId;
  const references = [...(options.references ?? [])];
  const prefill = {
    ...prefillFromReferences(options.spec, references),
    ...(options.prefill ?? {}),
  };
  const typed = options.text?.trim() ?? "";
  const userText = typed || options.spec.title;
  const input: ShowFormInput = {
    capabilityId: options.spec.capabilityId,
    ...(Object.keys(prefill).length > 0 ? { prefill } : {}),
  };
  const user: ChatUIMessage = {
    id: nextId(),
    role: "user",
    metadata: {
      capabilityId: options.spec.capabilityId,
      ...(references.length > 0 ? { references } : {}),
    },
    parts: [textPart(userText)],
  };
  const assistant: ChatUIMessage = {
    id: nextId(),
    role: "assistant",
    parts: [
      textPart(`请填写「${options.spec.title}」。`),
      showFormPart(nextId(), input),
    ],
  };
  return [user, assistant];
}

export function freeTextTurn(
  text: string,
  nextId: () => string = createMessageId,
): ChatUIMessage[] {
  return [
    {
      id: nextId(),
      role: "user",
      parts: [textPart(text)],
    },
    {
      id: nextId(),
      role: "assistant",
      metadata: { guidedHint: true },
      parts: [textPart(GUIDED_HINT)],
    },
  ];
}

export function shortcutContext(options: {
  title?: string;
  references?: readonly ChatReference[];
  prefill?: Record<string, unknown>;
}): string {
  const bits: string[] = [];
  if (options.title) bits.push(`用户通过快捷入口选择了能力：${options.title}`);
  if (options.references && options.references.length > 0) {
    bits.push(
      `引用：${options.references.map((item) => `${item.label}(${item.id})`).join("、")}`,
    );
  }
  const lines: string[] = [];
  if (bits.length > 0) lines.push(bits.join("，"));
  if (options.prefill && Object.keys(options.prefill).length > 0) {
    lines.push(`预填：${JSON.stringify(options.prefill)}`);
  }
  return lines.join("\n");
}

export function compactFormOutput(result: InvokeResult, submitted?: Record<string, unknown>) {
  const ids: string[] = [];
  const data = result.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const id = (data as { id?: unknown }).id;
    if (typeof id === "string") ids.push(id);
  }
  for (const record of result.records ?? []) {
    if (typeof record.id === "string" && !ids.includes(record.id)) ids.push(record.id);
  }
  return {
    status: result.status,
    summary: result.summary,
    capabilityId: result.capabilityId,
    impact: result.impact,
    effectiveImpact: result.effectiveImpact,
    approvalId: result.approvalId ?? null,
    ids,
    ...(submitted && Object.keys(submitted).length > 0 ? { submitted } : {}),
  };
}

export interface McpFormView {
  capabilityId: string;
  uiSpec?: UiSpec;
  prefill?: Record<string, unknown>;
}

export function readMcpForm(value: unknown): McpFormView | null {
  const record = formRecord(value);
  if (!record || record.kind !== "form") return null;
  const uiSpec = isUiSpec(record.uiSpec) ? record.uiSpec : undefined;
  const capabilityId =
    typeof record.capabilityId === "string" && record.capabilityId
      ? record.capabilityId
      : uiSpec?.capabilityId ?? "";
  if (!capabilityId) return null;
  const prefill =
    record.prefill && typeof record.prefill === "object" && !Array.isArray(record.prefill)
      ? (record.prefill as Record<string, unknown>)
      : undefined;
  return {
    capabilityId,
    ...(uiSpec ? { uiSpec } : {}),
    ...(prefill ? { prefill } : {}),
  };
}

function formRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const structured = record.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    return structured as Record<string, unknown>;
  }
  return record;
}

function isUiSpec(value: unknown): value is UiSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<UiSpec>;
  return (
    typeof record.capabilityId === "string" &&
    typeof record.title === "string" &&
    Array.isArray(record.fields) &&
    Boolean(record.submit && typeof record.submit.tool === "string")
  );
}

export function continueAfterClientTool({ messages }: { messages: ChatUIMessage[] }): boolean {
  if (!lastAssistantMessageIsCompleteWithToolCalls({ messages })) return false;
  const message = messages.at(-1);
  if (!message) return false;
  const tools = message.parts.filter(isToolUIPart);
  const last = tools.at(-1);
  if (!last || getToolName(last) !== SHOW_FORM_TOOL) return false;
  if ("output" in last && readMcpForm(last.output)) return false;
  return true;
}

export function assistantNote(
  text: string,
  nextId: () => string = createMessageId,
): ChatUIMessage {
  return {
    id: nextId(),
    role: "assistant",
    parts: [textPart(text)],
  };
}

export function attachToolOutput(
  messages: ChatUIMessage[],
  toolCallId: string,
  output: unknown,
): ChatUIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== "dynamic-tool" && !part.type.startsWith("tool-")) return part;
      if (!("toolCallId" in part) || part.toolCallId !== toolCallId) return part;
      return {
        ...part,
        state: "output-available",
        output,
      } as ChatUIMessage["parts"][number];
    }),
  }));
}

export function isStoredMessage(value: unknown): value is ChatUIMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as { id?: unknown; role?: unknown; parts?: unknown };
  return (
    typeof message.id === "string" &&
    (message.role === "user" || message.role === "assistant" || message.role === "system") &&
    Array.isArray(message.parts)
  );
}
