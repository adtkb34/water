import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import * as z from "zod";
import {
  ENV_CURSOR_PROVIDER_ID,
  ENV_PROVIDER_ID,
  maskApiKey,
  type ProviderKind,
  type ProviderList,
  type PublicProvider,
} from "@/lib/providers/public";

export interface StoredProvider {
  id: string;
  kind?: ProviderKind;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
  createdAt: string;
}

interface ProviderFile {
  defaultId: string | null;
  providers: StoredProvider[];
}

const httpUrl = z
  .string()
  .trim()
  .min(1, "请填写 Base URL")
  .refine((value) => {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") return false;
      if (url.username || url.password) return false;
      return true;
    } catch {
      return false;
    }
  }, "Base URL 必须是 http 或 https 地址，且不能把密钥写在地址里");

const modelName = z.string().trim().min(1, "请填写模型名").max(200, "模型名过长");
const providerName = z.string().trim().min(1, "请填写名称").max(80, "名称过长");

export type ProviderFailure = { ok: false; status: number; error: string };
export type ProviderSuccess<T> = { ok: true } & T;

function dataDir(): string {
  return process.env.AGENT_DATA_DIR?.trim() || path.join(process.cwd(), "data");
}

export function providersPath(): string {
  return path.join(dataDir(), "providers.json");
}

function emptyFile(): ProviderFile {
  return { defaultId: null, providers: [] };
}

function readFile(): ProviderFile {
  const file = providersPath();
  if (!existsSync(file)) return emptyFile();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error("模型配置无法读取");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("模型配置无法读取");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyFile();
  const record = parsed as { defaultId?: unknown; providers?: unknown };
  const providers = Array.isArray(record.providers)
    ? record.providers.filter(isStoredProvider).filter((item) => item.id !== ENV_PROVIDER_ID && item.id !== ENV_CURSOR_PROVIDER_ID)
    : [];
  const defaultId = typeof record.defaultId === "string" ? record.defaultId : null;
  return { defaultId, providers };
}

function isStoredProvider(value: unknown): value is StoredProvider {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<StoredProvider> & { kind?: unknown };
  if (item.kind !== undefined && item.kind !== "openai-compatible" && item.kind !== "cursor") return false;
  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    typeof item.baseUrl === "string" &&
    typeof item.apiKey === "string" &&
    typeof item.model === "string" &&
    typeof item.createdAt === "string"
  );
}

export function providerKind(provider: StoredProvider): ProviderKind {
  return provider.kind === "cursor" ? "cursor" : "openai-compatible";
}

function writeFile(data: ProviderFile) {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const target = providersPath();
  const tmp = path.join(dir, `.providers.${process.pid}.tmp`);
  const body: ProviderFile = {
    defaultId: data.defaultId,
    providers: data.providers.map((item) => ({
      id: item.id,
      kind: providerKind(item),
      name: item.name,
      baseUrl: providerKind(item) === "cursor" ? "" : item.baseUrl,
      apiKey: item.apiKey,
      model: item.model,
      createdAt: item.createdAt,
      ...(providerKind(item) !== "cursor" && item.headers && Object.keys(item.headers).length > 0
        ? { headers: item.headers }
        : {}),
    })),
  };
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  renameSync(tmp, target);
}

export function resetProvidersForTests() {
  const file = providersPath();
  if (existsSync(file)) rmSync(file);
}

function envProvider(): StoredProvider | null {
  const baseUrl = process.env.LLM_BASE_URL?.trim() ?? "";
  const model = process.env.LLM_MODEL?.trim() ?? "";
  if (!baseUrl || !model) return null;
  const parsedUrl = httpUrl.safeParse(baseUrl);
  const parsedModel = modelName.safeParse(model);
  if (!parsedUrl.success || !parsedModel.success) return null;
  return {
    id: ENV_PROVIDER_ID,
    name: "环境变量",
    baseUrl: parsedUrl.data,
    apiKey: process.env.LLM_API_KEY?.trim() ?? "",
    model: parsedModel.data,
    kind: "openai-compatible",
    createdAt: "1970-01-01T00:00:00.000Z",
  };
}

function envCursorProvider(): StoredProvider | null {
  const apiKey = process.env.CURSOR_API_KEY?.trim() ?? "";
  if (!apiKey) return null;
  return {
    id: ENV_CURSOR_PROVIDER_ID,
    kind: "cursor",
    name: "Cursor（环境变量）",
    baseUrl: "",
    apiKey,
    model: "composer-2",
    createdAt: "1970-01-01T00:00:00.000Z",
  };
}

function allStored(): { file: ProviderFile; providers: StoredProvider[] } {
  const file = readFile();
  const extras = [envProvider(), envCursorProvider()].filter((item): item is StoredProvider => item !== null);
  return { file, providers: [...file.providers, ...extras] };
}

