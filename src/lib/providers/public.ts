export const ENV_PROVIDER_ID = "env";
export const ENV_CURSOR_PROVIDER_ID = "env-cursor";
export const GUIDED_MODEL_ID = "guided";

export type ProviderKind = "openai-compatible" | "cursor";

export interface PublicProvider {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  model: string;
  apiKeyMasked: string;
  hasKey: boolean;
  headerNames: string[];
  createdAt: string;
  readOnly: boolean;
}

export interface ProviderList {
  defaultId: string | null;
  providers: PublicProvider[];
}

export function maskApiKey(apiKey: string): string {
  if (!apiKey) return "";
  const tail = apiKey.slice(-4);
  if (apiKey.length <= 4) return "••••";
  return `${apiKey.slice(0, 3)}…${tail}`;
}
