import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { UiFieldSpec } from "@/lib/contract/types";
import { readList, readText } from "@/smart-ui/values";

export function SmartField({
  fieldId,
  field,
  value,
  messages,
  onChange,
  disabled = false,
}: {
  fieldId: string;
  field: UiFieldSpec;
  value: unknown;
  messages: string[];
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  const invalid = messages.length > 0;
  const describedBy = [
    field.description ? `${fieldId}-description` : "",
    invalid ? `${fieldId}-error` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="space-y-1.5" data-field={field.name}>
      {field.type === "multiref" ? (
        <div className="text-sm font-medium" id={`${fieldId}-label`}>
          {field.label}
          {field.required ? (
            <span aria-hidden="true" className="ml-1 text-destructive">
              *
            </span>
          ) : null}
        </div>
      ) : (
        <Label htmlFor={fieldId}>
          {field.label}
          {field.required ? (
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
          ) : null}
        </Label>
      )}
      {field.description ? (
        <p id={`${fieldId}-description`} className="text-xs text-muted-foreground">
          {field.description}
        </p>
      ) : null}
      <FieldControl
        fieldId={fieldId}
        field={field}
        value={value}
        invalid={invalid}
        describedBy={describedBy || undefined}
        disabled={disabled}
        onChange={onChange}
      />
      {invalid ? (
        <p id={`${fieldId}-error`} role="alert" className="text-xs text-destructive">
          {messages.join("；")}
        </p>
      ) : null}
    </div>
  );
}

function FieldControl({
  fieldId,
  field,
  value,
  invalid,
  describedBy,
  disabled = false,
  onChange,
}: {
  fieldId: string;
  field: UiFieldSpec;
  value: unknown;
  invalid: boolean;
  describedBy?: string;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  if (field.type === "string") {
    return (
      <Input
        id={fieldId}
        name={field.name}
        value={readText(value)}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  if (field.type === "number") {
    return (
      <Input
        id={fieldId}
        name={field.name}
        type="number"
        inputMode={field.integer ? "numeric" : "decimal"}
        min={field.min}
        step={field.integer ? 1 : "any"}
        value={readText(value)}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  if (field.type === "date") {
    return (
      <Input
        id={fieldId}
        name={field.name}
        type="date"
        value={readText(value)}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  if (field.type === "multiref") {
    const selected = readList(value);
    const options = field.options ?? [];
    if (options.length === 0) {
      return <p className="text-xs text-muted-foreground">暂无可选项</p>;
    }
    return (
      <div
        role="group"
        aria-labelledby={`${fieldId}-label`}
        aria-describedby={describedBy}
        className="max-h-48 space-y-2 overflow-y-auto rounded-lg border p-2"
      >
        {options.map((option) => {
          const optionId = `${fieldId}-${option.value}`;
          const checked = selected.includes(option.value);
          return (
            <label
              key={option.value}
              htmlFor={optionId}
              className="flex items-center gap-2 text-sm"
            >
                <Checkbox
                  id={optionId}
                  checked={checked}
                  aria-label={option.label}
                  disabled={disabled}
                  onCheckedChange={(next) => {
                  const list = next
                    ? [...selected, option.value]
                    : selected.filter((item) => item !== option.value);
                  onChange(list);
                }}
              />
              <span>{option.label}</span>
            </label>
          );
        })}
      </div>
    );
  }

  const options = field.options ?? [];
  const current = typeof value === "string" && value ? value : null;
  return (
    <Select
      value={current}
      onValueChange={(next) => onChange(next ?? "")}
      items={options}
      disabled={disabled || options.length === 0}
    >
      <SelectTrigger
        id={fieldId}
        className="w-full"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      >
        <SelectValue placeholder={options.length === 0 ? "暂无可选项" : "请选择"} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
