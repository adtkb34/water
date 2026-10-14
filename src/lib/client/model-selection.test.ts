import { describe, expect, it } from "vitest";
import { modelChoiceLabel, resolveModelSelection } from "@/lib/client/model-selection";
import { GUIDED_MODEL_ID } from "@/lib/providers/public";

const providers = [{ id: "a" }, { id: "b" }];

describe("resolveModelSelection", () => {
  it("uses the default provider when nothing is stored", () => {
    expect(resolveModelSelection(null, providers, "b")).toEqual({
      id: "b",
      fellBackToGuided: false,
    });
  });

  it("uses guided mode when nothing is stored and there is no default", () => {
    expect(resolveModelSelection("", providers, null)).toEqual({
      id: GUIDED_MODEL_ID,
      fellBackToGuided: false,
    });
  });

  it("keeps a stored provider that still exists", () => {
    expect(resolveModelSelection("a", providers, "b")).toEqual({
      id: "a",
      fellBackToGuided: false,
    });
  });

  it("falls back to guided mode when the stored provider was removed", () => {
    expect(resolveModelSelection("gone", providers, "b")).toEqual({
      id: GUIDED_MODEL_ID,
      fellBackToGuided: true,
    });
  });

  it("labels Cursor providers in the selector", () => {
    expect(modelChoiceLabel({ name: "Cursor（订阅额度）", model: "composer-2", kind: "cursor" })).toBe(
      "Cursor（订阅额度） · composer-2 · Cursor",
    );
    expect(modelChoiceLabel({ name: "本地", model: "mock", kind: "openai-compatible" })).toBe("本地 · mock");
  });

  it("stays on guided mode when that is the stored selection", () => {
    expect(resolveModelSelection(GUIDED_MODEL_ID, providers, "a").fellBackToGuided).toBe(false);
    expect(resolveModelSelection(GUIDED_MODEL_ID, providers, "a").id).toBe(GUIDED_MODEL_ID);
  });
});
