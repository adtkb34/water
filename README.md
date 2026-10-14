# 对话优先的 Agent 原生软件原型

## 这是什么

同一份能力契约同时驱动工作台、对话和 MCP：每个能力只定义一次（字段、校验、影响权重、执行、可选的撤销），界面和工具都是它的投影。

核心理念是三件事：

- **能力契约**：字段、JSON Schema、声明式界面、MCP 工具和大模型工具都从同一份定义派生，不按能力各写一套。
- **多个入口**：人在工作台提交、人在对话里填智能表单、大模型调工具、外部 Agent 调 MCP，走同一条流水线。
- **权重审核**：写操作有 0–10 的影响权重。Agent 达到阈值或落在「必须人工审核」名单里时先停下来等人批；人亲手提交视为已经确认。

演示业务是采购询价：建产品、建询价草稿、发布给供应商、确认中标。数据在内存里，没有登录。

## 快速开始

```bash
npm ci
npm run dev
```

开发服务在 http://127.0.0.1:4817 。Next 开发模式默认只放行 localhost，配置里已把 `127.0.0.1` 加入允许来源，否则用这个地址打开页面不会完成加载。`npm run dev`、`npm run build` 和 `npm test` 会先执行 `npm run build:widget`，把智能界面打成单文件 HTML（`src/lib/mcp/widget/dist/widget.html`，不进 git）。新克隆的仓库装好依赖再启动就会带上这份界面。

生产构建：

```bash
npm run build
npm start
```

`npm start` 同样监听 4817。

没有真实模型密钥时，用自带的 OpenAI 兼容模拟服务（默认 4818）：

```bash
npm run mock:llm
```

地址是 `http://127.0.0.1:4818/v1`，默认要求 `Authorization: Bearer mock-key`。

| 变量 | 作用 |
|---|---|
| `LLM_BASE_URL`、`LLM_MODEL` | 同时设置时，列表里多一个只读提供方「环境变量」（id 为 `env`）。没有别的默认项时它就是默认 |
| `LLM_API_KEY` | 只读提供方的密钥，可省略 |
| `CURSOR_API_KEY` | 设置后，列表里多一个只读提供方「Cursor（环境变量）」（id 为 `env-cursor`）。这是用户自己的 Cursor API Key，不是本机其他 Cursor 凭据 |
| `CURSOR_TIMEOUT_MS` | Cursor 一轮运行的超时，默认 120000。超时会取消运行 |
| `CURSOR_DEBUG` | 设为 `1` 时，服务端把脱敏后的原始 Cursor 事件打到调试日志 |
| `PUBLIC_BASE_URL` | Cursor 智能体访问本服务 MCP 时使用的源地址。不设则从当前请求推导 |
| `AGENT_DATA_DIR` | 提供方配置目录，默认是项目下的 `data/`。Cursor 的空工作目录在其下的 `cursor-workdirs/` |
| `MOCK_LLM_PORT` | 模拟服务端口，默认 `4818` |
| `MOCK_LLM_KEY` | 模拟服务的 Bearer 密钥；未设置时是 `mock-key`，空字符串表示不校验 |
| `BASE_URL` | `npm run mcp:flow` 和 `npm run verify` 访问的本服务地址，默认 `http://127.0.0.1:4817` |
| `CHROME_PATH` | `npm run verify` 启动的 Chrome，默认 `/usr/local/bin/google-chrome` |

`data/`、`src/lib/mcp/widget/dist/`、`*.tsbuildinfo`、`next-env.d.ts` 都在 `.gitignore` 里。

## 三个入口怎么用

顶部可以在「对话」和「工作台」之间切换，并有「模型设置」。页面大约每 2.5 秒刷新，别的入口造成的变化能在工作台里看到。

### 工作台

左侧是总览、产品、询价单、供应商、审批、审计、策略、接入、模型设置。

- `/workbench` 总览：数量、待审批、写操作入口、最近审计
- `/workbench/products`、`/workbench/inquiries` 的表单来自智能 UI，不按能力手写。询价行上的发布、确认中标来自字段的 `refFilter`
- `/workbench/approvals` 批准或驳回，可带备注
- `/workbench/audit` 按结果和操作者筛选，可标记抽查，有撤销逻辑的可以回滚
- `/workbench/policy` 用滑块设阈值，每个能力可开关「必须人工审核」，保存前能预览哪些操作会自动执行
- `/workbench/connect` 是 MCP 地址和接入说明，并链到宿主模拟

