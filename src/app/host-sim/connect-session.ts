export interface ConnectSession<T> {
  run: () => Promise<T>;
  close: () => Promise<void>;
}

export async function connectWithRetry<T>(options: {
  open: () => ConnectSession<T>;
  isCancelled?: () => boolean;
  attempts?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<T> {
  const attempts = options.attempts ?? 4;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown = new Error("无法连接 MCP");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.isCancelled?.()) throw new Error("已取消连接");
    const session = options.open();
    try {
      return await finishAttempt(session, timeoutMs);
    } catch (error) {
      lastError = error;
      await session.close().catch(() => undefined);
      if (options.isCancelled?.()) throw error;
      if (attempt < attempts - 1) await sleep(200 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("无法连接 MCP");
}

function finishAttempt<T>(session: ConnectSession<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void session.close().catch(() => undefined);
      reject(new Error("连接超时"));
    }, timeoutMs);
    session.run().then(
      (value) => {
        if (settled) {
          void session.close().catch(() => undefined);
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
