import { describe, expect, it } from "vitest";
import {
  inquiryCreateSpecs,
  inquiryRelevantSpecs,
  inquiryRowSpecs,
  moduleWriteSpecs,
} from "@/lib/client/specs";
import type { UiFieldSpec, UiSpec } from "@/lib/contract/types";

function field(
  name: string,
  refKind?: UiFieldSpec["refKind"],
  refFilter?: string[],
): UiFieldSpec {
  return {
    name,
    label: name,
    type: refKind ? "ref" : "string",
    required: true,
    ...(refKind ? { refKind } : {}),
    ...(refFilter ? { refFilter } : {}),
  };
}

function writeSpec(
  partial: Pick<UiSpec, "capabilityId" | "module" | "fields">,
): UiSpec {
  return {
    moduleLabel: partial.module,
    title: partial.capabilityId,
    description: "",
    kind: "write",
    impact: 1,
    submit: { tool: partial.capabilityId, label: "提交" },
    ...partial,
  };
}

const specs = [
  writeSpec({
    capabilityId: "product.create",
    module: "product",
    fields: [field("name")],
  }),
  writeSpec({
    capabilityId: "inquiry.create",
    module: "inquiry",
    fields: [field("productId", "product")],
  }),
  writeSpec({
    capabilityId: "inquiry.publish",
    module: "inquiry",
    fields: [field("inquiryId", "inquiry", ["draft"])],
  }),
  writeSpec({
    capabilityId: "inquiry.award",
    module: "procurement",
    fields: [field("inquiryId", "inquiry", ["published"])],
  }),
];

describe("inquiry spec filters", () => {
  it("keeps inquiry-relevant writes and drops unrelated modules", () => {
    expect(inquiryRelevantSpecs(specs).map((spec) => spec.capabilityId)).toEqual([
      "inquiry.create",
      "inquiry.publish",
      "inquiry.award",
    ]);
    expect(inquiryCreateSpecs(specs).map((spec) => spec.capabilityId)).toEqual([
      "inquiry.create",
    ]);
    expect(moduleWriteSpecs(specs, "product").map((spec) => spec.capabilityId)).toEqual([
      "product.create",
    ]);
  });

  it("puts publish and award on the matching inquiry rows", () => {
    expect(inquiryRowSpecs(specs, "draft").map((spec) => spec.capabilityId)).toEqual([
      "inquiry.publish",
    ]);
    expect(inquiryRowSpecs(specs, "published").map((spec) => spec.capabilityId)).toEqual([
      "inquiry.award",
    ]);
  });
});
