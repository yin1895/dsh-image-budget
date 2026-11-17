# 图片预算守卫

一张截图就能顶掉半个上下文窗口。本插件让它在进入上下文之前变小，并在已经被图毒死的会话里做一次性救援。

## 它解决什么

```
read_image ──► ① 事前守门 ──► 超预算？压到预算内换新附件；压不动就拦下
                                   │
请求被拒 ────► ③ 请求救援 ──► 按字节淘汰最大的图 → 重试（当轮继续）
摘要被拒 ────► ② 摘要救援 ──► 按字节淘汰最大的图 → 宿主带占位符重跑摘要
```

| 动作 | 事件 | 语义 |
| --- | --- | --- |
| ① 事前守门 | `tools/post-execute` | `read_image` 的图超过 `maxImageBytes` 就地降采样（长边 900→480、JPEG q55→30 逐级），存成**新附件**并替换图片块；压不动就删掉图片只留可执行指引 |
| ② 摘要救援 | `compaction/summary-error` | 识别中/英/网关三类"内容太长"措辞，写 `image/offload` 投影并返回 `true` |
| ③ 请求救援 | `agent/request-error` | 同类错误在主请求上发生时淘汰图片后返回 `{"kind":"retry"}` |

三条保证：

- **超预算的图永远不会进入上下文**（没有任何图片后端时也一样，退化成拦截）；真机实测：538,463 B 的图被换成 31,742 B 的副本，模型看到的就是副本；
- **压缩不会把图删掉**，只是变小（版面与标题可辨；逐字核对请裁剪）；
- **插件自身出错一律交回下游**，绝不改变宿主的决策，也绝不截断监听器链。

## 为什么需要它

以 DSH 0.2.2-rc.3、第三方网关线路的实测为例：

| 事实 | 数值 |
| --- | --- |
| 图片的实际成本 | `token ≈ 0.911 × 文件字节`（按 base64 文本计价，约 1.46 char/token） |
| 一张 1790×1258 拼图（538 KB） | 约 490,000 token |
| 同一张图在 token 计量器里的价格 | 约 45 token（`estimateStructuralBlock` 只按附件引用 JSON 计价） |
| 真实请求 | 约 1,190,000 token，超过 1M 窗口 |
| 计量器读数 | 542,635，**低于**阈值 550,464 → 自动压缩判定"无压力" |
| 上游反应 | `400 内容太长了，请精简输入或开启新对话` |
| 结果 | 摘要请求把同一批图重发，自己就超窗 → `/compact` 永远失败 |

根本原因不在压缩算法：压缩只保留最新节点，而图就在最新节点里 —— **压缩在结构上永远删不掉它们**。计量器与真实计价相差四个数量级（第三方网关不声明 `imageRequestPricing`），所以"等它报警再压缩"这条路不通。

## 安装

安装由 DSH 的 **Plugins → Add plugin**（或 `plugin_manager` 的 `install_bundle`）完成。把本目录交给它即可，不要手工改 profile 的 `package.json` / `cordis.patch.yml`，也不要在 profile 目录里跑包管理器。

配置改在生成的 bundle 行里，例如：

