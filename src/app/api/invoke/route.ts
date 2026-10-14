import { NextResponse } from "next/server";
import { getCapability } from "@/lib/contract/registry";
import type { Actor, InvokeResult } from "@/lib/contract/types";
import { invoke } from "@/lib/server/invoke";

const ACTOR_KINDS = new Set<Actor["kind"]>(["human", "agent"]);
const ACTOR_SURFACES = new Set<Actor["surface"]>([
  "workbench",
  "chat",
  "mcp",
  "llm",
]);

function json(body: unknown, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

const DEFAULT_ACTOR: Actor = { kind: "agent", surface: "llm" };

function rejected(
  capabilityId: string,
  summary: string,
  errors: InvokeResult["errors"],
  status: number,
): Response {
  const body: InvokeResult = {
    status: "rejected",
    capabilityId,
    impact: 0,
    effectiveImpact: 0,
    summary,
    errors,
  };
  return json(body, status);
}

function parseActor(
  value: unknown,
): { ok: true; actor: Actor } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, actor: DEFAULT_ACTOR };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "actor 必须是对象，包含 kind 与 surface" };
  }
  const actor = value as { kind?: unknown; surface?: unknown };
  if (!ACTOR_KINDS.has(actor.kind as Actor["kind"])) {
    return { ok: false, message: "actor.kind 必须是 human 或 agent" };
  }
  if (!ACTOR_SURFACES.has(actor.surface as Actor["surface"])) {
    return {
      ok: false,
      message: "actor.surface 必须是 workbench、chat、mcp 或 llm",
    };
  }
  return {
    ok: true,
    actor: {
      kind: actor.kind as Actor["kind"],
      surface: actor.surface as Actor["surface"],
    },
  };
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return rejected("", "请求体不是合法的 JSON", [
      { message: "请求体不是合法的 JSON" },
    ], 422);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return rejected("", "请求体必须是 JSON 对象", [
      { message: "请求体必须是 JSON 对象" },
    ], 422);
  }

  const payload = body as {
    capabilityId?: unknown;
    input?: unknown;
    actor?: unknown;
  };
  if (typeof payload.capabilityId !== "string" || !payload.capabilityId) {
    return rejected("", "请提供能力编号 capabilityId", [
      { field: "capabilityId", message: "请提供能力编号 capabilityId" },
    ], 422);
  }

  const actor = parseActor(payload.actor);
  if (!actor.ok) {
    return rejected(payload.capabilityId, actor.message, [
      { field: "actor", message: actor.message },
    ], 422);
  }

  const known = Boolean(getCapability(payload.capabilityId));
  const result = invoke({
    capabilityId: payload.capabilityId,
    input: payload.input,
    actor: actor.actor,
  });
  if (!known) return json(result, 404);
  const status =
    result.status === "executed"
      ? 200
      : result.status === "pending_approval"
        ? 202
        : 422;
  return json(result, status);
}
