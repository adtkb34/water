"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Button } from "@/components/ui/button";
import { ErrorBlock, messageOf } from "@/components/workbench/feedback";
import { ChatMessage } from "@/components/chat/chat-message";
import { Composer } from "@/components/chat/composer";
import { parseChatFailure } from "@/lib/client/chat-error";
import { errorMessage, invokeWithActor, sendJson } from "@/lib/client/api";
import { directoryFrom, EMPTY_DIRECTORY } from "@/lib/client/display";
import {
  assistantNote,
  attachToolOutput,
  capabilityTurn,
  compactFormOutput,
  continueAfterClientTool,
  freeTextTurn,
  isStoredMessage,
  mentionEntities,
  parsePrefill,
  readInvokeResult,
  readSubmittedValues,
  shortcutContext,
  suggestionSpecs,
  type ChatReference,
  type ChatUIMessage,
} from "@/lib/client/guided";
import {
  modelChoiceLabel,
  readModelSelection,
  resolveModelSelection,
  selectionSnapshot,
  subscribeModelSelection,
  writeModelSelection,
} from "@/lib/client/model-selection";
import { useProviderList } from "@/lib/client/use-providers";
import { useApprovals, useStore } from "@/lib/client/use-store";
import { GUIDED_MODEL_ID } from "@/lib/providers/public";
import type { Approval, UiSpec } from "@/lib/contract/types";
import { ImpactBadge } from "@/smart-ui";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "agent-native.chat.v1";
const MODEL_STORAGE_KEY = "agent-native.chat.model.v1";
const CURSOR_CHAT_KEY = "agent-native.chat.cursor-id.v1";
const consumedHandoffs = new Set<string>();
const threadListeners = new Set<() => void>();
let activeProviderId = GUIDED_MODEL_ID;
let activeChatId = "";

function ensureCursorChatId(): string {
  if (typeof sessionStorage === "undefined") {
    if (!activeChatId) activeChatId = `chat-${Date.now()}`;
    return activeChatId;
  }
  const existing = sessionStorage.getItem(CURSOR_CHAT_KEY);
  if (existing) {
    activeChatId = existing;
    return existing;
  }
  const created = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `chat-${Date.now()}`;
  sessionStorage.setItem(CURSOR_CHAT_KEY, created);
  activeChatId = created;
  return created;
}

function rotateCursorChatId() {
  const created = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `chat-${Date.now()}`;
  if (typeof sessionStorage !== "undefined") sessionStorage.setItem(CURSOR_CHAT_KEY, created);
  activeChatId = created;
}

const modelTransport = new DefaultChatTransport<ChatUIMessage>({
  api: "/api/chat",
  body: () => ({ providerId: activeProviderId, chatId: ensureCursorChatId() }),
});

function readRaw(): string {
  if (typeof sessionStorage === "undefined") return "";
  return sessionStorage.getItem(STORAGE_KEY) ?? "";
}

function readModelRaw(): string {
  if (typeof sessionStorage === "undefined") return "";
  return sessionStorage.getItem(MODEL_STORAGE_KEY) ?? "";
}

function parseThread(raw: string): ChatUIMessage[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredMessage);
  } catch {
    return [];
  }
}

function writeThread(messages: ChatUIMessage[]) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  for (const listener of threadListeners) listener();
}

function writeModelThread(messages: ChatUIMessage[]) {
  sessionStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(messages));
}

function subscribeThread(listener: () => void) {
  threadListeners.add(listener);
  return () => {
    threadListeners.delete(listener);
  };
}

function updateThread(updater: (current: ChatUIMessage[]) => ChatUIMessage[]) {
  writeThread(updater(parseThread(readRaw())));
}

function noteGuidedFallback() {
  const text = "所选模型已不存在，已切换到引导模式。没有模型时可以用 / 或 + 继续。";
  updateThread((current) => {
    const last = current.at(-1);
    const already = last?.parts.some((part) => part.type === "text" && part.text === text);
    if (already) return current;
    return [...current, assistantNote(text)];
  });
}

