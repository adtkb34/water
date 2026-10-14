"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { XIcon } from "lucide-react";
import type { ChatStatus } from "ai";
import {
  PromptInput,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuItem,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputProvider,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import {
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { UiSpec } from "@/lib/contract/types";
import { REF_KINDS } from "@/lib/domain";
import {
  activeToken,
  filterCommands,
  filterMentions,
  groupByModule,
  replaceToken,
  type ChatReference,
  type MentionEntity,
} from "@/lib/client/guided";
import { ImpactBadge } from "@/smart-ui";
import { cn } from "@/lib/utils";

export interface ModelChoice {
  value: string;
  label: string;
  badge?: string;
}

export function Composer({
  specs,
  mentions,
  models,
  modelId,
  onModelChange,
  status,
  onStop,
  onSend,
}: {
  specs: UiSpec[];
  mentions: MentionEntity[];
  models: ModelChoice[];
  modelId: string;
  onModelChange: (id: string) => void;
  status?: ChatStatus;
  onStop?: () => void;
  onSend: (input: {
    text: string;
    spec: UiSpec | null;
    references: ChatReference[];
  }) => void;
}) {
  return (
    <PromptInputProvider>
      <ComposerFields
        specs={specs}
        mentions={mentions}
        models={models}
        modelId={modelId}
        onModelChange={onModelChange}
        status={status}
        onStop={onStop}
        onSend={onSend}
      />
    </PromptInputProvider>
  );
}

function ComposerFields({
  specs,
  mentions,
  models,
  modelId,
  onModelChange,
  status,
  onStop,
  onSend,
}: {
  specs: UiSpec[];
  mentions: MentionEntity[];
  models: ModelChoice[];
  modelId: string;
  onModelChange: (id: string) => void;
  status?: ChatStatus;
  onStop?: () => void;
  onSend: (input: {
    text: string;
    spec: UiSpec | null;
    references: ChatReference[];
  }) => void;
}) {
  const controller = usePromptInputController();
  const text = controller.textInput.value;
  const [cursor, setCursor] = useState(0);
  const [tagged, setTagged] = useState<UiSpec | null>(null);
  const [references, setReferences] = useState<ChatReference[]>([]);
  const [dismissedKey, setDismissedKey] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [trackedKey, setTrackedKey] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const token = activeToken(text, cursor);
  const tokenKey = token ? `${token.kind}:${token.start}:${token.query}` : "";
  const commands = token?.kind === "command" ? filterCommands(specs, token.query) : [];
  const mentionItems = token?.kind === "mention" ? filterMentions(mentions, token.query) : [];
  const menuOpen = Boolean(token) && dismissedKey !== tokenKey;
  const itemCount = token?.kind === "command" ? commands.length : mentionItems.length;
  const menuIndex = trackedKey === tokenKey ? activeIndex : 0;
  const highlighted = itemCount === 0 ? 0 : Math.min(menuIndex, itemCount - 1);

  function highlight(index: number) {
    setTrackedKey(tokenKey);
    setActiveIndex(index);
  }

  useEffect(() => {
    if (!menuOpen) return;
    optionRefs.current[highlighted]?.scrollIntoView({ block: "nearest" });
  }, [highlighted, menuOpen]);

  function syncCursor(target: HTMLTextAreaElement) {
    setCursor(target.selectionStart ?? target.value.length);
  }

  function writeText(next: string, caret: number) {
    controller.textInput.setInput(next);
    setCursor(caret);
    requestAnimationFrame(() => {
      const field = textareaRef.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(caret, caret);
    });
  }

  function pickSpec(spec: UiSpec) {
    if (token?.kind === "command") {
      const next = replaceToken(text, token, "", cursor);
      writeText(next.text, next.cursor);
    }
    setTagged(spec);
    setDismissedKey(tokenKey || "closed");
  }

  function pickMention(entity: MentionEntity) {
    if (!token || token.kind !== "mention") return;
    const chip = `@${entity.label}`;
    const next = replaceToken(text, token, `${chip} `, cursor);
    writeText(next.text, next.cursor);
    setReferences((current) => {
      if (current.some((item) => item.kind === entity.kind && item.id === entity.id)) {
        return current;
      }
      return [
        ...current,
        { id: entity.id, kind: entity.kind, label: entity.label, token: chip },
      ];
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (!menuOpen || itemCount === 0) {
      if (event.key === "Escape" && token) {
        event.preventDefault();
        setDismissedKey(tokenKey);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      highlight(Math.min(itemCount - 1, highlighted + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      highlight(Math.max(0, highlighted - 1));
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissedKey(tokenKey);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (token?.kind === "command") {
        const spec = commands[highlighted];
        if (spec) pickSpec(spec);
      } else {
        const entity = mentionItems[highlighted];
        if (entity) pickMention(entity);
      }
    }
  }

  function removeReference(reference: ChatReference) {
    setReferences((current) =>
      current.filter((item) => item.id !== reference.id || item.kind !== reference.kind),
    );
    if (!reference.token) return;
    const value = controller.textInput.value;
    const index = value.indexOf(reference.token);
    if (index < 0) return;
    let end = index + reference.token.length;
    if (value[end] === " ") end += 1;
    writeText(value.slice(0, index) + value.slice(end), index);
  }

  const groups = groupByModule(commands);
  let commandCursor = 0;

  return (
    <div className="relative">
      {menuOpen ? (
        <div
          role="listbox"
          aria-label={token?.kind === "mention" ? "引用" : "能力"}
          className="absolute inset-x-0 bottom-full z-30 mb-2 max-h-[min(20rem,50dvh)] overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {token?.kind === "command" ? (
            commands.length === 0 ? (
              <p className="px-2 py-3 text-sm text-muted-foreground">没有匹配的能力</p>
            ) : (
              groups.map((group) => (
                <div key={group.moduleLabel} className="py-1">
                  <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
                    {group.moduleLabel}
                  </p>
                  {group.specs.map((spec) => {
                    const index = commandCursor;
                    commandCursor += 1;
                    return (
                      <button
                        key={spec.capabilityId}
                        ref={(node) => {
                          optionRefs.current[index] = node;
                        }}
                        type="button"
                        role="option"
                        aria-selected={index === highlighted}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left",
                          index === highlighted ? "bg-accent text-accent-foreground" : "",
                        )}
                        onMouseEnter={() => highlight(index)}
                        onClick={() => pickSpec(spec)}
                      >
                        <SpecLabel spec={spec} />
                      </button>
                    );
                  })}
                </div>
              ))
            )
          ) : mentionItems.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">没有匹配的引用</p>
          ) : (
            mentionItems.map((entity, index) => (
              <button
                key={`${entity.kind}:${entity.id}`}
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                type="button"
                role="option"
                aria-selected={index === highlighted}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm",
                  index === highlighted ? "bg-accent text-accent-foreground" : "",
                )}
                onMouseEnter={() => highlight(index)}
                onClick={() => pickMention(entity)}
              >
                <span className="min-w-0 flex-1 truncate">{entity.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {REF_KINDS[entity.kind].noun} · {entity.detail}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
      <PromptInput
        onSubmit={({ text: raw }) => {
          const trimmed = raw.trim();
          if (!trimmed && !tagged) return;
          onSend({ text: trimmed, spec: tagged, references });
          setTagged(null);
          setReferences([]);
          setCursor(0);
        }}
      >
        {tagged || references.length > 0 ? (
          <PromptInputHeader>
            {tagged ? (
              <Chip
                label={`本轮限定：${tagged.title}`}
                onRemove={() => setTagged(null)}
                removeLabel={`移除${tagged.title}`}
              />
            ) : null}
            {references.map((reference) => (
              <Chip
                key={`${reference.kind}:${reference.id}`}
                label={reference.token ?? `@${reference.label}`}
                onRemove={() => removeReference(reference)}
                removeLabel={`移除${reference.label}`}
              />
            ))}
          </PromptInputHeader>
        ) : null}
        <PromptInputBody>
          <PromptInputTextarea
            ref={textareaRef}
            placeholder={modelId === "guided" ? "用 / 选择能力，用 @ 引用，或直接输入" : "直接输入，或用 / 与 @ 带上上下文"}
            aria-label="消息"
            onChange={(event) => syncCursor(event.currentTarget)}
            onClick={(event) => syncCursor(event.currentTarget)}
            onKeyUp={(event) => syncCursor(event.currentTarget)}
            onKeyDown={onKeyDown}
          />
        </PromptInputBody>
        <PromptInputFooter className="flex-wrap">
          <PromptInputTools>
            <PromptInputActionMenu>
              <PromptInputActionMenuTrigger aria-label="选择能力" />
              <PromptInputActionMenuContent
                side="top"
                className="max-h-[min(32rem,70dvh)] w-80"
                style={{ width: "20rem", minWidth: "20rem" }}
              >
                {specs.length === 0 ? (
                  <p className="px-2 py-3 text-sm text-muted-foreground">正在加载能力…</p>
                ) : (
                  groupByModule(specs).map((group, groupIndex) => (
                    <DropdownMenuGroup key={group.moduleLabel}>
                      {groupIndex > 0 ? <DropdownMenuSeparator /> : null}
                      <DropdownMenuLabel>{group.moduleLabel}</DropdownMenuLabel>
                      {group.specs.map((spec) => (
                        <PromptInputActionMenuItem
                          key={spec.capabilityId}
                          onClick={() => pickSpec(spec)}
                        >
                          <SpecLabel spec={spec} />
                        </PromptInputActionMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  ))
                )}
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>
          </PromptInputTools>
          <div className="ml-auto flex items-center gap-1">
            <ModelSelect models={models} modelId={modelId} onModelChange={onModelChange} disabled={status === "submitted" || status === "streaming"} />
            <PromptInputSubmit aria-label="发送" status={status} onStop={onStop} />
          </div>
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

function SpecLabel({ spec }: { spec: UiSpec }) {
  return (
    <span className="flex w-full min-w-0 items-center gap-2">
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{spec.title}</span>
        <span className="block text-xs whitespace-normal text-muted-foreground">{spec.description}</span>
      </span>
      <ImpactBadge weight={spec.impact} />
    </span>
  );
}

function Chip({
  label,
  onRemove,
  removeLabel,
}: {
  label: string;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
      <span className="truncate">{label}</span>
      <button
        type="button"
        className="rounded-full text-muted-foreground hover:text-foreground"
        aria-label={removeLabel}
        onClick={onRemove}
      >
        <XIcon className="size-3" />
      </button>
    </span>
  );
}

function ModelSelect({
  models,
  modelId,
  onModelChange,
  disabled,
}: {
  models: ModelChoice[];
  modelId: string;
  onModelChange: (id: string) => void;
  disabled?: boolean;
}) {
  const router = useRouter();
  const items = [
    { value: "guided", label: "引导模式（无模型）" },
    ...models,
    { value: "manage", label: "管理模型…" },
  ];
  const select = (
    <PromptInputSelect
      value={modelId}
      items={items}
      disabled={disabled}
      onValueChange={(value) => {
        if (typeof value !== "string" || value === modelId) return;
        if (value === "manage") {
          router.push("/settings/models");
          return;
        }
        onModelChange(value);
      }}
    >
      <PromptInputSelectTrigger size="sm" aria-label="模型" className="max-w-[14rem]">
        <PromptInputSelectValue placeholder="引导模式（无模型）" />
      </PromptInputSelectTrigger>
      <PromptInputSelectContent>
        {items.map((item) => (
          <PromptInputSelectItem key={item.value} value={item.value}>
            <span className="inline-flex items-center gap-1">
              <span>{item.label}</span>
              {item.badge ? (
                <span className="rounded bg-muted px-1 text-[10px] leading-4 text-muted-foreground">{item.badge}</span>
              ) : null}
            </span>
          </PromptInputSelectItem>
        ))}
      </PromptInputSelectContent>
    </PromptInputSelect>
  );
  if (modelId !== "guided") return <span className="inline-flex max-w-[14rem]">{select}</span>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex max-w-[14rem]">{select}</span>} />
      <TooltipContent side="top">引导模式不调用大模型。配置模型后可以直接输入。</TooltipContent>
    </Tooltip>
  );
}
