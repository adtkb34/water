import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const WIDGET_HTML_PATH = path.join(
  process.cwd(),
  "src/lib/mcp/widget/dist/widget.html",
);

export const WIDGET_MISSING_MESSAGE =
  "智能界面资源尚未构建。请先运行 npm run build:widget";

export function readWidgetHtml(filePath = WIDGET_HTML_PATH): string {
  if (!existsSync(/*turbopackIgnore: true*/ filePath)) {
    throw new Error(WIDGET_MISSING_MESSAGE);
  }
  return readFileSync(/*turbopackIgnore: true*/ filePath, "utf8");
}