function effectiveDefault(file: ProviderFile, providers: StoredProvider[]): string | null {
  if (file.defaultId && providers.some((item) => item.id === file.defaultId)) {
    return file.defaultId;
  }
  if (providers.some((item) => item.id === ENV_PROVIDER_ID)) return ENV_PROVIDER_ID;
  if (providers.some((item) => item.id === ENV_CURSOR_PROVIDER_ID)) return ENV_CURSOR_PROVIDER_ID;
  return null;
}

function isReadOnlyProvider(id: string): boolean {
  return id === ENV_PROVIDER_ID || id === ENV_CURSOR_PROVIDER_ID;
}

export function toPublic(provider: StoredProvider, readOnly: boolean): PublicProvider {
  const kind = providerKind(provider);
  return {
    id: provider.id,
    kind,
    name: provider.name,
    baseUrl: kind === "cursor" ? "" : provider.baseUrl,
    model: provider.model,
    apiKeyMasked: maskApiKey(provider.apiKey),
    hasKey: provider.apiKey.length > 0,
    headerNames: kind === "cursor" ? [] : Object.keys(provider.headers ?? {}),
    createdAt: provider.createdAt,
    readOnly,
  };
}

export function listProviders(): ProviderList {
  const { file, providers } = allStored();
  const defaultId = effectiveDefault(file, providers);
  return {
    defaultId,
    providers: providers.map((item) => toPublic(item, isReadOnlyProvider(item.id))),
  };
}

export function getStoredProvider(id: string): StoredProvider | undefined {
  const provider = allStored().providers.find((item) => item.id === id);
  if (!provider) return undefined;
  if (providerKind(provider) !== "cursor") return { ...provider, kind: "openai-compatible" };
  return { ...provider, kind: "cursor", baseUrl: "", headers: undefined };
}

function parseHeaders(value: unknown): { ok: true; headers?: Record<string, string> } | ProviderFailure {
  if (value === undefined) return { ok: true };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, status: 422, error: "headers 必须是字符串到字符串的对象" };
  }
  const headers: Record<string, string> = {};
  const entries = Object.entries(value);
  if (entries.length > 20) return { ok: false, status: 422, error: "请求头最多 20 个" };
  for (const [key, item] of entries) {
    if (!/^[A-Za-z0-9-]+$/.test(key)) {
      return { ok: false, status: 422, error: "请求头名称只能包含字母、数字和连字符" };
    }
    if (typeof item !== "string") {
      return { ok: false, status: 422, error: `请求头 ${key} 的值必须是文本` };
    }
    if (item.length > 2000) return { ok: false, status: 422, error: `请求头 ${key} 过长` };
    headers[key] = item;
  }
  return { ok: true, headers };
}

function issueMessage(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message || fallback;
}

function readKind(value: unknown): ProviderKind | ProviderFailure {
  if (value === undefined || value === "openai-compatible") return "openai-compatible";
  if (value === "cursor") return "cursor";
  return { ok: false, status: 422, error: "kind 只能是 openai-compatible 或 cursor" };
}

function readApiKey(value: unknown): string | ProviderFailure {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return { ok: false, status: 422, error: "API Key 必须是文本" };
  return value;
}

export function createProvider(input: unknown): ProviderSuccess<{ provider: PublicProvider }> | ProviderFailure {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, status: 422, error: "请求体必须是 JSON 对象" };
  }
  const body = input as Record<string, unknown>;
  const kind = readKind(body.kind);
  if (typeof kind !== "string") return kind;
  const name = providerName.safeParse(body.name);
  if (!name.success) return { ok: false, status: 422, error: issueMessage(name.error, "请填写名称") };
  const apiKey = readApiKey(body.apiKey);
  if (typeof apiKey !== "string") return apiKey;

  let baseUrl = "";
  let model = "";
  let headers: Record<string, string> | undefined;
  if (kind === "cursor") {
    if (typeof body.baseUrl === "string" && body.baseUrl.trim()) {
      return { ok: false, status: 422, error: "Cursor 引擎不使用 Base URL" };
    }
    if (body.headers !== undefined) {
      const parsed = parseHeaders(body.headers);
      if (!parsed.ok) return parsed;
      if (parsed.headers && Object.keys(parsed.headers).length > 0) {
        return { ok: false, status: 422, error: "Cursor 引擎不使用自定义请求头" };
      }
    }
    const modelInput = body.model === undefined || body.model === "" ? "composer-2" : body.model;
    const parsedModel = modelName.safeParse(modelInput);
    if (!parsedModel.success) return { ok: false, status: 422, error: issueMessage(parsedModel.error, "请填写模型名") };
    model = parsedModel.data;
  } else {
    const parsedUrl = httpUrl.safeParse(body.baseUrl);
    if (!parsedUrl.success) return { ok: false, status: 422, error: issueMessage(parsedUrl.error, "Base URL 不合法") };
    const parsedModel = modelName.safeParse(body.model);
    if (!parsedModel.success) return { ok: false, status: 422, error: issueMessage(parsedModel.error, "请填写模型名") };
    const parsedHeaders = parseHeaders(body.headers);
    if (!parsedHeaders.ok) return parsedHeaders;
    baseUrl = parsedUrl.data;
    model = parsedModel.data;
    headers = parsedHeaders.headers;
  }

  const file = readFile();
  const provider: StoredProvider = {
    id: crypto.randomUUID(),
    kind,
    name: name.data,
    baseUrl,
    model,
    apiKey,
    createdAt: new Date().toISOString(),
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
  };
  file.providers.push(provider);
  if (!file.defaultId && !envProvider() && !envCursorProvider()) file.defaultId = provider.id;
  writeFile(file);
  return { ok: true, provider: toPublic(provider, false) };
}

