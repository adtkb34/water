import * as z from "zod";
import { isRealDate } from "@/lib/dates";
import { REF_KINDS } from "@/lib/domain";
import type {
  CapabilityDef,
  FieldDef,
  FieldError,
  JsonSchema,
  JsonSchemaProperty,
  Store,
  UiFieldSpec,
  UiOption,
  UiSpec,
} from "@/lib/contract/types";

type IssueLike = { input?: unknown; path?: PropertyKey[] };

function missingMessage(field: FieldDef): string {
  return `请填写${field.label}`;
}

function enumMessage(field: FieldDef): string {
  const options = field.options ?? [];
  const rendered = options
    .map((value) => {
      const label = field.optionLabels?.[value];
      return label ? `${label}(${value})` : value;
    })
    .join("、");
  return `${field.label}必须是以下之一：${rendered}`;
}

function numberMessage(field: FieldDef): string {
  if (field.integer && field.min !== undefined) {
    return `${field.label}必须是不小于${field.min}的整数`;
  }
  if (field.integer) return `${field.label}必须是整数`;
  if (field.min !== undefined) {
    return `${field.label}必须是不小于${field.min}的数字`;
  }
  return `${field.label}必须是数字`;
}

function refMeta(field: FieldDef) {
  if (!field.refKind) {
    throw new Error(`Field ${field.name} is missing refKind`);
  }
  return REF_KINDS[field.refKind];
}

function typeOrMissing(field: FieldDef, invalid: string) {
  return (issue: IssueLike) =>
    issue.input === undefined ? missingMessage(field) : invalid;
}

function stringSchema(field: FieldDef): z.ZodType {
  if (!field.required) {
    return z
      .string({ error: `${field.label}必须是文本` })
      .trim()
      .optional();
  }
  return z
    .string({
      error: typeOrMissing(field, `${field.label}必须是文本`),
    })
    .trim()
    .min(1, { error: `${field.label}不能为空` });
}

function numberSchema(field: FieldDef): z.ZodType {
  const message = numberMessage(field);
  const base = field.integer
    ? z.int({ error: typeOrMissing(field, message) })
    : z.number({ error: typeOrMissing(field, message) });
  const limited =
    field.min === undefined ? base : base.min(field.min, { error: message });
  return field.required ? limited : limited.optional();
}

function dateSchema(field: FieldDef): z.ZodType {
  const message = `${field.label}必须是 YYYY-MM-DD 格式的日期，例如 2026-12-31`;
  const schema = z
    .string({ error: typeOrMissing(field, message) })
    .refine(isRealDate, { error: message });
  return field.required ? schema : schema.optional();
}

function enumSchema(field: FieldDef): z.ZodType {
  const options = field.options ?? [];
  if (options.length === 0) {
    throw new Error(`Enum field ${field.name} is missing options`);
  }
  const values = [options[0], ...options.slice(1)] as [string, ...string[]];
  const message = enumMessage(field);
  const schema = z.enum(values, { error: typeOrMissing(field, message) });
  return field.required ? schema : schema.optional();
}

function refSchema(field: FieldDef): z.ZodType {
  const meta = refMeta(field);
  const message = `${field.label}必须是${meta.noun}编号，格式如 ${meta.example}`;
  const schema = z
    .string({ error: typeOrMissing(field, message) })
    .regex(new RegExp(`^${meta.prefix}-\\d{3,}$`), { error: message });
  return field.required ? schema : schema.optional();
}

function multiRefSchema(field: FieldDef): z.ZodType {
  const meta = refMeta(field);
  const itemMessage = `${field.label}中的每一项都必须是${meta.noun}编号，格式如 ${meta.example}`;
  const arrayMessage = `${field.label}必须是${meta.noun}编号数组`;
  let schema: z.ZodType = z.array(
    z
      .string({ error: itemMessage })
      .regex(new RegExp(`^${meta.prefix}-\\d{3,}$`), { error: itemMessage }),
    { error: typeOrMissing(field, arrayMessage) },
  );
  if (field.required) {
    schema = (schema as z.ZodArray<z.ZodType>).min(1, {
      error: `请至少选择一个${meta.noun}`,
    });
  } else {
    schema = schema.optional();
  }
  return schema;
}

function fieldSchema(field: FieldDef): z.ZodType {
  switch (field.type) {
    case "string":
      return stringSchema(field);
    case "number":
      return numberSchema(field);
    case "date":
      return dateSchema(field);
    case "enum":
      return enumSchema(field);
    case "ref":
      return refSchema(field);
    case "multiref":
      return multiRefSchema(field);
    default: {
      const unreachable: never = field.type;
      throw new Error(`Unknown field type ${unreachable}`);
    }
  }
}

export function toZod(fields: FieldDef[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    shape[field.name] = fieldSchema(field);
  }
  return z.object(shape, {
    error: (issue: IssueLike) => {
      if ((issue.path?.length ?? 0) > 0) return undefined;
      return "输入必须是一个对象";
    },
  });
}

export function zodIssuesToErrors(error: z.ZodError): FieldError[] {
  const errors = error.issues.map((issue) => {
    const field = issue.path[0];
    return {
      field: field === undefined ? undefined : String(field),
      message: issue.message,
    };
  });
  return dedupeErrors(errors);
}

