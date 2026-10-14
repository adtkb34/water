import type { RefKind, UiSpec } from "@/lib/contract/types";

export function writeSpecs(specs: UiSpec[]): UiSpec[] {
  return specs.filter((spec) => spec.kind === "write");
}

export function moduleWriteSpecs(
  specs: UiSpec[],
  module: UiSpec["module"],
): UiSpec[] {
  return writeSpecs(specs).filter((spec) => spec.module === module);
}

function referencesInquiry(spec: UiSpec): boolean {
  return spec.fields.some((field) => field.refKind === "inquiry");
}

export function inquiryRelevantSpecs(specs: UiSpec[]): UiSpec[] {
  return writeSpecs(specs).filter(
    (spec) => spec.module === "inquiry" || referencesInquiry(spec),
  );
}

export function inquiryRowSpecs(specs: UiSpec[], status: string): UiSpec[] {
  return inquiryRelevantSpecs(specs).filter((spec) =>
    spec.fields.some(
      (field) =>
        field.refKind === "inquiry" && Boolean(field.refFilter?.includes(status)),
    ),
  );
}

export function inquiryCreateSpecs(specs: UiSpec[]): UiSpec[] {
  return inquiryRelevantSpecs(specs).filter((spec) => !referencesInquiry(spec));
}

export function prefillRef(
  spec: UiSpec,
  refKind: RefKind,
  id: string,
): Record<string, unknown> {
  const field = spec.fields.find((item) => item.refKind === refKind);
  if (!field) return {};
  if (field.type === "multiref") return { [field.name]: [id] };
  return { [field.name]: id };
}
