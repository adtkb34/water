import { createRoot } from "react-dom/client";
import { App } from "@modelcontextprotocol/ext-apps";
import { toWidgetApp } from "@/widget/bridge";
import { SmartWidget } from "@/widget/SmartWidget";
import "@/widget/widget.css";

const app = new App(
  { name: "agent-native-smart-ui", version: "1.0.0" },
  {},
  { autoResize: true },
);

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<SmartWidget app={toWidgetApp(app)} autoConnect />);
}