export function ChatScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const query = params.toString();
  const store = useStore();
  const approvals = useApprovals();
  const providers = useProviderList();
  const storedSelection = useSyncExternalStore(subscribeModelSelection, selectionSnapshot, () => "");
  const rawThread = useSyncExternalStore(subscribeThread, readRaw, () => "");
  const guidedMessages = useMemo(() => parseThread(rawThread), [rawThread]);
  const chat = useChat<ChatUIMessage>({
    id: "model-thread",
    transport: modelTransport,
    sendAutomaticallyWhen: continueAfterClientTool,
    onError(error) {
      if (parseChatFailure(error).missingProvider) {
        writeModelSelection(GUIDED_MODEL_ID);
        noteGuidedFallback();
      }
    },
  });
  const { messages: modelMessages, setMessages, sendMessage, addToolOutput, status, error, clearError, regenerate, stop } = chat;
  const seeded = useRef(false);
  const streaming = useRef(false);

  const resolvedId = useMemo(() => {
    if (!providers.data) return storedSelection;
    return resolveModelSelection(
      storedSelection || null,
      providers.data.providers,
      providers.data.defaultId,
    ).id;
  }, [providers.data, storedSelection]);
  const waiting = !providers.data && storedSelection === "";
  const modelMode = !waiting && resolvedId !== GUIDED_MODEL_ID && resolvedId !== "";

  useEffect(() => {
    activeProviderId = modelMode ? resolvedId : GUIDED_MODEL_ID;
  });

  const specs = store.data?.specs ?? [];
  const directory = useMemo(
    () => (store.data ? directoryFrom(store.data) : EMPTY_DIRECTORY),
    [store.data],
  );
  const mentions = useMemo(
    () =>
      mentionEntities({
        products: store.data?.products ?? [],
        suppliers: store.data?.suppliers ?? [],
        inquiries: store.data?.inquiries ?? [],
      }),
    [store.data],
  );
  const messages = modelMode ? modelMessages : guidedMessages;
  const failure = modelMode && error ? parseChatFailure(error) : null;

  useEffect(() => {
    const parsed = parseThread(readModelRaw());
    if (parsed.length > 0) setMessages(parsed);
    queueMicrotask(() => {
      seeded.current = true;
    });
  }, [setMessages]);

  useEffect(() => {
    if (!seeded.current) return;
    writeModelThread(modelMessages);
  }, [modelMessages]);

  useEffect(() => {
    if (!providers.data) return;
    const stored = readModelSelection();
    const choice = resolveModelSelection(
      stored,
      providers.data.providers,
      providers.data.defaultId,
    );
    if (stored === null) {
      writeModelSelection(choice.id);
      return;
    }
    if (choice.fellBackToGuided) {
      writeModelSelection(GUIDED_MODEL_ID);
      noteGuidedFallback();
    }
  }, [providers.data]);

  useEffect(() => {
    if (status === "submitted" || status === "streaming") {
      streaming.current = true;
      return;
    }
    if (!streaming.current) return;
    streaming.current = false;
    void Promise.all([store.refresh(), approvals.refresh()]);
  }, [approvals, status, store]);

  useEffect(() => {
    if (!store.data || waiting) return;
    const current = new URLSearchParams(query);
    const cap = current.get("cap");
    if (!cap) return;
    if (consumedHandoffs.has(query)) {
      router.replace("/chat", { scroll: false });
      return;
    }
    consumedHandoffs.add(query);
    const spec = store.data.specs.find((item) => item.capabilityId === cap);
    const prefill = parsePrefill(current.get("prefill"));
    if (modelMode) {
      activeProviderId = resolvedId;
      if (!spec) {
        void sendMessage({ text: "没有找到对应的能力，请用 / 或 + 重新选择。" });
      } else {
        const text = [spec.title, shortcutContext({ title: spec.title, prefill })].filter(Boolean).join("\n");
        void sendMessage({ text, metadata: { capabilityId: spec.capabilityId } });
      }
    } else {
      updateThread((existing) => {
        if (!spec) {
          return [...existing, assistantNote("没有找到对应的能力，请用 / 或 + 重新选择。")];
        }
        return [...existing, ...capabilityTurn({ spec, prefill })];
      });
    }
    router.replace("/chat", { scroll: false });
  }, [modelMode, query, resolvedId, router, sendMessage, store.data, waiting]);

  function start(spec: UiSpec, prefill?: Record<string, unknown>) {
    if (modelMode) {
      activeProviderId = resolvedId;
      const text = [spec.title, shortcutContext({ title: spec.title, prefill })].filter(Boolean).join("\n");
      void sendMessage({ text, metadata: { capabilityId: spec.capabilityId } });
      return;
    }
    updateThread((current) => [...current, ...capabilityTurn({ spec, prefill })]);
  }

  function onSend(input: { text: string; spec: UiSpec | null; references: ChatReference[] }) {
    if (waiting) return;
    if (modelMode) {
      activeProviderId = resolvedId;
      const context = shortcutContext({
        title: input.spec?.title,
        references: input.references,
      });
      const text = [input.text, context].filter(Boolean).join("\n");
      if (!text) return;
      void sendMessage({
        text,
        metadata: {
          ...(input.spec ? { capabilityId: input.spec.capabilityId } : {}),
          ...(input.references.length > 0 ? { references: input.references } : {}),
        },
      });
      return;
    }
    if (input.spec) {
      const spec = input.spec;
      updateThread((current) => [
        ...current,
        ...capabilityTurn({
          spec,
          text: input.text,
          references: input.references,
        }),
      ]);
      return;
    }
    if (!input.text) return;
    updateThread((current) => [...current, ...freeTextTurn(input.text)]);
  }

  async function onInvoke(
    capabilityId: string,
    input: Record<string, unknown>,
    actor: "human" | "agent",
  ) {
    const result = await invokeWithActor(capabilityId, input, {
      kind: actor,
      surface: "chat",
    });
    await Promise.all([store.refresh(), approvals.refresh()]);
    return result;
  }

  function onResult(toolCallId: string, output: unknown) {
    if (modelMode) {
      const result = readInvokeResult(output);
      const submitted = readSubmittedValues(output);
      void addToolOutput({
        tool: "show_form",
        toolCallId,
        output: result ? compactFormOutput(result, submitted) : output,
      });
      return;
    }
    updateThread((current) => attachToolOutput(current, toolCallId, output));
  }

  function onFormFollowUp(toolCallId: string, output: unknown, summary: string) {
    const result = readInvokeResult(output);
    const submitted = readSubmittedValues(output);
    const compact = result ? compactFormOutput(result, submitted) : output;
    setMessages((current) => attachToolOutput(current, toolCallId, compact));
    activeProviderId = resolvedId;
    void sendMessage({ text: `我已提交表单：${summary}` });
  }

  async function onDecide(approval: Approval, decision: "approve" | "reject", note?: string) {
    const { status, data } = await sendJson(`/api/approvals/${approval.id}`, "POST", {
      decision,
      ...(note ? { note } : {}),
    });
    await Promise.all([store.refresh(), approvals.refresh()]);
    if (status >= 400) return { ok: false, message: errorMessage(data, status) };
    return { ok: true };
  }

  function newChat() {
    if (modelMode) {
      clearError();
      rotateCursorChatId();
      setMessages([]);
      writeModelThread([]);
      return;
    }
    writeThread([]);
  }

  const empty = messages.length === 0 && !failure;
  const approvalItems = approvals.data?.approvals ?? [];
  const activeProvider = providers.data?.providers.find((item) => item.id === resolvedId);
  const modeLabel = modelMode
    ? `${activeProvider?.name ?? "模型"}${activeProvider ? ` · ${activeProvider.model}` : ""}`
    : waiting
      ? "正在读取模型"
      : "引导模式";
  const modelChoices = (providers.data?.providers ?? []).map((item) => ({
    value: item.id,
    label: modelChoiceLabel(item),
    ...(item.kind === "cursor" ? { badge: "Cursor" } : {}),
  }));

  return (
    <div className="flex h-[calc(100dvh-3.5rem-1px)] flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-2">
        <p className="truncate text-sm text-muted-foreground">{modeLabel}</p>
        <Button type="button" variant="outline" size="sm" onClick={newChat}>
          新对话
        </Button>
      </div>
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          empty && "md:justify-center md:overflow-y-auto md:py-6",
        )}
      >
          {store.error && !store.data ? (
            <div className="order-1 px-4 pb-3">
              <ErrorBlock message={messageOf(store.error)} onRetry={() => void store.refresh()} />
            </div>
          ) : null}
          {empty ? (
            <div className="order-1 shrink-0 px-4 pt-6 text-center md:pt-0">
              <h1 className="text-2xl font-semibold tracking-tight">想办成什么？</h1>
              <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                {waiting
                  ? "正在读取模型配置…"
                  : modelMode
                    ? "直接说出要办的事。需要一次填写多个字段时，助手会在对话里给出表单。"
                    : "用 / 、+ 或下面的卡片选择要做的事。引导模式不解析自由输入，表单会直接出现在对话里。"}
              </p>
            </div>
          ) : (
            <Conversation className="order-1 min-h-0 flex-1">
              <FollowBottom token={threadScrollToken(messages, failure?.message)} />
              <ConversationContent className="mx-auto w-full max-w-3xl gap-6">
                {messages.map((message) => (
                  <ChatMessage
                    key={message.id}
                    message={message}
                    specs={specs}
                    directory={directory}
                    approvals={approvalItems}
                    onInvoke={onInvoke}
                    onDecide={onDecide}
                    onStart={start}
                    onResult={onResult}
                    onFormFollowUp={onFormFollowUp}
                  />
                ))}
                {failure && !failure.missingProvider ? (
                  <div
                    role="alert"
                    data-testid="chat-model-error"
                    className="space-y-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4"
                  >
                    <p className="text-sm">{failure.message}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          activeProviderId = resolvedId;
                          clearError();
                          void regenerate();
                        }}
                      >
                        重试
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          clearError();
                          writeModelSelection(GUIDED_MODEL_ID);
                        }}
                      >
                        切换到引导模式
                      </Button>
                    </div>
                  </div>
                ) : null}
              </ConversationContent>
              <ConversationScrollButton />
            </Conversation>
          )}
          {empty ? (
            <div className="order-2 min-h-0 flex-1 overflow-y-auto px-4 py-4 md:order-3 md:flex-none md:overflow-visible">
              <div className="mx-auto w-full max-w-3xl">
                <SuggestionGrid specs={specs} onStart={start} />
              </div>
            </div>
          ) : null}
          <div
            className={cn(
              "order-3 shrink-0 border-t bg-background px-3 py-3 md:order-2",
              empty && "md:border-transparent md:bg-transparent",
            )}
          >
            <div className={cn("mx-auto w-full", empty ? "max-w-2xl" : "max-w-3xl")}>
              <Composer
                specs={specs}
                mentions={mentions}
                models={modelChoices}
                modelId={resolvedId || GUIDED_MODEL_ID}
                onModelChange={(id) => {
                  clearError();
                  writeModelSelection(id);
                }}
                status={modelMode ? status : "ready"}
                onStop={() => {
                  void stop();
                }}
                onSend={onSend}
              />
            </div>
        </div>
      </div>
    </div>
  );
}

