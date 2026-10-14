import { describe, expect, it } from "vitest";
import { CURSOR_PREAMBLE, buildCursorPrompt, latestUserPrompt } from "@/lib/server/cursor-prompt";

describe("buildCursorPrompt", () => {
  it("adds the preamble only on the first turn and does not repeat the shortcut hint", () => {
    const hint = "用户通过快捷入口选择了能力：新建询价";
    const first = buildCursorPrompt({ userText: "查看现有的询价单", firstTurn: true, hint });
    expect(first.startsWith(CURSOR_PREAMBLE)).toBe(true);
    expect(first).toContain("查看现有的询价单");
    expect(first).toContain(hint);
    const again = buildCursorPrompt({ userText: `继续\n${hint}`, firstTurn: false, hint });
    expect(again.includes(CURSOR_PREAMBLE)).toBe(false);
    expect(again.split(hint)).toHaveLength(2);
    expect(buildCursorPrompt({ userText: "", firstTurn: false })).toBe("请继续。");
  });

  it("reads the latest user message and its shortcut metadata", () => {
    const prompt = latestUserPrompt(
      [
        { id: "u0", role: "user", parts: [{ type: "text", text: "旧的" }] },
        { id: "a", role: "assistant", parts: [{ type: "text", text: "好" }] },
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "查看现有的询价单" }],
          metadata: {
            capabilityId: "inquiry.create",
            references: [{ id: "S-001", kind: "supplier", label: "沪上紧固件" }],
          },
        },
      ],
      true,
    );
    expect(prompt.startsWith(CURSOR_PREAMBLE)).toBe(true);
    expect(prompt).toContain("查看现有的询价单");
    expect(prompt).toContain("创建询价");
    expect(prompt).toContain("沪上紧固件");
  });
});