工作台提交显式带 `actor: { "kind": "human", "surface": "workbench" }`。页头和询价行上有「让助手帮我」，会打开 `/chat?cap=<capabilityId>&prefill=<json>`。

直接调同一条流水线：

```bash
curl -X POST http://127.0.0.1:4817/api/invoke \
  -H 'content-type: application/json' \
  -d '{"capabilityId":"product.create","actor":{"kind":"human","surface":"workbench"},"input":{"name":"验收垫片","category":"五金","unit":"件","referencePrice":1.5}}'
```

成功 `200`，待审批 `202`，校验或业务拒绝 `422`，未知能力 `404`。不传 `actor` 时按 Agent 处理（`{ "kind": "agent", "surface": "llm" }`），不会默认成人。

`POST /api/reset` 把数据、策略、审批和审计恢复成种子。`GET /api/state` 看当前数据。

### 对话

`/chat` 的消息是 Vercel AI SDK 的 `UIMessage`（文字片段 + 工具片段）。引导模式的线程在 `sessionStorage`；选了模型之后用另一份线程。

**引导模式（无模型）**不调用模型，也不从自由文本里猜意图。开始任务只用这些入口：建议卡片、`/` 能力菜单、`+` 模块菜单、工作台的「让助手帮我」。直接打字会得到固定提示。`@` 可以引用产品、供应商或询价单，并预填对应字段。

选中的能力在输入框里是可移除标签。表单可以「我来提交」（`kind: "human"`，跳过闸门）或「交给智能体提交」（`kind: "agent"`，可能待审）。`pending_approval` 卡片可以就地批准或驳回。

**配置了模型之后**，消息走 `POST /api/chat`。`/`、`+`、`@` 不再直接插表单，而是把所选能力和引用写进用户消息，由模型决定下一步。模型要一次收集多个字段时调用 `show_form`，对话里出现同一份智能表单。模型发起的写操作身份固定为 `{ "kind": "agent", "surface": "llm" }`，工具参数里的 `actor` 会被丢掉。

模型选择记在 `localStorage`（`agent-native.model.v1`）。调用失败时可以重试，或手动切回引导模式。所选提供方已经不存在时，会自动回到引导模式并提示。

### MCP 和无界面

外部 Agent 用官方 MCP 客户端连接 Streamable HTTP：

`http://127.0.0.1:4817/api/mcp`

无状态：每个请求新建一个服务实例，响应是 JSON。`GET` 和 `DELETE` 返回 `405`。`POST` 需要同时接受 `application/json` 和 `text/event-stream`。

```json
{
  "mcpServers": {
    "agent-native-prototype": {
      "url": "http://127.0.0.1:4817/api/mcp"
    }
  }
}
```

能力工具的名字是能力编号里的 `.` 换成 `_`（`product_create`、`inquiry_create`、`inquiry_publish`、`inquiry_award`，以及只读的 `product_search`、`inquiry_list`、`supplier_list`）。另外有 `list_capabilities`、`get_ui_spec`、`get_approval_status`、`show_form`。没有批准或驳回工具。

调用身份固定为 `{ "kind": "agent", "surface": "mcp" }`。写操作可能返回 `pending_approval`（不是错误）：里面有审批号，下一步是告诉用户等待，并用 `get_approval_status` 查询。`rejected` 带 `isError: true` 和中文修正提示。批准只能由人调用 `POST /api/approvals/:id`，请求体 `{ "decision": "approve" }` 或 `"reject"`，可带 `note`。

不渲染界面时，工具的 `content` 文字和 `structuredContent` 足够走完「建产品 → 询价 → 发布 → 中标」。`npm run mcp:flow` 就是这条路径：开始时 `POST /api/reset`，发布和中标各一次人工批准，其余全是 MCP 工具。

### 外发智能 UI

智能界面只有一份。`show_form`、每个能力工具和 `get_approval_status` 用 `_meta.ui.resourceUri` 指向 `ui://agent-native/smart-ui-v1.html`（`text/html;profile=mcp-app`），并带上 ChatGPT 用的 `_meta["openai/outputTemplate"]`。界面在沙箱 iframe 里通过 `ui/*` 桥接收工具输入和结果，提交时调用 `tools/call`。身份仍是 MCP 的 Agent，所以该审核的操作会停在待审批，界面里不能批准。

