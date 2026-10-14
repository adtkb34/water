import type { Actor, InvokeResult } from "@/lib/contract/types";

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`加载失败（${response.status}）`);
  }
  return (await response.json()) as T;
}

export async function invokeWithActor(
  capabilityId: string,
  input: Record<string, unknown>,
  actor: Actor,
): Promise<InvokeResult> {
  const response = await fetch("/api/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capabilityId, input, actor }),
  });
  const body = (await response.json()) as InvokeResult;
  if (!body || typeof body.status !== "string") {
    throw new Error("调用返回无法识别");
  }
  return body;
}

export async function invokeAsHuman(
  capabilityId: string,
  input: Record<string, unknown>,
): Promise<InvokeResult> {
  return invokeWithActor(capabilityId, input, {
    kind: "human",
    surface: "workbench",
  });
}

export async function sendJson(
  url: string,
  method: "POST" | "PUT",
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { status: response.status, data };
}

export function errorMessage(data: unknown, status: number): string {
  if (!data || typeof data !== "object") return `请求失败（${status}）`;
  const record = data as { message?: unknown; error?: unknown; errors?: unknown };
  if (typeof record.error === "string" && record.error) return record.error;
  const details = Array.isArray(record.errors)
    ? record.errors
        .map((error) => {
          if (!error || typeof error !== "object" || !("message" in error)) return "";
          return typeof error.message === "string" ? error.message : "";
        })
        .filter(Boolean)
    : [];
  if (typeof record.message === "string" && record.message) {
    const extra = details.filter((detail) => detail !== record.message);
    return extra.length > 0 ? `${record.message}：${extra.join("；")}` : record.message;
  }
  if (details.length > 0) return details.join("；");
  return `请求失败（${status}）`;
}