export function updateProvider(
  id: string,
  input: unknown,
): ProviderSuccess<{ provider: PublicProvider }> | ProviderFailure {
  if (isReadOnlyProvider(id)) return { ok: false, status: 403, error: "环境变量提供方是只读的" };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, status: 422, error: "请求体必须是 JSON 对象" };
  }
  const file = readFile();
  const current = file.providers.find((item) => item.id === id);
  if (!current) return { ok: false, status: 404, error: "找不到这个模型配置" };
  const body = input as Record<string, unknown>;
  const nextKind = body.kind === undefined ? providerKind(current) : readKind(body.kind);
  if (typeof nextKind !== "string") return nextKind;

  if (body.name !== undefined) {
    const name = providerName.safeParse(body.name);
    if (!name.success) return { ok: false, status: 422, error: issueMessage(name.error, "请填写名称") };
    current.name = name.data;
  }
  if (body.model !== undefined) {
    const model = modelName.safeParse(body.model);
    if (!model.success) return { ok: false, status: 422, error: issueMessage(model.error, "请填写模型名") };
    current.model = model.data;
  }
  if (body.apiKey !== undefined && body.apiKey !== null) {
    if (typeof body.apiKey !== "string") return { ok: false, status: 422, error: "API Key 必须是文本" };
    if (body.apiKey.trim()) current.apiKey = body.apiKey;
  }

  if (nextKind === "cursor") {
    if (typeof body.baseUrl === "string" && body.baseUrl.trim()) {
      return { ok: false, status: 422, error: "Cursor 引擎不使用 Base URL" };
    }
    if (body.headers !== undefined) {
      const headers = parseHeaders(body.headers);
      if (!headers.ok) return headers;
      if (headers.headers && Object.keys(headers.headers).length > 0) {
        return { ok: false, status: 422, error: "Cursor 引擎不使用自定义请求头" };
      }
    }
    current.kind = "cursor";
    current.baseUrl = "";
    delete current.headers;
    if (!current.model.trim()) current.model = "composer-2";
  } else {
    if (body.baseUrl !== undefined) {
      const baseUrl = httpUrl.safeParse(body.baseUrl);
      if (!baseUrl.success) return { ok: false, status: 422, error: issueMessage(baseUrl.error, "Base URL 不合法") };
      current.baseUrl = baseUrl.data;
    } else if (providerKind(current) === "cursor" || !current.baseUrl.trim()) {
      return { ok: false, status: 422, error: "请填写 Base URL" };
    }
    if (body.headers !== undefined) {
      const headers = parseHeaders(body.headers);
      if (!headers.ok) return headers;
      if (headers.headers && Object.keys(headers.headers).length > 0) current.headers = headers.headers;
      else delete current.headers;
    }
    current.kind = "openai-compatible";
  }

  writeFile(file);
  return { ok: true, provider: toPublic(current, false) };
}

export function deleteProvider(id: string): ProviderSuccess<{ id: string }> | ProviderFailure {
  if (isReadOnlyProvider(id)) return { ok: false, status: 403, error: "环境变量提供方是只读的" };
  const file = readFile();
  const index = file.providers.findIndex((item) => item.id === id);
  if (index < 0) return { ok: false, status: 404, error: "找不到这个模型配置" };
  file.providers.splice(index, 1);
  if (file.defaultId === id) file.defaultId = null;
  writeFile(file);
  return { ok: true, id };
}

export function setDefaultProvider(id: string | null): ProviderSuccess<{ defaultId: string | null }> | ProviderFailure {
  const { file, providers } = allStored();
  if (id !== null && !providers.some((item) => item.id === id)) {
    return { ok: false, status: 404, error: "找不到这个模型配置" };
  }
  file.defaultId = id;
  writeFile(file);
  const next = allStored();
  return { ok: true, defaultId: effectiveDefault(next.file, next.providers) };
}

export function providerSecrets(provider: StoredProvider): string[] {
  return [provider.apiKey, ...Object.values(provider.headers ?? {})].filter((item) => item.length > 0);
}
