import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "@/components/chat/composer";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
});

describe("model selector", () => {
  it("shows Cursor providers", () => {
    render(
      <Composer
        specs={[]}
        mentions={[]}
        models={[
          { value: "openai-1", label: "本地 · mock" },
          { value: "cursor-1", label: "Cursor（订阅额度） · composer-2 · Cursor", badge: "Cursor" },
        ]}
        modelId="cursor-1"
        onModelChange={() => undefined}
        onSend={() => undefined}
      />,
    );
    expect(screen.getByRole("combobox", { name: "模型" }).textContent).toContain("Cursor");
  });
});
