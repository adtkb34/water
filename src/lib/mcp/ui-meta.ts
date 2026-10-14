import { WIDGET_RESOURCE_URI } from "@/lib/mcp/names";

export const EMPTY_UI_CSP = {
  connectDomains: [] as string[],
  resourceDomains: [] as string[],
  frameDomains: [] as string[],
  baseUriDomains: [] as string[],
};

export function widgetToolMeta() {
  return {
    ui: {
      resourceUri: WIDGET_RESOURCE_URI,
      visibility: ["model", "app"] as ["model", "app"],
    },
    "openai/outputTemplate": WIDGET_RESOURCE_URI,
  };
}
