# 变更记录

## 3.0.1 — 修掉"守门静默不生效"（只有真机 runner 才能发现）

**修复**

- **守门读错了地方**。宿主的 `tools/post-execute` 契约是：工具结果的**内容在
  `result.content` 里**，终端默认决策只是裸的 `{kind:"accept"}`；监听器只有在
  主动改写时才返回 `decision.content`。旧实现去读 `decision.content`，于是拿到
  空数组、静默弃权 —— 真机实测：模型仍然看到 538,463 B 的原图，插件等于没装。
  现在读 `decision.content ?? result.content`（有前置监听器改写时以前者为准）。
- 测试替身同样修好：`HOST.postExecute` 之前把内容放进 fallback 决策里，等于把
  这个缺陷藏起来了；现在照抄 `pipeline.js:667-699`（含决策的应用步骤），返回的是
  宿主**应用决策之后**的最终结果 —— 也就是模型真正看到的东西。

**真机验证（沙箱 profile，真模型）**

| | 结果 |
| --- | --- |
| 修复前 | 工具结果 `image/png image, 1790x1258 px, 538463 bytes`，模型答 538463 |
| 修复后 | 工具结果 `image/jpeg image, 900x633 px, 31742 bytes` + 换算说明，模型答 31742 |

同一次 `turn_end completed`，无崩溃。538,463 B → 31,742 B（17 倍），≈490.5k → ≈28.9k token。

**卸载路径（沙箱实测）**

`dsh plugin --profile <name> remove <pkg>` 会同时清掉 `dsh.profile.bundles` 里的条目
和依赖声明，卸载后 profile 正常启动 —— **不要**手工改 profile 文件再自己跑 pnpm，
那才会留下要"深度清除"的状态。唯一残留是 `node_modules/<pkg>` 的悬空符号链接
（惰性，不影响启动）。

## 3.0.0 — 修复 2.x 的致命缺陷，并遵循 DSH 插件规范重做

**修复**

- **致命**：`agent/pre-step` 监听器没有 `return next()`。Cordis 的 waterfall 规定
  「不调用 `next()` 的监听器否决其后的整条链」，因此该事件返回 `undefined`，
  宿主紧接着读取 `decision.kind`，于是**每一次回合开始**都抛
  `Cannot read properties of undefined (reading 'kind')`，会话完全不可用。
  现已**取消**对该事件的订阅（步骤级计数改从 `agent/request-error` 的 payload 取），
  并新增 `lib/hooks.js` 的 `onWaterfall()`：把「必须把链交回下游」变成**结构约束** ——
  监听器返回 `undefined`、抛错、异步拒绝、重复 `next()`，宿主链都不再受影响。
- `ctx.set("imageBudget")` 在真 cordis 下会抛 `cannot set property … without provide`。
  现在不再发布任何服务，统计改由模块级 `getStats()` 暴露（卸载零残留）。
- 压缩产物按**魔术字节**声明媒体类型，不再假定 `image/jpeg`，避免
  `IMAGE_TYPE_MISMATCH`。
- 救援前确认 `image/offload` 投影已挂载；未挂载时降级为弃权，不写无法重放的会话事件。
- 配置做类型归一化：非法值退回默认并记入 `notes`，不在激活期抛错。

**测试**

- 新增 `test/contracts.mjs`：用**真正的** `@deepseek-ai/cordis` 照抄宿主四个派发站点
  （含宿主读返回值的方式），并对 `onWaterfall` 做对抗性测试。
  **该测试在 2.0.2 上会复现用户的原始报错** —— 这是这次修复的回归证明。
- 新增 `test/attachment-local.mjs`：接真实 `@deepseek-ai/dsh-attachment-local`，
  验证 `saveImage` 接受压缩产物、落盘引用可读回、以及守门全链路。
- 删除全部"假 ctx"：旧测试的假 ctx 直接调用 handler，测不出 waterfall 契约错误，
  正是 2.0.0–2.0.2 带着致命缺陷发布的原因。

**规范**

- 包按 DSH bundle 规范补齐：`exports` 含 `./locale/*.json` 与 `./icon`、`files` 列全、
  `icon.svg`（36×36、自包含、无脚本/`<text>`）、`locale/{en,zh}.json` 的 `meta.title`
  /`meta.description`/`meta.detail`、`docs/DETAIL.md`。
- 安装一律走 DSH 的 **Plugins → Add plugin** / `plugin_manager install_bundle`，
  不再手工改 profile 的 `package.json`、`cordis.patch.yml`，也不在 profile 目录里跑 pnpm。

## 2.0.0 — 从"修压缩引擎"转向"守住图片字节"

- 根因更正：问题不在压缩算法，而在「图片按 base64 文本计价（≈0.911 token/字节）
  而计量器只按结构计价（≈45 token/图）」这组数量级差异，加上「压缩只保留最新节点、
  而图就在最新节点里」。
- 三个动作：`tools/post-execute` 事前守门、`compaction/summary-error` 摘要救援、
  `agent/request-error` 请求救援。

## 1.x — dsh-compaction-doctor（已废弃）

- 试图在 profile 根平面提供 `compaction` 实现。但 agent 预设把 `compaction` 放在
  `isolate: {compaction:true}` 的组里，根平面注册的实现**没有会话在使用**；
  它只留下一个会吞掉 `compaction/summary-error` waterfall 的钩子。
