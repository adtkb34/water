import * as z from "zod";
import { toJsonSchema, toZod } from "@/lib/contract/derive";
import type { CapabilityDef } from "@/lib/contract/types";

export function capabilityToolDescription(capability: CapabilityDef): string {
  const description = capability.description.endsWith("。")
    ? capability.description
    : `${capability.description}。`;
  const review = capability.alwaysReview ? "默认需要人工审核。" : "";
  return `${capability.title}。${description}影响权重 ${capability.impact}。${review}`;
}

export function capabilityInputSchema(capability: CapabilityDef) {
  const parsed = toZod(capability.fields);
  const json = toJsonSchema(capability);
  const shape: Record<string, z.ZodType> = {};
  for (const field of capability.fields) {
    const description =
      json.properties[field.name]?.description ?? field.label;
    shape[field.name] = parsed.shape[field.name].describe(description);
  }
  return z.object(shape);
}
