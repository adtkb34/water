"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { EmptyBlock, ErrorBlock, messageOf, TableSkeleton } from "@/components/workbench/feedback";
import { PageHeader } from "@/components/workbench/page-header";
import { errorMessage, sendJson } from "@/lib/client/api";
import { useProviderList } from "@/lib/client/use-providers";
import { MODEL_PRESETS } from "@/lib/providers/presets";
import type { ProviderKind, PublicProvider } from "@/lib/providers/public";
import { cn } from "@/lib/utils";

interface Draft {
  id?: string;
  preset: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  headerNames: string[];
  headerText: string;
  hasKey: boolean;
  masked: string;
  readOnly: boolean;
  models: string[];
}

interface ProbeState {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

function blankDraft(): Draft {
  return {
    preset: "custom",
    kind: "openai-compatible",
    name: "",
    baseUrl: "",
    model: "",
    apiKey: "",
    headerNames: [],
    headerText: "",
    hasKey: false,
    masked: "",
    readOnly: false,
    models: [],
  };
}

function draftFrom(provider: PublicProvider): Draft {
  const preset = provider.kind === "cursor"
    ? "cursor"
    : MODEL_PRESETS.find((item) => item.baseUrl && item.baseUrl === provider.baseUrl)?.id ?? "custom";
  return {
    id: provider.id,
    preset,
    kind: provider.kind,
    name: provider.name,
    baseUrl: provider.baseUrl,
    model: provider.model,
    apiKey: "",
    headerNames: [...provider.headerNames],
    headerText: "",
    hasKey: provider.hasKey,
    masked: provider.apiKeyMasked,
    readOnly: provider.readOnly,
    models: [],
  };
}

function parseHeaderText(text: string): { ok: true; headers: Record<string, string> } | { ok: false; error: string } {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf(":");
    if (index <= 0) return { ok: false, error: `无法识别请求头：${trimmed}` };
    const name = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!/^[A-Za-z0-9-]+$/.test(name)) return { ok: false, error: `请求头名称不合法：${name}` };
    headers[name] = value;
  }
  return { ok: true, headers };
}

function payloadOf(draft: Draft, headers: Record<string, string> | undefined) {
  const cursor = draft.kind === "cursor";
  return {
    kind: draft.kind,
    name: draft.name.trim(),
    model: draft.model.trim() || (cursor ? "composer-2" : ""),
    ...(cursor ? {} : { baseUrl: draft.baseUrl.trim() }),
    ...(!cursor && headers ? { headers } : {}),
    ...(draft.apiKey.trim() ? { apiKey: draft.apiKey } : {}),
  };
}

