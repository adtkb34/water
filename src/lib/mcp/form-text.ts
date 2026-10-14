import type { UiFieldSpec, UiSpec } from "@/lib/contract/types";

const TYPE_LABEL: Record<UiFieldSpec["type"], string> = {
  string: "文本",
  number: "数字",
  date: "日期",
  enum: "枚举",
  ref: "引用",
  multiref: "多选引用",
};

function optionText(field: UiFieldSpec): string {
  const options = field.options ?? [];
  if (options.length === 0) return "";
  const rendered = options
    .map((option) =>
      option.label && option.label !== option.value
        ? `${option.label}（${option.value}）`
        : option.value,
    )
    .join("、");
  return `，可选：${rendered}`;
}

function fieldLine(field: UiFieldSpec): string {
  const required = field.required ? "必填" : "选填";
  return `- ${field.name}（${field.label}，${TYPE_LABEL[field.type]}，${required}${optionText(field)}）`;
}

export function describeForm(spec: UiSpec, mcpToolName: string): string {
  return [
    `${spec.title}。${spec.description}`,
    `可以在界面中填写，也可以直接调用工具 ${mcpToolName}。`,
    "字段：",
    ...spec.fields.map(fieldLine),
  ].join("\n");
}
