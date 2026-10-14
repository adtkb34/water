import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import type { ToolPayload, WidgetHostContext } from "@/widget/interpret";

export interface WidgetApp {
  ontoolinput: ((params: { arguments?: Record<string, unknown> }) => void) | undefined;
  ontoolresult: ((params: ToolPayload) => void) | undefined;
  onhostcontextchanged: ((params: WidgetHostContext) => void) | undefined;
  getHostContext?: () => WidgetHostContext | undefined;
  callServerTool: (params: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<ToolPayload>;
  openLink?: (params: { url: string }) => Promise<{ isError?: boolean }>;
  connect?: () => Promise<void>;
}

export function bindWidgetHandlers(
  app: WidgetApp,
  handlers: {
    ontoolinput: NonNullable<WidgetApp["ontoolinput"]>;
    ontoolresult: NonNullable<WidgetApp["ontoolresult"]>;
    onhostcontextchanged: NonNullable<WidgetApp["onhostcontextchanged"]>;
  },
) {
  app.ontoolinput = handlers.ontoolinput;
  app.ontoolresult = handlers.ontoolresult;
  app.onhostcontextchanged = handlers.onhostcontextchanged;
}

export function toWidgetApp(app: App): WidgetApp {
  return {
    get ontoolinput() {
      return app.ontoolinput as WidgetApp["ontoolinput"];
    },
    set ontoolinput(handler) {
      app.ontoolinput = handler as App["ontoolinput"];
    },
    get ontoolresult() {
      return app.ontoolresult as WidgetApp["ontoolresult"];
    },
    set ontoolresult(handler) {
      app.ontoolresult = handler as App["ontoolresult"];
    },
    get onhostcontextchanged() {
      return app.onhostcontextchanged as WidgetApp["onhostcontextchanged"];
    },
    set onhostcontextchanged(handler) {
      app.onhostcontextchanged = handler as App["onhostcontextchanged"];
    },
    getHostContext: () => app.getHostContext() as WidgetHostContext | undefined,
    callServerTool: (params) => app.callServerTool(params) as Promise<ToolPayload>,
    openLink: (params) => app.openLink(params),
    connect: () => app.connect(new PostMessageTransport(window.parent, window.parent)),
  };
}