```yaml
config:
  maxImageBytes: 60000
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `maxImageBytes` | `60000` | 单图字节上限；≈55k token |
| `tokensPerByte` | `0.911` | 实测换算系数，只用于提示文案与统计 |
| `mode` | `compress` | `compress` 降采样替换；`annotate` 只拦下并给指引 |
| `edges` / `qualities` | `[900…480]` / `[55…30]` | 逐级尝试，先保清晰度再保体积 |
| `backends` | `[]` | 后端白名单，如 `["sharp"]` |
| `sharpModule` | `""` | 显式指定 sharp 模块路径 |
| `rescueSummary` | `true` | 摘要失败时按字节淘汰图片 |
| `summaryKeepImageBytes` | `150000` | 救援后保留的图片总字节（≈137k token） |
| `rescueRequest` | `true` | 主请求溢出时淘汰图片并重试 |
| `maxRescuesPerStep` | `2` | 单个 (agent, step) 的救援次数上限 |
| `maxRescuesPerSession` | `20` | 单个会话的摘要救援总次数上限 |
| `dryRun` | `false` | 只加载不动作 |

## 跨平台

图片编码器按顺序探测，**任一命中即可**：

| 顺序 | 后端 | 覆盖范围 |
| --- | --- | --- |
| 1 | `sharpModule`（配置） | 用户显式指定 |
| 2 | 宿主进程参数里的 DSH 安装根 → `node_modules/sharp` | 所有 DSH 桌面安装（应用自带 sharp），macOS / Linux / Windows 通用 |
| 3 | 插件自身位置 `sharp` | 把 sharp 装在插件旁边 |
| 4 | `DSH_APP_ROOT` / `DSH_RUNTIME_ROOT` / `DSH_HOME` | 非常规安装位置 |
| 5 | `sips` → `magick` → `convert` → `ffmpeg` → `python`+Pillow | 没有 sharp 但装了任一工具 |
| 6 | 都没有 | **拦截模式**：图不进上下文，返回可执行的替代命令 |

所有外部命令都用 `execFile` + argv 数组调用，不经过 shell —— Windows 上没有引号/转义差异，路径带空格也不会散架。临时目录用 `os.tmpdir()`，路径拼接用 `node:path`。

查询本机命中了哪个后端：

```bash
node -e "import('./lib/image.js').then(m=>console.log(m.describeBackends()))"
```

## 测试

```bash
npm install
npm test
```

```bash
npm test                 # 单元 + 宿主契约测试（必需）
npm run test:attachment  # 与真实附件仓储的集成测试（需要 DSH 的包，见下）
```

- `test/contracts.mjs` —— **宿主契约测试**，用真正的 `@deepseek-ai/cordis` 照抄宿主四个派发站点（含宿主读返回值的方式），验证监听器符合契约，并对 `lib/hooks.js` 的护栏做对抗性测试（忘记 next、抛错、异步拒绝、重复 next）；
- `test/run.mjs` —— 纯函数（溢出识别、图片索引、淘汰计划、类型嗅探）与后端压缩（含"没有后端也必须拦住"）；
- `test/attachment-local.mjs` —— 接宿主真实的 `@deepseek-ai/dsh-attachment-local`，验证 `saveImage` 收下压缩产物、引用能读回、守门全链路。DSH 的包不在 npm 上，本地这样跑：

```bash
DSH_PACKAGES_DIR=<DSH 的 node_modules> npm run test:attachment
```

> 为什么契约测试必须跑真 cordis：2.0.0–2.0.2 版本的测试用了一个自制的假 ctx，直接调用 handler，**测不出"监听器不调 `next()` 会否决整条链"**。那一版因此带着一个致命缺陷发布：`agent/pre-step` 监听器没有 `return next()`，让宿主每次回合开始都抛
> `Cannot read properties of undefined (reading 'kind')`。现在 `lib/hooks.js` 的 `onWaterfall()` 把这条规则变成结构约束，`test/contracts.mjs` 的"源码护栏"再确保不会有人绕过它。

CI 在 macOS / Ubuntu / Windows × Node 20 / 22 上跑 `npm test`，另有"没有 sharp"的作业验证拦截保证（`.github/workflows/test.yml`）。

## 卸载

用 **Plugins** 里的移除（或 `plugin_manager remove_bundle`）。命令行等价物是
`dsh plugin --profile <name> remove <pkg>` —— 它会同时清掉 bundle 选择和依赖声明，
卸载后 profile 正常启动。**不要**手工改 profile 的 `package.json` / `cordis.patch.yml`
再自己跑 pnpm，那会留下需要手工清理的状态。

## 已知边界

- **只读地**使用 `sessions.messageProjections`：若 `image/offload` 投影未挂载，摘要救援会降级为弃权（守门仍然生效），以免写出无法重放的会话事件。
- 救援后保留 `summaryKeepImageBytes` 字节的图片；如果删光图片仍然溢出，说明问题不在图片，插件不再重试。
- 插件不发布任何服务，只发布一个模块级的统计对象（`getStats()`），不写磁盘、不留状态。

## License

MIT
