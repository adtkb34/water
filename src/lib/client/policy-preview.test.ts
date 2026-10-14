import { describe, expect, it } from "vitest";
import { agentNeedsReview } from "@/lib/client/policy-preview";

describe("agentNeedsReview", () => {
  it("requires review when the base weight meets the threshold", () => {
    expect(
      agentNeedsReview({
        kind: "write",
        impact: 6,
        capabilityId: "inquiry.publish",
        threshold: 6,
        alwaysReview: [],
      }),
    ).toBe(true);
  });

  it("lets a write run when the base weight is below the threshold and it is not listed", () => {
    expect(
      agentNeedsReview({
        kind: "write",
        impact: 6,
        capabilityId: "inquiry.publish",
        threshold: 7,
        alwaysReview: ["inquiry.award"],
      }),
    ).toBe(false);
  });

  it("requires review when the capability is listed, even below the threshold", () => {
    expect(
      agentNeedsReview({
        kind: "write",
        impact: 2,
        capabilityId: "product.create",
        threshold: 10,
        alwaysReview: ["product.create"],
      }),
    ).toBe(true);
  });

  it("does not review reads", () => {
    expect(
      agentNeedsReview({
        kind: "read",
        impact: 0,
        capabilityId: "product.search",
        threshold: 0,
        alwaysReview: ["product.search"],
      }),
    ).toBe(false);
  });
});
