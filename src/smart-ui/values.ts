import type { FieldError, UiFieldSpec, UiSpec } from "@/lib/contract/types";
import { isRealDate } from "@/lib/dates";

export function readText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value;
  return "";
}

export function readList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function numberMessage(field: UiFieldSpec): string {
  if (field.integer && field.min !== undefined) {
    return `${field.label}必须是不小于${field.min}的整数`;
  }
  if (field.integer) return `${field.label}必须是整数`;
  if (field.min !== undefined) {
    return `${field.label}必须是不小于${field.min}的数字`;
  }
  return `${field.label}必须是数字`;
}

function allowed(field: UiFieldSpec, value: string): boolean {
  if (!field.options) return true;
  return field.options.some((option) => option.value === value);
}

export function validateAndCoerce(
  spec: UiSpec,
  values: Record<string, unknown>,
):
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const input: Record<string, unknown> = {};

  for (const field of spec.fields) {
    const value = values[field.name];
    if (field.type === "string") {
      const text = readText(value).trim();
      if (!text) {
        if (field.required) {
          errors.push({ field: field.name, message: `请填写${field.label}` });
        }
        continue;
      }
      input[field.name] = text;
      continue;
    }

    if (field.type === "number") {
      const text = readText(value).trim();
      if (!text) {
        if (field.required) {
          errors.push({ field: field.name, message: `请填写${field.label}` });
        }
        continue;
      }
      const parsed = Number(text);
      const invalid =
        !Number.isFinite(parsed) ||
        (field.integer && !Number.isInteger(parsed)) ||
        (field.min !== undefined && parsed < field.min);
      if (invalid) {
        errors.push({ field: field.name, message: numberMessage(field) });
        continue;
      }
      input[field.name] = parsed;
      continue;
    }

    if (field.type === "date") {
      const text = readText(value).trim();
      if (!text) {
        if (field.required) {
          errors.push({ field: field.name, message: `请填写${field.label}` });
        }
        continue;
      }
      if (!isRealDate(text)) {
        errors.push({
          field: field.name,
          message: `${field.label}必须是 YYYY-MM-DD 格式的日期，例如 2026-12-31`,
        });
        continue;
      }
      input[field.name] = text;
      continue;
    }

    if (field.type === "enum" || field.type === "ref") {
      const text = typeof value === "string" ? value.trim() : "";
      if (!text) {
        if (field.required) {
          errors.push({ field: field.name, message: `请选择${field.label}` });
        }
        continue;
      }
      if (!allowed(field, text)) {
        const labels = (field.options ?? []).map((option) => option.label).join("、");
        errors.push({
          field: field.name,
          message: `${field.label}必须是以下之一：${labels}`,
        });
        continue;
      }
      input[field.name] = text;
      continue;
    }

    const list = readList(value);
    if (list.length === 0) {
      if (field.required) {
        errors.push({
          field: field.name,
          message: `请至少选择一个${field.label}`,
        });
      }
      continue;
    }
    if (list.some((item) => !allowed(field, item))) {
      const labels = (field.options ?? []).map((option) => option.label).join("、");
      errors.push({
        field: field.name,
        message: `${field.label}必须是以下之一：${labels}`,
      });
      continue;
    }
    input[field.name] = list;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, input };
}

export function messagesFor(errors: FieldError[], name: string): string[] {
  return errors
    .filter((error) => error.field === name)
    .map((error) => error.message);
}