function dedupeErrors(errors: FieldError[]): FieldError[] {
  const seen = new Set<string>();
  return errors.filter((error) => {
    const key = `${error.field ?? ""}:${error.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function entityExists(store: Store, field: FieldDef, id: string): boolean {
  if (field.refKind === "product") {
    return store.products.some((item) => item.id === id);
  }
  if (field.refKind === "supplier") {
    return store.suppliers.some((item) => item.id === id);
  }
  return store.inquiries.some((item) => item.id === id);
}

export function validateValues(
  fields: FieldDef[],
  input: Record<string, unknown>,
  store: Store,
): FieldError[] {
  const errors: FieldError[] = [];
  for (const field of fields) {
    const value = input[field.name];
    if (value === undefined) continue;
    if (field.type === "enum" && field.options) {
      if (typeof value !== "string" || !field.options.includes(value)) {
        errors.push({ field: field.name, message: enumMessage(field) });
      }
    }
    if ((field.type === "ref" || field.type === "multiref") && field.refKind) {
      const ids = field.type === "multiref" ? value : [value];
      if (!Array.isArray(ids)) continue;
      const meta = REF_KINDS[field.refKind];
      for (const id of ids) {
        if (typeof id !== "string") continue;
        if (!entityExists(store, field, id)) {
          errors.push({
            field: field.name,
            message: `找不到${meta.noun}「${id}」`,
          });
        }
      }
    }
  }
  return errors;
}

function fieldDescription(field: FieldDef, extra?: string): string {
  const parts = [field.description, extra].filter(
    (part): part is string => Boolean(part),
  );
  return parts.join("。") || field.label;
}

function fieldToJsonSchema(field: FieldDef): JsonSchemaProperty {
  switch (field.type) {
    case "string":
      return { type: "string", description: fieldDescription(field) };
    case "number":
      return {
        type: field.integer ? "integer" : "number",
        description: fieldDescription(field, numberMessage(field)),
        ...(field.min === undefined ? {} : { minimum: field.min }),
      };
    case "date":
      return {
        type: "string",
        format: "date",
        description: fieldDescription(field, "格式为 YYYY-MM-DD"),
      };
    case "enum":
      return {
        type: "string",
        enum: field.options ?? [],
        description: fieldDescription(field, enumMessage(field)),
      };
    case "ref": {
      const meta = refMeta(field);
      return {
        type: "string",
        pattern: `^${meta.prefix}-\\d{3,}$`,
        description: fieldDescription(field, `编号格式如 ${meta.example}`),
      };
    }
    case "multiref": {
      const meta = refMeta(field);
      return {
        type: "array",
        description: fieldDescription(
          field,
          `每项都是${meta.noun}编号，格式如 ${meta.example}`,
        ),
        ...(field.required ? { minItems: 1 } : {}),
        items: {
          type: "string",
          pattern: `^${meta.prefix}-\\d{3,}$`,
          description: `${meta.noun}编号，格式如 ${meta.example}`,
        },
      };
    }
    default: {
      const unreachable: never = field.type;
      throw new Error(`Unknown field type ${unreachable}`);
    }
  }
}

export function toJsonSchema(capability: CapabilityDef): JsonSchema {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];
  for (const field of capability.fields) {
    properties[field.name] = fieldToJsonSchema(field);
    if (field.required) required.push(field.name);
  }
  return {
    type: "object",
    description: capability.description,
    properties,
    required,
    additionalProperties: false,
  };
}

function enumOptions(field: FieldDef): UiOption[] {
  return (field.options ?? []).map((value) => ({
    value,
    label: field.optionLabels?.[value] ?? value,
  }));
}

function inquiryLabel(store: Store, id: string, quantity: number, productId: string) {
  const product = store.products.find((item) => item.id === productId);
  return `${id} · ${product?.name ?? productId} × ${quantity}`;
}

function refOptions(field: FieldDef, store: Store): UiOption[] {
  if (field.refKind === "product") {
    return store.products.map((product) => ({
      value: product.id,
      label: product.name,
    }));
  }
  if (field.refKind === "supplier") {
    return store.suppliers.map((supplier) => ({
      value: supplier.id,
      label: supplier.name,
    }));
  }
  return store.inquiries
    .filter(
      (inquiry) =>
        !field.refFilter || field.refFilter.includes(inquiry.status),
    )
    .map((inquiry) => ({
      value: inquiry.id,
      label: inquiryLabel(
        store,
        inquiry.id,
        inquiry.quantity,
        inquiry.productId,
      ),
    }));
}

function buildUiField(field: FieldDef, store: Store): UiFieldSpec {
  const spec: UiFieldSpec = {
    name: field.name,
    label: field.label,
    type: field.type,
    required: field.required,
  };
  if (field.description) spec.description = field.description;
  if (field.hints) spec.hints = field.hints;
  if (field.refKind) spec.refKind = field.refKind;
  if (field.refFilter) spec.refFilter = field.refFilter;
  if (field.min !== undefined) spec.min = field.min;
  if (field.integer) spec.integer = true;
  if (field.type === "enum") spec.options = enumOptions(field);
  if (field.type === "ref" || field.type === "multiref") {
    spec.options = refOptions(field, store);
  }
  return spec;
}

export function buildUiSpec(capability: CapabilityDef, store: Store): UiSpec {
  return {
    capabilityId: capability.id,
    module: capability.module,
    moduleLabel: capability.moduleLabel,
    title: capability.title,
    description: capability.description,
    kind: capability.kind,
    impact: capability.impact,
    fields: capability.fields.map((field) => buildUiField(field, store)),
    submit: {
      tool: capability.id,
      label: capability.kind === "read" ? "查询" : "提交",
    },
  };
}
