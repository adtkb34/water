import { describe, expect, it } from "vitest";
import { classifyCursorFailure, cursorErrorText, isUnknownCursorAgent, maskCursorAccount } from "@/lib/server/cursor-errors";

const KEY = "cursor_test_KEY_should_not_leak_zz91";

describe("cursor failure mapping", () => {
  it("maps auth, rate limit, network, and unknown agents without echoing the key", () => {
    expect(classifyCursorFailure({ name: "AuthenticationError", message: `bad ${KEY}` }).kind).toBe("auth");
    expect(classifyCursorFailure({ status: 429, message: "quota exceeded" }).kind).toBe("rate");
    expect(classifyCursorFailure({ name: "NetworkError", message: "fetch failed" }).kind).toBe("network");
    expect(isUnknownCursorAgent({ name: "AgentNotFoundError", message: "missing" })).toBe(true);
    expect(isUnknownCursorAgent({ name: "AuthenticationError", message: "invalid api key" })).toBe(false);
    const text = cursorErrorText({ name: "AuthenticationError", message: KEY }, [KEY]);
    expect(text).toContain("Cursor API Key 无效或已过期");
    expect(text).not.toContain(KEY);
    expect(maskCursorAccount({ userEmail: "ada@example.com" })).toBe("a***@example.com");
  });
});
