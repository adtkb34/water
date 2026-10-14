import type { REF_KINDS } from "@/lib/domain";

export const INVOKE_STATUSES = [
  "executed",
  "rejected",
  "pending_approval",
] as const;

export type InvokeStatus = (typeof INVOKE_STATUSES)[number];
export type FieldType =
  | "string"
  | "number"
  | "date"
  | "enum"
  | "ref"
  | "multiref";
export type RefKind = keyof typeof REF_KINDS;
export type ModuleId = "product" | "inquiry" | "procurement";
export type CapabilityKind = "read" | "write";
export type ActorKind = "human" | "agent";
export type ActorSurface = "workbench" | "chat" | "mcp" | "llm";

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  required: boolean;
  description?: string;
  hints?: string[];
  options?: string[];
  optionLabels?: Record<string, string>;
  refKind?: RefKind;
  refFilter?: string[];
  min?: number;
  integer?: boolean;
}

export interface Product {
  id: string;
  name: string;
  category: string;
  unit: string;
  referencePrice: number;
}

export interface Supplier {
  id: string;
  name: string;
  categories: string[];
  rating: number;
}

export interface Award {
  supplierId: string;
  price: number;
}

export interface Inquiry {
  id: string;
  productId: string;
  quantity: number;
  deadline: string;
  supplierIds: string[];
  note?: string;
  status: "draft" | "published" | "awarded";
  createdAt: string;
  award?: Award;
}

export type IssueLevel = "block" | "warn";

export interface Issue {
  level: IssueLevel;
  field?: string;
  message: string;
}

export interface Policy {
  threshold: number;
  alwaysReview: string[];
}

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface Approval {
  id: string;
  capabilityId: string;
  input: unknown;
  actor: Actor;
  effectiveImpact: number;
  reasons: string[];
  issues: Issue[];
  status: ApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  resultSummary?: string;
  note?: string;
}

export type AuditOutcome =
  | "executed"
  | "pending_approval"
  | "rejected"
  | "approved_executed"
  | "approval_rejected"
  | "reverted";

export type AuditStage = "schema" | "verifier" | "gate" | "execute";

export interface AuditReview {
  mark: "ok" | "flagged";
  note?: string;
  at: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  capabilityId: string;
  input: unknown;
  actor: Actor;
  effectiveImpact: number;
  outcome: AuditOutcome;
  stage?: AuditStage;
  issues: Issue[];
  summary: string;
  approvalId?: string;
  undoData?: unknown;
  undoable: boolean;
  reverted?: boolean;
  review?: AuditReview;
}

export interface Store {
  products: Product[];
  suppliers: Supplier[];
  inquiries: Inquiry[];
  counters: Record<RefKind, number>;
  policy: Policy;
  approvals: Approval[];
  audit: AuditEntry[];
  seq: { approval: number; audit: number };
}

export interface Actor {
  kind: ActorKind;
  surface: ActorSurface;
}

export interface CapabilityContext {
  store: Store;
  actor: Actor;
}

export interface ExecuteResult {
  summary: string;
  data?: unknown;
  records?: Record<string, unknown>[];
  undoData?: unknown;
}

export interface CapabilityDef<TInput = Record<string, unknown>> {
  id: string;
  module: ModuleId;
  moduleLabel: string;
  title: string;
  description: string;
  kind: CapabilityKind;
  impact: number;
  alwaysReview?: boolean;
  keywords?: string[];
  fields: FieldDef[];
  verify?: (input: TInput, ctx: CapabilityContext) => Issue[];
  execute: (input: TInput, ctx: CapabilityContext) => ExecuteResult;
  undo?: (undoData: unknown, ctx: CapabilityContext) => void;
}

export function defineCapability<TInput>(
  definition: CapabilityDef<TInput>,
): CapabilityDef {
  return definition as unknown as CapabilityDef;
}

export interface FieldError {
  field?: string;
  message: string;
}

export interface InvokeResult {
  status: InvokeStatus;
  capabilityId: string;
  impact: number;
  effectiveImpact: number;
  summary: string;
  data?: unknown;
  records?: Record<string, unknown>[];
  errors?: FieldError[];
  issues?: Issue[];
  approvalId?: string;
  reasons?: string[];
  auditId?: string;
  stage?: AuditStage;
  actor?: Actor;
}

export interface UiOption {
  value: string;
  label: string;
}

export interface UiFieldSpec {
  name: string;
  label: string;
  type: FieldType;
  required: boolean;
  description?: string;
  hints?: string[];
  options?: UiOption[];
  refKind?: RefKind;
  refFilter?: string[];
  min?: number;
  integer?: boolean;
}

export interface UiSpec {
  capabilityId: string;
  module: ModuleId;
  moduleLabel: string;
  title: string;
  description: string;
  kind: CapabilityKind;
  impact: number;
  fields: UiFieldSpec[];
  submit: { tool: string; label: string };
}

export interface JsonSchema {
  type: "object";
  description: string;
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
  additionalProperties: false;
}

export type JsonSchemaProperty =
  | {
      type: "string" | "number" | "integer";
      description: string;
      enum?: string[];
      minimum?: number;
      format?: string;
      pattern?: string;
    }
  | {
      type: "array";
      description: string;
      minItems?: number;
      items: {
        type: "string";
        description: string;
        pattern?: string;
      };
    };
