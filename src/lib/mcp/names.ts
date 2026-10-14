export const UI_SPEC_INDEX_URI = "uispec://index";
export const WIDGET_RESOURCE_URI = "ui://agent-native/smart-ui-v1.html";

export function toolNameForCapability(id: string): string {
  return id.replaceAll(".", "_");
}

export function uiSpecUri(capabilityId: string): string {
  return `uispec://${capabilityId}`;
}