本地不用外部产品就能看：打开 http://127.0.0.1:4817/host-sim 。它用官方 MCP 客户端连 `/api/mcp`，再用官方 `AppBridge` 把界面放进双层沙箱。勾选「模拟不支持 UI 的宿主」就只显示文字和结构化结果。接到 ChatGPT 的步骤见下文。

## 架构

```
能力契约（字段、verify、权重、execute、undo）
        |
        v
派生：zod / JSON Schema / 界面配置 / MCP 工具 / 模型工具
        |
        v
流水线：字段校验 → 业务校验 → 权重 → 策略闸门 → 执行 → 审计
        |
        +-- 工作台     POST /api/invoke     人显式声明 human
        +-- 对话引导   同一套 invoke        人提交或声明 agent
        +-- 对话模型   POST /api/chat       固定 agent / llm
        +-- Cursor     POST /api/chat       本地运行时，工具经 MCP，固定 agent / mcp
        +-- MCP        POST /api/mcp        固定 agent / mcp
        +-- 外发界面   经 MCP tools/call    仍是 agent / mcp
```

流水线顺序固定，任何入口都不能绕过：

1. **字段校验**：类型、必填、引用编号格式，以及引用是否存在。
2. **业务校验**：`verify` 返回 `block` 或 `warn`。`block` 拒绝且数据不变。
3. **权重**：`effectiveImpact = min(10, 基础权重 + 2 × 警告条数)`。
4. **策略闸门**：人跳过。Agent 的写操作在权重达到阈值，或能力在必审名单里时，生成待审批，先不执行。
5. **执行**：批准时按当前数据再跑一遍校验；出现 `block` 则该审批标为驳回。
6. **审计**：写操作记下入口、输入、权重、校验备注和结果。读操作不进闸门，也不记审计。

| 能力 | 类型 | 基础权重 | 说明 |
|---|---|---|---|
| `product.search` | 读 | 0 | 按关键词查产品 |
| `product.create` | 写 | 2 | 名称、品类、单位、参考价；可撤销 |
| `inquiry.list` | 读 | 0 | 查询价单 |
| `inquiry.create` | 写 | 3 | 产品、数量、截止日期、供应商；生成草稿；可撤销 |
| `inquiry.publish` | 写 | 6 | 发给供应商；可回到草稿 |
| `inquiry.award` | 写 | 9 | 确认中标；不可撤销；默认必须人工审核 |
| `supplier.list` | 读 | 0 | 供应商是种子数据 |

业务校验示例：截止日期不能是过去；数量超过 100000 拦截，超过 5000 警告；供应商品类不匹配警告；同产品已有进行中的询价警告；中标价高于参考价 30% 拦截、高于 10% 警告；状态不对（例如对已发布的询价再发布）拦截；中标供应商必须在邀请名单里；产品不能重名。拒绝时的说明是中文，并指出该怎么改。

## 审核机制

默认策略：阈值 `6`，必须人工审核 `["inquiry.award"]`。能力定义上的 `alwaysReview` 只用来生成这份默认列表；真正生效的是策略里的列表。`POST /api/reset` 会把策略一起恢复。

```bash
curl http://127.0.0.1:4817/api/policy

curl -X PUT http://127.0.0.1:4817/api/policy \
  -H 'content-type: application/json' \
  -d '{"threshold":7,"alwaysReview":["inquiry.award"]}'
```

`threshold` 是 0 到 10 的整数。权重小于阈值、且不在必审名单里的 Agent 写操作会直接执行。人（`actor.kind` 为 `human`）亲手提交跳过闸门，但仍跑校验和审计。

批准或驳回：

```bash
curl -X POST http://127.0.0.1:4817/api/approvals/A-001 \
  -H 'content-type: application/json' \
  -d '{"decision":"approve"}'
```

对已经决定过的审批再决定会返回 `409`。

审计（新的在前）、抽查、撤销：

```bash
curl http://127.0.0.1:4817/api/audit

curl -X POST http://127.0.0.1:4817/api/audit/L-001/review \
  -H 'content-type: application/json' \
  -d '{"mark":"ok","note":"抽查通过"}'

curl -X POST http://127.0.0.1:4817/api/audit/L-001/revert
```

只有已执行、能力本身提供了撤销、且尚未撤销的记录可以回滚。确认中标没有撤销。撤销不会把编号计数器倒回去。

`GET /api/capabilities` 列出当前策略下每个能力的工具名，以及 Agent 是否需要审核。

## 配置模型

