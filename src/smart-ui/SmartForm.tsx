"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import type { FieldError, InvokeResult, UiSpec } from "@/lib/contract/types";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { SmartUiHost } from "@/smart-ui/host";
import { ImpactBadge } from "@/smart-ui/ImpactBadge";
import { SmartField } from "@/smart-ui/SmartField";
import { SmartResult } from "@/smart-ui/SmartResult";
import { messagesFor, validateAndCoerce } from "@/smart-ui/values";

export function SmartForm({
  spec,
  host,
  values,
  onChange,
  initialValues,
  hideHeading = false,
  readOnly = false,
  submitAccessory,
}: {
  spec: UiSpec;
  host: SmartUiHost;
  values?: Record<string, unknown>;
  onChange?: (values: Record<string, unknown>) => void;
  initialValues?: Record<string, unknown>;
  hideHeading?: boolean;
  readOnly?: boolean;
  submitAccessory?: ReactNode;
}) {
  const [uncontrolled, setUncontrolled] = useState<Record<string, unknown>>(
    () => initialValues ?? {},
  );
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [result, setResult] = useState<InvokeResult | null>(null);
  const [pending, setPending] = useState(false);
  const current = values ?? uncontrolled;

  function commit(next: Record<string, unknown>) {
    if (values === undefined) setUncontrolled(next);
    onChange?.(next);
  }

  function updateField(name: string, value: unknown) {
    commit({ ...current, [name]: value });
    setErrors((existing) => existing.filter((error) => error.field !== name));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (readOnly) return;
    setResult(null);
    const parsed = validateAndCoerce(spec, current);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors([]);
    setPending(true);
    try {
      const next = await host.invoke(spec.submit.tool, parsed.input);
      setResult(next);
      const seen = new Set<string>();
      const returned = [
        ...(next.errors ?? []),
        ...(next.issues ?? [])
          .filter((issue) => issue.level === "block" && issue.field)
          .map((issue) => ({ field: issue.field, message: issue.message })),
      ].filter((error) => {
        const key = `${error.field ?? ""}:${error.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      setErrors(returned);
    } catch (error) {
      setResult({
        status: "rejected",
        capabilityId: spec.capabilityId,
        impact: spec.impact,
        effectiveImpact: spec.impact,
        summary: error instanceof Error ? error.message : "提交失败",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      {hideHeading ? null : (
        <div className="space-y-1">
          <h2 className="text-base font-medium">{spec.title}</h2>
          <p className="text-sm text-muted-foreground">{spec.description}</p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <ImpactBadge weight={spec.impact} />
        <span className="text-xs text-muted-foreground">{spec.moduleLabel}</span>
      </div>
      {spec.kind === "write" ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {`对 Agent 而言，此操作的影响权重为 ${spec.impact}。是否需要人工审核由策略决定。`}
        </p>
      ) : null}
      <Separator />
      <div className="space-y-4">
        {spec.fields.map((field) => (
          <SmartField
            key={field.name}
            fieldId={`${spec.capabilityId}-${field.name}`}
            field={field}
            value={current[field.name]}
            messages={messagesFor(errors, field.name)}
            disabled={readOnly}
            onChange={(value) => updateField(field.name, value)}
          />
        ))}
      </div>
      {readOnly ? null : (
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          {submitAccessory}
          <Button type="submit" disabled={pending}>
            {pending ? "提交中…" : spec.submit.label}
          </Button>
        </div>
      )}
      {result ? <SmartResult result={result} /> : null}
    </form>
  );
}