export default function ModelsPage() {
  const providers = useProviderList();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<PublicProvider | null>(null);
  const [formError, setFormError] = useState("");
  const [probe, setProbe] = useState<ProbeState | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(current: Draft): Promise<PublicProvider | null> {
    const typed = current.headerText.trim();
    let headers: Record<string, string> | undefined;
    if (typed) {
      const parsed = parseHeaderText(current.headerText);
      if (!parsed.ok) {
        setFormError(parsed.error);
        return null;
      }
      headers = parsed.headers;
    }
    const body = payloadOf(current, headers);
    const response = current.id
      ? await sendJson(`/api/providers/${current.id}`, "PUT", body)
      : await sendJson("/api/providers", "POST", body);
    if (response.status >= 400) {
      setFormError(errorMessage(response.data, response.status));
      return null;
    }
    const provider = (response.data as { provider?: PublicProvider }).provider;
    if (!provider) {
      setFormError("保存没有返回模型配置");
      return null;
    }
    await providers.refresh();
    return provider;
  }

  async function onSave() {
    if (!draft) return;
    setBusy(true);
    setFormError("");
    try {
      const saved = await save(draft);
      if (!saved) return;
      setDraft(draftFrom(saved));
      setProbe(null);
    } finally {
      setBusy(false);
    }
  }

  async function onClearHeaders() {
    if (!draft || draft.readOnly) return;
    if (!draft.id) {
      setDraft({ ...draft, headerNames: [], headerText: "" });
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      const response = await sendJson(`/api/providers/${draft.id}`, "PUT", { headers: {} });
      if (response.status >= 400) {
        setFormError(errorMessage(response.data, response.status));
        return;
      }
      const provider = (response.data as { provider?: PublicProvider }).provider;
      if (!provider) {
        setFormError("清除请求头没有返回模型配置");
        return;
      }
      setDraft(draftFrom(provider));
      await providers.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onTest() {
    if (!draft) return;
    setBusy(true);
    setFormError("");
    setProbe(null);
    try {
      let id = draft.id;
      if (!id) {
        const saved = await save(draft);
        if (!saved) return;
        id = saved.id;
        setDraft(draftFrom(saved));
      }
      const response = await sendJson(`/api/providers/${id}/test`, "POST", draft.apiKey.trim() ? { apiKey: draft.apiKey } : {});
      if (response.status >= 400) {
        setProbe({ ok: false, message: errorMessage(response.data, response.status) });
        return;
      }
      const data = response.data as { ok?: boolean; message?: string; latencyMs?: number; models?: unknown };
      const models = Array.isArray(data.models)
        ? data.models.filter((item): item is string => typeof item === "string" && item.length > 0)
        : [];
      if (models.length > 0) {
        setDraft((current) => (current ? { ...current, models } : current));
      }
      setProbe({
        ok: Boolean(data.ok),
        message: data.message || (data.ok ? "连接成功" : "连接失败"),
        latencyMs: data.latencyMs,
      });
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!removing) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/providers/${removing.id}`, { method: "DELETE", cache: "no-store" });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setFormError(errorMessage(data, response.status));
        return;
      }
      setRemoving(null);
      await providers.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault(id: string) {
    setFormError("");
    const response = await sendJson("/api/providers/default", "PUT", { id });
    if (response.status >= 400) {
      setFormError(errorMessage(response.data, response.status));
      return;
    }
    await providers.refresh();
  }

  const list = providers.data?.providers ?? [];
  const defaultId = providers.data?.defaultId ?? null;

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6" data-testid="settings-models">
      <PageHeader
        title="模型设置"
        description="配置 OpenAI 兼容模型，或使用 Cursor 订阅额度。密钥只保存在服务器，页面和接口只显示脱敏值。没有模型时，对话使用引导模式。"
      >
        <Button
          type="button"
          onClick={() => {
            setFormError("");
            setProbe(null);
            setDraft(blankDraft());
          }}
        >
          添加模型
        </Button>
      </PageHeader>
      {formError && !draft ? <p className="text-sm text-destructive">{formError}</p> : null}
      {providers.isLoading && !providers.data ? (
        <TableSkeleton rows={3} />
      ) : providers.error && !providers.data ? (
        <ErrorBlock message={messageOf(providers.error)} onRetry={() => void providers.refresh()} />
      ) : list.length === 0 ? (
        <EmptyBlock
          title="还没有配置模型"
          description="没有模型时，对话走引导模式：用 / 、+ 或建议卡片完成操作，不调用大模型。添加一个提供方后，就可以直接用自然语言对话。"
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>Base URL</TableHead>
                <TableHead>密钥</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((provider) => (
                <TableRow key={provider.id}>
                  <TableCell className="font-medium">
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{provider.name}</span>
                      {provider.id === defaultId ? <Badge>默认</Badge> : null}
                      {provider.kind === "cursor" ? <Badge variant="outline">Cursor</Badge> : null}
                      {provider.readOnly ? <Badge variant="outline">只读</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell>{provider.model}</TableCell>
                  <TableCell className="max-w-48 truncate" title={provider.kind === "cursor" ? "" : provider.baseUrl}>
                    {provider.kind === "cursor" ? "—" : provider.baseUrl}
                  </TableCell>
                  <TableCell>{provider.hasKey ? provider.apiKeyMasked : "未设置"}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap justify-end gap-2">
                      {provider.id !== defaultId ? (
                        <Button type="button" variant="outline" size="sm" onClick={() => void makeDefault(provider.id)}>
                          设为默认
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setDraft(draftFrom(provider));
                          setProbe(null);
                          setFormError("");
                        }}
                      >
                        {provider.readOnly ? "查看" : "编辑"}
                      </Button>
                      {provider.readOnly ? null : (
                        <Button type="button" variant="outline" size="sm" onClick={() => setRemoving(provider)}>
                          删除
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setDraft(null);
            setProbe(null);
            setFormError("");
          }
        }}
      >
        <DialogContent className="max-h-[min(85vh,44rem)] overflow-y-auto sm:max-w-lg">
          {draft ? (
            <>
              <DialogHeader>
                <DialogTitle>{draft.readOnly ? "环境变量模型" : draft.id ? "编辑模型" : "添加模型"}</DialogTitle>
                <DialogDescription>
                  {draft.kind === "cursor"
                    ? "使用 Cursor 订阅额度。密钥在 Cursor 控制台创建，只保存在这台服务器上。"
                    : "预设会填入 Base URL 和建议的模型名。留空密钥表示保持已保存的密钥。"}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  {MODEL_PRESETS.map((preset) => (
                    <Button
                      key={preset.id}
                      type="button"
                      size="sm"
                      variant={draft.preset === preset.id ? "default" : "outline"}
                      disabled={draft.readOnly}
                      onClick={() => {
                        const kind = preset.kind ?? "openai-compatible";
                        setDraft({
                          ...draft,
                          preset: preset.id,
                          kind,
                          ...(preset.id === "custom"
                            ? {}
                            : {
                                baseUrl: kind === "cursor" ? "" : preset.baseUrl,
                                model: preset.model,
                                name: draft.name || preset.label,
                                ...(kind === "cursor" ? { headerNames: [], headerText: "", models: [] } : {}),
                              }),
                        });
                      }}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
                <Field label="名称" value={draft.name} disabled={draft.readOnly} onChange={(name) => setDraft({ ...draft, name })} />
                {draft.kind === "cursor" ? (
                  <div className="space-y-2 rounded-lg border bg-muted/40 p-3 text-sm" data-testid="cursor-preset-help">
                    <p>
                      在{" "}
                      <a
                        className="underline"
                        href="https://cursor.com/dashboard/cloud-agents"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Cursor 控制台
                      </a>{" "}
                      创建个人 API Key，粘贴到下面。模型名默认 composer-2，也可以填 auto。
                    </p>
                    <p>该引擎会在服务器上以本地模式运行 Cursor 智能体，仅用于本机/受信环境的实验</p>
                  </div>
                ) : (
                  <Field label="Base URL" value={draft.baseUrl} disabled={draft.readOnly} onChange={(baseUrl) => setDraft({ ...draft, baseUrl })} />
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="provider-模型名">模型名</Label>
                  <Input
                    id="provider-模型名"
                    value={draft.model}
                    disabled={draft.readOnly}
                    list={draft.models.length > 0 ? "cursor-model-list" : undefined}
                    placeholder={draft.kind === "cursor" ? "composer-2" : undefined}
                    onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                  />
                  {draft.models.length > 0 ? (
                    <datalist id="cursor-model-list">
                      {draft.models.map((model) => (
                        <option key={model} value={model} />
                      ))}
                    </datalist>
                  ) : null}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="provider-key">{draft.kind === "cursor" ? "Cursor API Key" : "API Key"}</Label>
                  <Input
                    id="provider-key"
                    type="password"
                    autoComplete="off"
                    value={draft.apiKey}
                    disabled={draft.readOnly}
                    placeholder={draft.hasKey ? `已保存（${draft.masked}），留空则保持不变` : draft.kind === "cursor" ? "从 Cursor 控制台复制" : "可选"}
                    onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                  />
                </div>
                {draft.kind === "cursor" ? null : (
                <div className="space-y-1.5">
                  <Label htmlFor="provider-headers">替换自定义请求头（留空表示保持不变）</Label>
                  {draft.headerNames.length > 0 ? (
                    <div className="flex flex-wrap gap-2" data-testid="provider-header-names">
                      {draft.headerNames.map((name) => (
                        <Badge key={name} variant="outline">
                          {name}: ••••
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  <Textarea
                    id="provider-headers"
                    value={draft.headerText}
                    disabled={draft.readOnly}
                    placeholder={"一行一个，例如\nX-Title: demo"}
                    onChange={(event) => setDraft({ ...draft, headerText: event.target.value })}
                  />
                  {draft.readOnly || draft.headerNames.length === 0 ? null : (
                    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void onClearHeaders()}>
                      清除请求头
                    </Button>
                  )}
                </div>
                )}
                {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
                {probe ? (
                  <p className={cn("text-sm", probe.ok ? "text-emerald-700" : "text-destructive")} data-testid="provider-probe">
                    {probe.message}
                    {typeof probe.latencyMs === "number" ? `（${probe.latencyMs} ms）` : ""}
                  </p>
                ) : null}
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" disabled={busy} onClick={() => void onTest()}>
                  测试连接
                </Button>
                {draft.readOnly ? null : (
                  <Button type="button" disabled={busy} onClick={() => void onSave()}>
                    保存
                  </Button>
                )}
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={removing !== null} onOpenChange={(open) => { if (!open && !busy) setRemoving(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除模型</DialogTitle>
            <DialogDescription>
              确定删除「{removing?.name}」？如果对话正在使用它，会回到引导模式。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setRemoving(null)}>
              取消
            </Button>
            <Button type="button" variant="destructive" disabled={busy} onClick={() => void onDelete()}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function Field({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const id = `provider-${label}`;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