设置页在 `/settings/models`。可以增删改提供方（名称、Base URL、API Key、模型名、可选自定义请求头），测试连接，设为默认。预设：OpenAI、DeepSeek、Moonshot、通义（兼容模式）、OpenRouter、本地 Ollama、自定义、Cursor（订阅额度）。

OpenAI 兼容提供方的 `kind` 是 `openai-compatible`（旧记录没有这个字段时按这个读）。Cursor 提供方的 `kind` 是 `cursor`，只要名称、API Key 和模型名（默认 `composer-2`，也可以填 `auto`），不使用 Base URL 和自定义请求头。

配置写在 `data/providers.json`（不进 git）。密钥和自定义请求头的值只留在服务器。列表和更新接口只返回 `apiKeyMasked`（例如 `sk-…abcd`）、`hasKey` 和 `headerNames`。

```bash
curl -X POST http://127.0.0.1:4817/api/providers \
  -H 'content-type: application/json' \
  -d '{"name":"本地测试","baseUrl":"http://127.0.0.1:4818/v1","model":"mock-model","apiKey":"mock-key"}'

curl -X PUT http://127.0.0.1:4817/api/providers/default \
  -H 'content-type: application/json' \
  -d '{"id":"<id>"}'

curl -X POST http://127.0.0.1:4817/api/providers/<id>/test
curl -X DELETE http://127.0.0.1:4817/api/providers/<id>
```

`baseUrl` 必须是 `http` 或 `https`，且不能把账号密码写进地址。更新时省略 `apiKey` 或传空字符串表示保留已保存的密钥。`PUT` 省略 `headers` 表示保留；传入对象（包括 `{}`）则整组替换。测试连接先请求 `GET {baseUrl}/models`，若返回 404、405 或 501，再发一条最多 1 token 的对话请求。

对话：

```bash
curl -N -X POST http://127.0.0.1:4817/api/chat \
  -H 'content-type: application/json' \
  -d '{"providerId":"<id>","messages":[{"id":"u1","role":"user","parts":[{"type":"text","text":"发布询价 Q-001"}]}]}'
```

响应是 UI Message 流。OpenAI 兼容引擎的工具从能力契约派生（名字与 MCP 相同），另外有客户端工具 `show_form` 和只读的 `get_approval_status`。服务端最多走 8 步。`pending_approval` 要求模型告诉用户等待，不要再重试。

## Cursor 引擎