function threadScrollToken(messages: ChatUIMessage[], error?: string): string {
  const last = messages.at(-1);
  const part = last?.parts.at(-1);
  const state = part && "state" in part ? String(part.state) : "";
  const text = part && "text" in part && typeof part.text === "string" ? part.text.length : 0;
  return `${messages.length}:${last?.id ?? ""}:${last?.parts.length ?? 0}:${state}:${text}:${error ?? ""}`;
}

function FollowBottom({ token }: { token: string }) {
  const { scrollToBottom } = useStickToBottomContext();
  useEffect(() => {
    void scrollToBottom();
  }, [token, scrollToBottom]);
  return null;
}

function SuggestionGrid({
  specs,
  onStart,
}: {
  specs: UiSpec[];
  onStart: (spec: UiSpec) => void;
}) {
  const cards = suggestionSpecs(specs);
  if (cards.length === 0) {
    return <p className="text-center text-sm text-muted-foreground">正在加载可以做的事…</p>;
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {cards.map((spec) => (
        <button
          key={spec.capabilityId}
          type="button"
          className="rounded-xl border bg-card p-4 text-left transition-colors hover:bg-muted"
          onClick={() => onStart(spec)}
        >
          <span className="block font-medium">{spec.title}</span>
          <span className="mt-1 block text-sm text-muted-foreground">{spec.description}</span>
          <span className="mt-3 inline-flex">
            <ImpactBadge weight={spec.impact} />
          </span>
        </button>
      ))}
    </div>
  );
}
