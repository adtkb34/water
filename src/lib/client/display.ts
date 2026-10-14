import type {
  Actor,
  ApprovalStatus,
  AuditEntry,
  Inquiry,
  Product,
  Supplier,
  UiFieldSpec,
  UiSpec,
} from "@/lib/contract/types";
import { fieldLabel } from "@/smart-ui/labels";

const ACTOR_KIND: Record<Actor["kind"], string> = {
  human: "人工",
  agent: "智能体",
};

const ACTOR_SURFACE: Record<Actor["surface"], string> = {
  workbench: "工作台",
  chat: "对话",
  mcp: "MCP",
  llm: "大模型",
};

export function actorLabel(actor: Actor): string {
  return `${ACTOR_KIND[actor.kind]} · ${ACTOR_SURFACE[actor.surface]}`;
}

export function approvalStatusText(status: ApprovalStatus): string {
  if (status === "approved") return "已批准";
  if (status === "rejected") return "已驳回";
  return "待审批";
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function revertBlockReason(
  entry: Pick<AuditEntry, "outcome" | "undoable" | "reverted">,
  title: string,
): string | null {
  if (entry.reverted) return "该记录已经撤销，不能重复撤销";
  if (entry.outcome !== "executed" && entry.outcome !== "approved_executed") {
    return "只有已执行的操作可以撤销";
  }
  if (!entry.undoable) return `${title}不可撤销`;
  return null;
}

export interface RefDirectory {
  products: readonly Pick<Product, "id" | "name">[];
  suppliers: readonly Pick<Supplier, "id" | "name">[];
  inquiries: readonly Pick<Inquiry, "id" | "productId" | "quantity">[];
}

export const EMPTY_DIRECTORY: RefDirectory = {
  products: [],
  suppliers: [],
  inquiries: [],
};

export function directoryFrom(data: {
  products: readonly Pick<Product, "id" | "name">[];
  suppliers: readonly Pick<Supplier, "id" | "name">[];
  inquiries: readonly Pick<Inquiry, "id" | "productId" | "quantity">[];
}): RefDirectory {
  return {
    products: data.products,
    suppliers: data.suppliers,
    inquiries: data.inquiries,
  };
}

export interface InputFact {
  key: string;
  label: string;
  value: string;
}

function optionLabel(field: UiFieldSpec | undefined, value: string): string | undefined {
  return field?.options?.find((option) => option.value === value)?.label;
}

function resolveRef(field: UiFieldSpec, id: string, directory: RefDirectory): string {
  if (field.refKind === "product") {
    return directory.products.find((item) => item.id === id)?.name ?? optionLabel(field, id) ?? id;
  }
  if (field.refKind === "supplier") {
    return directory.suppliers.find((item) => item.id === id)?.name ?? optionLabel(field, id) ?? id;
  }
  if (field.refKind === "inquiry") {
    const inquiry = directory.inquiries.find((item) => item.id === id);
    if (inquiry) {
      const product = directory.products.find((item) => item.id === inquiry.productId);
      return `${inquiry.id} · ${product?.name ?? inquiry.productId} × ${inquiry.quantity}`;
    }
    return optionLabel(field, id) ?? id;
  }
  return optionLabel(field, id) ?? id;
}

function textValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) {
    return value.map((item) => textValue(item)).filter(Boolean).join("、");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function renderField(field: UiFieldSpec, value: unknown, directory: RefDirectory): string {
  if (field.type === "ref") {
    if (typeof value !== "string" || !value.trim()) return "";
    return resolveRef(field, value.trim(), directory);
  }
  if (field.type === "multiref") {
    if (!Array.isArray(value)) return textValue(value);
    return value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => resolveRef(field, item.trim(), directory))
      .join("、");
  }
  if (field.type === "enum" && typeof value === "string" && value.trim()) {
    return optionLabel(field, value.trim()) ?? value.trim();
  }
  return textValue(value);
}

export function inputFacts(
  spec: UiSpec | undefined,
  input: unknown,
  directory: RefDirectory,
): InputFact[] {
  if (!isRecord(input)) {
    const value = textValue(input);
    return value ? [{ key: "value", label: "输入", value }] : [];
  }
  const fields = spec?.fields ?? [];
  const known = new Set(fields.map((field) => field.name));
  const facts: InputFact[] = [];
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(input, field.name)) continue;
    const value = renderField(field, input[field.name], directory);
    if (!value) continue;
    facts.push({ key: field.name, label: field.label, value });
  }
  for (const [key, raw] of Object.entries(input)) {
    if (known.has(key)) continue;
    const value = textValue(raw);
    if (!value) continue;
    facts.push({ key, label: fieldLabel(key), value });
  }
  return facts;
}