在模型设置里选预设「Cursor（订阅额度）」，到 [Cursor 控制台](https://cursor.com/dashboard/cloud-agents) 创建个人 API Key，粘贴保存。对话里的模型选择器会标出「Cursor」。选中之后不需要再配 Base URL。

每一轮 `POST /api/chat` 在服务器上用 `@cursor/sdk` 的**本地运行时**跑一个 Cursor 智能体。工作目录是 `data/cursor-workdirs/<chatId>/`，按对话新建，里面是空的。同一条对话用内存里的 agent id 调用 `Agent.resume` 接着说；服务重启后对不上时会重新 `Agent.create`。第一轮提示词前面有一段中文约束：只使用 MCP 服务器 `agent-native` 的工具，先 `list_capabilities`，用工具结果里的真实编号，多个字段用 `show_form`，`pending_approval` 要告诉用户并停止重试。快捷入口的上下文提示和 OpenAI 兼容路径共用同一段文案。

工具不走模型路径的函数调用，而是把 `mcpServers.agent-native` 指到本服务的 `/api/mcp`（地址来自当前请求，或 `PUBLIC_BASE_URL`）。因此写操作仍然是 `{ "kind": "agent", "surface": "mcp" }`，审核和审计不变。`show_form` 在 MCP 里会立刻返回表单数据；对话把这份结果渲染成可填写的智能表单，人提交后再补一句「我已提交表单：…」，让 Cursor 智能体知道结果。

SDK 提供了限制内置工具的开关：`AgentOptions.tools`。本引擎在 `Agent.create` 和 `Agent.resume` 都传入 `tools: ["mcp"]`，只把 MCP 这一组工具提供给模型（省略 `"mcp"` 会关掉 MCP；`[]` 表示没有任何内置工具）。这个限制不会写进智能体记录，所以续聊时必须再传一次。它限制的是提供给模型的工具集合；本地执行器本身仍在进程里。流里如果仍然出现 shell、读文件等非业务工具，界面只提示一次「智能体尝试使用了非业务工具，已忽略」，不画成卡片。

该引擎会在服务器上以本地模式运行 Cursor 智能体，仅用于本机或受信任环境的实验。本地运行时使用**这台服务器自己的权限**，工作目录是空的，提示词要求它不要读文件、写文件、跑命令或浏览。密钥只留在服务器，接口和日志会脱敏。

用真实密钥做一次冒烟（没有密钥会直接退出，不会访问网络）：

```bash
CURSOR_API_KEY=你的密钥 npm run cursor:smoke
```

脚本在 `BASE_URL`（默认 http://127.0.0.1:4817）没有服务时会自己启动开发服务，结束时关掉，并删掉临时提供方。它发一轮「查看现有的询价单」，打印文本、工具名和状态，要求至少调用一个我们的工具且流里没有错误块。密钥最多显示前 6 个字符。`CURSOR_DEBUG=1` 时，由脚本拉起的服务会把脱敏后的原始事件打到标准错误，方便对照真实事件形状调整解析。

事件和工具名的解析按 SDK 1.0.37 的类型写过，并用假 SDK 测过这些形状：`tool_call.name` 为 `mcp` 且 `args.toolName` / `args.args` 带具体工具（类型里的 `McpToolCall`），以及 `inquiry_publish`、`mcp__agent-native__inquiry_publish`、`agent-native-inquiry_publish`。没有用真实密钥对过线上事件，名称若不同，冒烟会失败并打印记录，需要再调解析。

对话选择器里的 Cursor 提供方、设置页的测试连接（`Cursor.me` 与 `Cursor.models.list`）和上面的流，单元测试都用注入的假 SDK，不会拿环境里的其他 Cursor 凭据去访问网络。

模拟服务除了认「新建产品」「发布询价 Q-001」「确认中标 … 价格 …」这些句子，还认一条通用指令：在**最后一条用户消息**里写

```text
[[call:<tool_name>:<json>]]
```

例如 `[[call:product_create:{"name":"验收螺栓","category":"五金","unit":"件","referencePrice":2.5}]]`。它会原样发出这一次工具调用。工具结果回到模型之后，下一次回复是结果摘要，不会把同一条指令再执行一遍。正文含「触发错误」时返回 HTTP 500。直接运行 `npm run mock:llm` 时，标准输出会再写一遍这条格式。

某个模型名如果被模拟服务标成必须带请求头（验收脚本里的 `mock-beta` 要带 `x-vendor-token`），缺少该头会 401，响应里不回显头的值。

## 把智能 UI 接入外部 Agent

资源、CSP 和本地宿主模拟见上面的「外发智能 UI」。真实 ChatGPT 要人在开发者模式里亲手确认，本仓库的测试没有覆盖这一步。

1. 让 `/api/mcp` 有一个公网 HTTPS 地址。本机可以用隧道把 4817 暴露出去，路径仍然是 `/api/mcp`。
2. 在 ChatGPT 的开发者模式里添加自定义连接器，地址填这个 HTTPS URL。
3. 新开一轮对话，让它调用 `show_form`（例如创建询价）。支持 MCP Apps 的宿主会在对话里渲染同一份智能界面；不支持的宿主仍然能读文字结果并把流程走完。
4. 界面里的提交走 MCP，该审核的操作会停在待审批。批准要回到本站工作台，或调用 `POST /api/approvals/:id`。

其他支持 MCP Apps 的宿主可以按同样的资源地址接入，本仓库没有逐个验证。

## 验收

```bash
npm test          # 单元测试和组件测试
npm run typecheck
npm run lint
npm run verify    # 对着正在运行的服务，或自己拉起 next dev
```

`npm test` 覆盖契约、流水线、审批、回滚、MCP、对话路由、模型密钥脱敏和引导模式的纯函数。

`npm run verify` 在 `BASE_URL`（默认 http://127.0.0.1:4817）没有服务时会自己启动 `npm run dev`，结束时关掉，包括失败和 Ctrl-C。模拟模型在进程内找一个空闲端口。每项检查前会 `POST /api/reset` 并恢复策略，连续跑两次都应通过。某项失败时进程以非零状态退出。Chrome 启动不了时，「外发 UI」记为 SKIP 并写明原因，不会当成通过。

| 检查 | 证明 |
|---|---|
| 一致性 | 工作台 HTTP、模拟模型的工具调用、MCP 完成同一任务（建「验收螺栓」→ 询价 1000、截止今天起 14 天、供应商 S-001 与 S-002 → 发布 → 以 2.6 中标给 S-001）。规范化后的产品和询价一致。人工直接执行；两条 Agent 路径在发布和中标上是待审然后执行 |
| 无界面 | 上面的 MCP 路径只用 MCP 工具，加上文档里的人工批准 |
| 验证机制 | 过期日期、数量 100001、未知产品、中标价超过参考价 1.3 倍、未邀请的供应商、重复发布、重名产品、缺字段，经 HTTP、MCP 和模型各打一遍，都被拒绝并带中文修正提示，业务数据不变 |
| 策略 | 阈值 6 时 Agent 发布待审，阈值 7 时执行；阈值 10 仍会因必审名单拦住权重 2 的新建产品；中标移出必审名单后，阈值 6 仍因权重 9 待审，阈值 10 且价格干净时执行；人在阈值为 0 时也不进审核；HTTP 不传 actor 视为 agent |
| 外发 UI | 无头 Chrome 打开 `/host-sim`，在沙箱里填写创建询价并提交，草稿与另外两个入口相同 |
| 模型可换 | 两个模型名（其中一个带必填请求头）各设为默认并完成一轮对话；删掉所选模型后对话接口说明模型不存在；客户端选择逻辑会回到引导模式；响应正文里没有密钥 |
| Cursor 引擎 | 在验收进程里注入假 SDK，走完整 `POST /api/chat`：文本、`list_capabilities`、MCP 地址、智能体被释放、没有错误块、响应不含密钥。注入失败时 SKIP 并写明原因。没有密钥时不会访问 Cursor |

脚本末尾还有一段不计分的「手动验证项」：新用户的零学习成本，以及 ChatGPT 开发者模式。

## 项目结构

```
src/lib/contract/       契约类型、zod / JSON Schema / 界面配置的派生
src/lib/capabilities/   产品、询价、供应商的能力定义（改这里即全部入口生效）
src/lib/server/         流水线、内存数据、策略与审计、模型配置、对话
src/lib/mcp/            MCP 服务、工具结果、外发 widget 资源
src/smart-ui/           与页面解耦的智能 UI 渲染器
src/widget/             打进单个 HTML 的外发界面
src/app/                工作台、对话、设置、宿主模拟，以及 /api/*
src/components/         工作台和对话的界面
scripts/mock-llm.ts     模拟 OpenAI 兼容服务
scripts/mcp-flow.ts     只用 MCP 走完业务流程
scripts/verify.ts       验收脚本
scripts/cursor-smoke.ts 用真实 Cursor API Key 打一轮对话
```

## 已知局限与安全说明

- 产品、询价、审批和审计都在进程内存里，重启即丢失。`POST /api/reset` 回到种子数据。没有数据库，也没有登录。
- **HTTP `/api/invoke` 信任调用方自己声明的 actor。** 这是原型的信任边界：客户端可以声称自己是人，从而跳过闸门。生产环境里，入口和操作者必须来自已认证的会话，不能由请求体指定。MCP 和 `/api/chat` 会强制使用 agent，并丢掉参数里的 actor。
- 模型 API Key 和自定义请求头的值只在服务端。接口只返回脱敏结果；失败响应和日志会去掉密钥、请求头的值和 `Authorization`。即便如此，这台服务没有鉴权，任何能访问它的人都能改配置、读业务数据。
- ChatGPT 联调依赖公网 HTTPS 和人工在开发者模式里确认，本仓库没有自动验证。零学习成本（新用户不看说明就能做完）也只作为手动项，不由脚本判定。
- 对话测试用的是模拟模型，不是一家厂商的真实模型。模型不支持函数调用时，没有提示词兜底。
- Cursor 引擎的事件和工具名只对照了 SDK 类型和假 SDK。本地运行时的实际延迟、智能体能否访问本机 `/api/mcp`、`tools: ["mcp"]` 是否在真实模型上完全挡住内置工具，要用 `npm run cursor:smoke` 和一把真实 API Key 确认。续聊的 agent id 只存在当前进程的内存里。
- 外发界面的 HTML 必须先构建（`npm run build:widget`，或由 `predev` / `prebuild` / `pretest` 触发）。没构建时，读取 widget 资源会失败并提示先构建。
- 撤销创建时不回退编号计数器，避免乱序回滚造成编号冲突。

## 后续

**阶段二：Agent 对 Agent。** 对方也是 Agent 时，「不可撤回」的边界和沟通成本会变，权重模型可能要加上「对象类型」这一维。

另外还没做的：真实登录、会话鉴权和 OAuth；持久化数据库；多层审核、多人会签，以及跨站流程的责任划分。
