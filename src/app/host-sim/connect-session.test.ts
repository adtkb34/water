import { describe, expect, it } from "vitest";
import { connectWithRetry, type ConnectSession } from "@/app/host-sim/connect-session";

function session<T>(id: string, run: () => Promise<T>, closed: string[]): ConnectSession<T> {
  return {
    run,
    close: async () => {
      closed.push(id);
    },
  };
}

describe("connectWithRetry", () => {
  it("closes a handshake that never settles and uses the next attempt", async () => {
    const closed: string[] = [];
    let opened = 0;
    const tools = await connectWithRetry({
      attempts: 3,
      timeoutMs: 25,
      sleep: async () => undefined,
      open: () => {
        opened += 1;
        const id = `c${opened}`;
        if (opened === 1) return session(id, () => new Promise(() => undefined), closed);
        return session(id, async () => [{ name: "show_form" }], closed);
      },
    });
    expect(tools).toEqual([{ name: "show_form" }]);
    expect(closed).toContain("c1");
    expect(closed).not.toContain("c2");
  });

  it("retries after the first attempt fails", async () => {
    const closed: string[] = [];
    let opened = 0;
    const tools = await connectWithRetry({
      attempts: 2,
      timeoutMs: 1_000,
      sleep: async () => undefined,
      open: () => {
        opened += 1;
        const id = `c${opened}`;
        if (opened === 1) return session(id, async () => Promise.reject(new Error("aborted")), closed);
        return session(id, async () => [{ name: "inquiry_list" }], closed);
      },
    });
    expect(tools).toEqual([{ name: "inquiry_list" }]);
    expect(closed).toEqual(["c1"]);
  });

  it("stops when the caller cancels", async () => {
    let opened = 0;
    let cancelled = false;
    await expect(
      connectWithRetry({
        attempts: 4,
        timeoutMs: 1_000,
        sleep: async () => {
          cancelled = true;
        },
        isCancelled: () => cancelled,
        open: () => {
          opened += 1;
          return session("c", async () => Promise.reject(new Error("aborted")), []);
        },
      }),
    ).rejects.toThrow("已取消连接");
    expect(opened).toBe(1);
  });
});
