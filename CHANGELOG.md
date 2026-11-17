# 变更记录

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
