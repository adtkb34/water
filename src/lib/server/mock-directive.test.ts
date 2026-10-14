import { describe, expect, it } from "vitest";
import { decideReply, scriptedToolCall } from "../../../scripts/mock-llm";

describe("mock llm scripted directive", () => {
  it("parses [[call:<tool_name>:<json>]] into that tool call", () => {
    expect(
      scriptedToolCall('请 [[call:inquiry_publish:{"inquiryId":"Q-009","note":"a}b"}]] 谢谢'),
    ).toEqual({
      name: "inquiry_publish",
      arguments: { inquiryId: "Q-009", note: "a}b" },
    });
  });

  it("emits the directive before the built-in phrases", () => {
    expect(
      decideReply([
        {
          role: "user",
          content: '[[call:product_create:{"name":"脚本螺栓","category":"五金","unit":"件","referencePrice":3}]]',
        },
      ]),
    ).toEqual({
      kind: "tool",
      name: "product_create",
      arguments: { name: "脚本螺栓", category: "五金", unit: "件", referencePrice: 3 },
    });
  });

  it("summarizes a tool result instead of repeating the directive", () => {
    const reply = decideReply([
      { role: "user", content: '[[call:inquiry_publish:{"inquiryId":"Q-009"}]]' },
      {
        role: "tool",
        content: JSON.stringify({
          status: "pending_approval",
          summary: "该操作需要人工审核",
          approvalId: "A-001",
        }),
      },
    ]);
    expect(reply).toMatchObject({ kind: "text" });
    if (reply.kind === "text") expect(reply.text).toContain("需要人工审核");
  });
});
