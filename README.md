# dsh-image-budget

**DSH 的图片预算守卫。** 一张截图就能顶掉半个上下文窗口 —— 这个插件让它在进入上下文之前变小，并在已经被图毒死的会话里做一次性救援。

> 前身是 [`dsh-compaction-doctor`](https://github.com/yin1895/dsh-compaction-doctor)。那个插件试图"修压缩引擎"，但压缩引擎挂在 preset 的 `isolate` realm 里，根平面注册的实现根本没有会话在用（详见[为什么这么改](#为什么不是去修压缩引擎)）。这个版本换成从源头守住图片字节，不依赖任何私有实现。

## 问题

`read_image` 把图片以 data URL（base64）写进消息，上游按**文本**计 token。实测（DSH 0.2.1-rc.3，第三方网关线路）：

| 事实 | 数字 |
| --- | --- |
| 图片的 token 成本 | **≈ 0.911 × 文件字节**（约 1.46 char/token） |
| 一张 1790×1258 的拼图（538 KB） | 490,502 token |
| 同一张图在 `dsh-token-meter` 里的记价 | **45 token**（只按附件引用 JSON 计价） |
| 真实 prompt（两张图 + 历史） | ≈ 1,190,000 |
| meter 读数 | 542,635，**低于**阈值 550,464 → 判"无压力" |
| 上游反应 | `400 内容太长了，请精简输入或开启新对话` |
| 之后 | 自动压缩不触发；手动 `/compact` 把整面（含图）重发 → 摘要自己超窗 → 永久失败 |

关键在最后一行：压缩只保留最新节点，而图就在最新节点里 —— **压缩在结构上永远删不掉它们**。meter 与真实计价差四个数量级，所以"等它报警再压缩"这条路根本不通。

## 三个动作

```
read_image ──► ① 事前守门 ──► 超预算？压到预算内，换新附件；压不动就拦下
                                   │
请求 400 ────► ③ 请求救援 ──► 按字节淘汰最大的图 → 重试（当轮就能继续）
摘要 400 ────► ② 摘要救援 ──► 按字节淘汰最大的图 → 宿主带占位符重跑摘要
```

| 动作 | 缝 | 语义 |
| --- | --- | --- |
| ① 事前守门 | `tools/post-execute`（`prepend`） | 图超过 `maxImageBytes` 就地降采样（长边 900→480、JPEG q55→30 逐级），存成**新附件**并替换图片块；压不动就删掉图片只留可执行指引 |
| ② 摘要救援 | `compaction/summary-error`（`prepend`） | 识别中/英/网关三种"内容太长"措辞，写 `image/offload` 投影并返回 `true` |
| ③ 请求救援 | `agent/request-error`（`prepend`） | 同类错误在主请求上发生时淘汰图片后 `{kind:"retry"}` |

三条保证：

- **超预算的图永远不会进入上下文**（没有可用后端时也一样，退化成拦截）；
- **压缩不会把图删掉** —— 只是变小，图还能看（版面、标题可辨；逐字核对请裁剪）；
- **插件自身出错时一律放行**，绝不让一次工具调用或一次压缩因为插件崩掉。

## 安装

DSH 的插件行写在 profile 的 `cordis.patch.yml`（`~/.dsh/profiles/<profile>/cordis.patch.yml`）里。

```yaml
- insert:
    - id: image-budget
      name: 'dsh-image-budget'
      config:
        maxImageBytes: 60000
```

把包放进 profile 的 `node_modules`：

```bash
git clone https://github.com/yin1895/dsh-image-budget.git /tmp/dsh-image-budget
cp -R /tmp/dsh-image-budget ~/.dsh/profiles/desktop/node_modules/dsh-image-budget
```

重启 DSH 生效。想先确认不会影响启动，可以加 `dryRun: true`（钩子全惰性），起来之后再去掉。

> 另一个装法是把 `dsh-image-budget` 加进 profile `package.json` 的 `dsh.profile.bundles`，
> 由包自带的 `cordis.patch.yml` 完成插入。**两种方式只能选一种**，否则同一个 `id`
> 会被插入两次。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `maxImageBytes` | `60000` | 单图字节上限；60000 B ≈ 55k token |
| `tokensPerByte` | `0.911` | 实测换算系数，只用于提示文案与统计 |
| `mode` | `compress` | `compress` 降采样替换；`annotate` 只拦下并给指引 |
| `edges` | `[900, 800, 700, 620, 540, 480]` | 逐级尝试的长边 |
| `qualities` | `[55, 45, 38, 30]` | 逐级尝试的 JPEG 质量 |
| `backends` | `[]` | 后端白名单，如 `["sharp"]`；空 = 全部允许 |
| `sharpModule` | `""` | 显式指定 sharp 模块路径 |
| `rescueSummary` | `true` | 摘要失败时按字节淘汰图片 |
| `summaryKeepImageBytes` | `150000` | 救援后保留的图片总字节（≈137k token） |
| `rescueRequest` | `true` | 主请求溢出时淘汰图片并重试 |
| `maxRescuesPerStep` | `2` | 单个 step 内的救援次数上限（防活锁） |
| `dryRun` | `false` | 只加载不动作 |

## 跨平台

图片编码器按顺序探测，**任何一条命中就够用**：

| 顺序 | 后端 | 覆盖范围 |
| --- | --- | --- |
| 1 | `sharpModule`（配置） | 用户显式指定 |
| 2 | **宿主进程参数里的 DSH 安装根** → `node_modules/sharp` | 所有 DSH 桌面安装（应用自己就带 sharp），macOS / Linux / Windows 通用 |
| 3 | 插件自身位置 `import("sharp")` | 把 sharp 装在插件旁边的场景 |
| 4 | `DSH_APP_ROOT` / `DSH_RUNTIME_ROOT` / `DSH_HOME` | 非常规安装位置 |
| 5 | `sips` → `magick` → `convert` → `ffmpeg` → `python`+Pillow | 没有 sharp 但装了任一工具 |
| 6 | 都没有 | **拦截模式**：图不进上下文，返回可执行的替代命令 |

所有外部命令都用 `execFile` + argv 数组调用，不经过 shell —— Windows 上没有引号/转义差异，路径带空格也不会散架。临时目录用 `os.tmpdir()`，路径拼接用 `node:path`。

查询本机命中了哪个后端：

```bash
node -e "import('dsh-image-budget').then(m=>console.log(m.describeBackends()))"
```

CI 在 **macOS / Ubuntu / Windows × Node 20 / 22** 上跑同一套断言，另有一条"没有 sharp"的作业专门验证拦截保证（`.github/workflows/test.yml`）。

## 测试

```bash
npm install
npm test              # 53 条断言
npm run test:report   # 附带本机后端探测结果
node test/run.mjs --no-backend-ok   # 模拟没有图片编码器
```

夹具在进程内生成（不提交二进制），所以在哪个平台跑都是同一组断言。

## 为什么不是去修压缩引擎

DSH 的 agent 预设（例如创造模式 `cordis`）把 `compaction` 放在一个 `isolate: { compaction: true }` 的组里：

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate: { compaction: true, toolResultPruner: true }
```

而 `dsh-agent-preset-registry` 的 `mountPreset()` 明确要求：preset 发布的服务必须在 isolate realm 里，泄漏到 root 会直接挂载失败。

结论：**在 profile 根平面注册一个 `compaction` 实现，会话根本不会用它** —— 会话解析到的是 preset 私有 realm 里的那个。旧版 `dsh-compaction-doctor` 就卡在这里：它的 engine 实例在 root realm 里空转，UI 计数全为 0，只有全局事件钩子留下了痕迹。

所以本插件**不发布任何服务**，只挂全局事件（事件跨 realm 传播），从而对 `standard` / `cordis` / 任何自定义预设同时生效。

## 与 `readimg.sh` 之类的手动预检的关系

互补，不替代：手动预检省一次工具往返、可以自己挑参数；本插件兜住所有"忘了"的场合（包括子代理、脚本、别的 skill）。装了插件之后手动预检仍然值得保留。

## License

MIT