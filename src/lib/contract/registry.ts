import {
  inquiryAward,
  inquiryCreate,
  inquiryList,
  inquiryPublish,
} from "@/lib/capabilities/inquiry";
import { productCreate, productSearch } from "@/lib/capabilities/product";
import { supplierList } from "@/lib/capabilities/supplier";
import { buildUiSpec, toJsonSchema } from "@/lib/contract/derive";
import type {
  CapabilityDef,
  JsonSchema,
  Store,
  UiSpec,
} from "@/lib/contract/types";

export const capabilities: CapabilityDef[] = [
  productSearch,
  productCreate,
  inquiryList,
  inquiryCreate,
  inquiryPublish,
  inquiryAward,
  supplierList,
];

export function getCapability(id: string): CapabilityDef | undefined {
  return capabilities.find((capability) => capability.id === id);
}

export function getUiSpecs(store: Store): UiSpec[] {
  return capabilities.map((capability) => buildUiSpec(capability, store));
}

export function getJsonSchemas(): Record<string, JsonSchema> {
  return Object.fromEntries(
    capabilities.map((capability) => [capability.id, toJsonSchema(capability)]),
  );
}
