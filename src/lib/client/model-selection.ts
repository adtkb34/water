import { GUIDED_MODEL_ID } from "@/lib/providers/public";

const KEY = "agent-native.model.v1";
const listeners = new Set<() => void>();

export function readModelSelection(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(KEY);
}

export function writeModelSelection(id: string) {
  localStorage.setItem(KEY, id);
  for (const listener of listeners) listener();
}

export function subscribeModelSelection(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function selectionSnapshot(): string {
  return readModelSelection() ?? "";
}

export function isGuidedSelection(id: string | null): boolean {
  return !id || id === GUIDED_MODEL_ID;
}

export function modelChoiceLabel(provider: { name: string; model: string; kind?: string }): string {
  const base = `${provider.name} · ${provider.model}`;
  return provider.kind === "cursor" ? `${base} · Cursor` : base;
}

export interface ModelChoice {
  id: string;
  fellBackToGuided: boolean;
}

export function resolveModelSelection(
  storedId: string | null,
  providers: { id: string }[],
  defaultId: string | null,
): ModelChoice {
  const known = (id: string | null | undefined) =>
    Boolean(id) && providers.some((item) => item.id === id);
  if (!storedId) {
    return {
      id: known(defaultId) ? (defaultId as string) : GUIDED_MODEL_ID,
      fellBackToGuided: false,
    };
  }
  if (storedId === GUIDED_MODEL_ID) {
    return { id: GUIDED_MODEL_ID, fellBackToGuided: false };
  }
  if (known(storedId)) return { id: storedId, fellBackToGuided: false };
  return { id: GUIDED_MODEL_ID, fellBackToGuided: true };
}
