# 智能 UI 渲染器

这个目录是阶段 6 要单独打包的通用渲染器。它只认契约里的 `UiSpec` 和 `InvokeResult`，不包含任何一个具体能力的分支。工作台、以后的对话卡片和外发 widget 都渲染同一套组件。

## 宿主适配

渲染器不请求本站接口，也不读取页面路由。宿主实现下面的接口，用属性传进来：

```ts
interface SmartUiHost {
  invoke(
    capabilityId: string,
    input: Record<string, unknown>,
  ): Promise<InvokeResult>;
  notify?(message: string): void;
}
```

- `invoke`：表单提交时调用。`capabilityId` 用的是 `spec.submit.tool`。`input` 已经按字段类型转换：数字是 `number`，多选是 `string[]`，空的选填字段不会出现。身份、刷新和提示由宿主负责。
- `notify`：可选。当前表单提交不调用它；阶段 4 以后的卡片可以用它给宿主发一条消息。

另外两个普通属性：

- `values` / `onChange`：受控表单。不传 `values` 时，组件自己保存状态，并用 `initialValues` 做初值。
- `initialValues`：只在非受控模式下作为初次状态。再次打开时由宿主更换组件 `key`。
- `readOnly`：字段不可改，提交按钮隐藏。对话里表单提交成功后用它把卡片锁住。
- `submitAccessory`：放在提交按钮旁边的额外内容。对话用它放「我来提交 / 交给智能体提交」，工作台不传。

## 组件

| 组件 | 输入 | 输出 |
|---|---|---|
| `SmartForm` | `UiSpec` + `SmartUiHost` | 按字段类型画出的表单，提交后接 `SmartResult` |
| `SmartResult` | `InvokeResult` | 状态（已执行 / 待人工审核 / 已拦截）、摘要、有效权重、拦截与警告、原因、审批编号、记录表 |
| `SmartTable` | 记录数组 | 按字段名推断列。表头来自契约字段名的中文对照，已知状态值用徽章 |
| `ImpactBadge` | 权重 0-10 | 低 / 中 / 较高 / 高 |
| `StatusBadge` | 状态字符串 | 已知状态的中文徽章 |

字段类型：`string` 文本框，`number` 数字框（带最小值），`date` 日期框，`enum` 和 `ref` 下拉框（选项来自 spec），`multiref` 复选列表。

影响权重只展示数字和色阶。渲染器不读取策略阈值，也不判断这次提交会不会进人工审核。

## 边界

可以引用 `@/lib/contract/types` 和 `@/components/ui`。不要引用 Next.js，不要引用 `@/lib/server`，组件内部不要请求本站接口。
