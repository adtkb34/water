"use client";

import { isToolUIPart } from "ai";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Suggestion } from "@/components/ai-elements/suggestion";
import { ChatPartRenderer, type ChatActor } from "@/components/chat/chat-part-renderer";
import { quickEntrySpecs, type ChatUIMessage } from "@/lib/client/guided";
import type { RefDirectory } from "@/lib/client/display";
import type { Approval, InvokeResult, UiSpec } from "@/lib/contract/types";
import "streamdown/styles.css";

function messageText(message: ChatUIMessage, text: string, taggedTitle?: string): string {
  if (!text) return "";
  if (message.role === "user" && taggedTitle && text === taggedTitle) return "";
  if (message.role !== "user") return text;
  let rest = text;
  for (const reference of message.metadata?.references ?? []) {
    if (reference.token) rest = rest.replace(reference.token, "");
  }
  return rest.trim();
}

export function ChatMessage({
  message,
  specs,
  directory,
  approvals,
  onInvoke,
  onDecide,
  onStart,
  onResult,
  onFormFollowUp,
}: {
  message: ChatUIMessage;
  specs: UiSpec[];
  directory: RefDirectory;
  approvals: Approval[];
  onInvoke: (
    capabilityId: string,
    input: Record<string, unknown>,
    actor: ChatActor,
  ) => Promise<InvokeResult>;
  onDecide: (
    approval: Approval,
    decision: "approve" | "reject",
    note?: string,
  ) => Promise<{ ok: boolean; message?: string }>;
  onStart: (spec: UiSpec, prefill?: Record<string, unknown>) => void;
  onResult: (toolCallId: string, output: unknown) => void;
  onFormFollowUp?: (toolCallId: string, output: unknown, summary: string) => void;
}) {
  const tagged = message.metadata?.capabilityId
    ? specs.find((spec) => spec.capabilityId === message.metadata?.capabilityId)
    : undefined;
  return (
    <Message from={message.role} className={message.role === "assistant" ? "max-w-full" : undefined}>
      <MessageContent className={message.role === "assistant" ? "w-full" : undefined}>
        {message.role === "user" && tagged ? (
          <span className="text-xs text-muted-foreground">本轮限定：{tagged.title}</span>
        ) : null}
        {message.role === "user"
          ? message.metadata?.references?.map((reference) => (
              <span
                key={`${reference.kind}:${reference.id}`}
                className="mr-1 inline-flex rounded-full bg-background/70 px-2 py-0.5 text-xs"
              >
                {reference.token ?? `@${reference.label}`}
              </span>
            ))
          : null}
        {message.parts.map((part, index) => {
          if (part.type === "text") {
            const text = messageText(message, part.text, tagged?.title);
            if (!text) return null;
            return (
              <MessageResponse key={`${message.id}:text:${index}`}>{text}</MessageResponse>
            );
          }
          if (!isToolUIPart(part)) return null;
          return (
            <ChatPartRenderer
              key={part.toolCallId || `${message.id}:tool:${index}`}
              part={part}
              specs={specs}
              directory={directory}
              approvals={approvals}
              onInvoke={onInvoke}
              onDecide={onDecide}
              onStart={onStart}
              onResult={onResult}
              onFormFollowUp={onFormFollowUp}
            />
          );
        })}
        {message.metadata?.guidedHint ? (
          <div className="flex flex-wrap gap-2">
            {quickEntrySpecs(specs).map((spec) => (
              <Suggestion
                key={spec.capabilityId}
                suggestion={spec.title}
                onClick={() => onStart(spec)}
              >
                {spec.title}
              </Suggestion>
            ))}
          </div>
        ) : null}
      </MessageContent>
    </Message>
  );
}
