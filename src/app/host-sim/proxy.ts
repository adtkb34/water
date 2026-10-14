export const SANDBOX_PROXY_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; height: 100%; background: #fff; }
    iframe { width: 100%; height: 100%; border: 0; display: block; }
  </style>
</head>
<body>
<script>
const inner = document.createElement("iframe");
inner.setAttribute("sandbox", "allow-scripts allow-forms");
document.body.appendChild(inner);
window.addEventListener("message", (event) => {
  const data = event.data;
  if (event.source === window.parent) {
    if (data && data.method === "ui/notifications/sandbox-proxy-ping") {
      window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} }, "*");
      return;
    }
    if (data && data.method === "ui/notifications/sandbox-resource-ready") {
      const params = data.params || {};
      inner.setAttribute("sandbox", typeof params.sandbox === "string" ? params.sandbox : "allow-scripts allow-forms");
      inner.srcdoc = typeof params.html === "string" ? params.html : "";
      return;
    }
    if (inner.contentWindow) inner.contentWindow.postMessage(data, "*");
    return;
  }
  if (event.source === inner.contentWindow) {
    window.parent.postMessage(data, "*");
  }
});
window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} }, "*");
</script>
</body>
</html>`;
