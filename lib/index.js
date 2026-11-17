/**
 * `dsh-image-budget` —— 上下文里的图片预算守卫。
 *
 * ## 它解决什么
 *
 * `read_image` 把图片以 data URL（base64）写进消息，上游按**文本**计 token：
 * 实测 `token ≈ 0.911 × 文件字节`（约 1.46 char/token）。一张 538 KB 的
 * 1790×1258 拼图就是约 490,000 token，两张足够把 1M 窗口顶穿。
 *
 * 而 `dsh-token-meter` 对 `image` 块只按**附件引用 JSON** 计价
 * （`estimateStructuralBlock`：`4 + ceil(JSON.length/4)`，同一张图记约 45 token），
 * 除非该路由的 adapter 声明了 `imageRequestPricing` —— 第三方网关线路不声明。
 * 两者相差四个数量级，于是：
 *
 *   1. 压力读数说"还有余量"→ 自动压缩不触发；
 *   2. 请求被上游以"内容太长"拒绝；
 *   3. 溢出兜底与手动 `/compact` 把整面（含这两张图）重新塞进摘要请求 →
 *      摘要自己就超窗 → **永远做不出摘要**，会话进入"每轮必失败"的死状态。
 *
 * 压缩只保留最新节点，而图就在最新节点里 —— **压缩在结构上永远删不掉它们**。
 * 所以必须在"进上下文之前"守住，再给已经中毒的会话留一条命。
 *
 * ## 三个挂载点
 *
 *  - `tools/post-execute`（事前守门）：`read_image` 的图超过 `maxImageBytes`
 *    就地降采样并替换成新附件；压不动就**拦下图片**只留可执行指引。
 *  - `compaction/summary-error`（摘要救援）：识别多语种"内容太长"，按字节
 *    从大到小写 `image/offload` 投影并返回 `true`，让宿主带占位符重跑摘要。
 *  - `agent/request-error`（请求救援）：同类错误在主请求上发生时淘汰图片后
 *    `{kind:"retry"}`，当轮不用重开会话。
 *
 * 三个监听器全部通过 {@link onWaterfall} 注册：它们都是 waterfall 事件，
 * 不拥有决策时必须把链交回下游，否则宿主会拿到 `undefined` 并崩溃。
 *
 * ## 为什么挂在 profile 根而不是 preset 里
 *
 * 创造模式（preset `cordis`）把 `compaction` 关在 `isolate: {compaction:true}`
 * 的组里，preset 树里的服务只能在该 realm 内解析
 * （`dsh-agent-preset-registry.mountPreset` 拒绝把服务泄漏到 root）。
 * 本插件**不发布任何服务**（只读地看一眼 `sessions.messageProjections`），
 * 只挂全局事件 —— 事件跨 realm 传播，所以在根平面就能同时覆盖 agent
 * 与 compaction 两条路径，并对任何预设生效。
 *
 * @module dsh-image-budget
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { onWaterfall } from "./hooks.js";
import { compressToBudget, describeBackends, sniffMediaType } from "./image.js";
import { estimateTokens, human, looksLikeOverflow, planOffload } from "./plan.js";

/** 插件名（日志用）。 */
export const name = "image-budget";

/**
 * 每次 `apply` 的统计，供诊断读取。
 *
 * 刻意**不**发布成服务：本插件不为其它插件提供任何能力，发布服务只会多一份
 * 需要在卸载时清理的状态（2.0.2 就因为 `ctx.set` 缺少 `ctx.provide` 在真 cordis
 * 下直接抛错）。模块级注册表零依赖、零持久状态，进程结束即消失。
 */
const REGISTRY = new Map();
let ordinal = 0;

/** 读取本进程内所有已挂载实例的统计（诊断用）。 */
export function getStats() {
  return [...REGISTRY.values()];
}

/**
 * 依赖的服务。`sessions` 只用于确认 `image/offload` 投影是否存在；
 * 缺失时救援会自己降级（见 `offloadAvailable`），不影响守门。
 */
export const inject = ["sessions"];

export const DEFAULTS = {
  /** 单图字节上限；60000 B ≈ 55k token。 */
  maxImageBytes: 60_000,
  /** 实测换算系数，只用于提示文案与统计。 */
  tokensPerByte: 0.911,
  /** `compress` 降采样替换；`annotate` 只拦下并给指引。 */
  mode: "compress",
  /** 逐级尝试的长边与 JPEG 质量。 */
  edges: [900, 800, 700, 620, 540, 480],
  qualities: [55, 45, 38, 30],
  /** 后端白名单：`["sharp"]` 只允许 sharp；空 = 全部允许。 */
  backends: [],
  /** 显式指定 sharp 模块（路径或 `sharp`）。 */
  sharpModule: "",
  /** 摘要失败时按字节淘汰图片。 */
  rescueSummary: true,
  /** 救援后允许保留的图片总字节（150 KB ≈ 137k token）。 */
  summaryKeepImageBytes: 150_000,
  /** 主请求溢出时淘汰图片并重试。 */
  rescueRequest: true,
  /** 单个 (agent, step) 内的请求救援次数上限（防活锁；每次救援必然删图，因此天然有界）。 */
  maxRescuesPerStep: 2,
  /** 单个会话内的摘要救援总次数上限（runaway 保险）。 */
  maxRescuesPerSession: 20,
  /** 只加载不动作，用于确认插件不破坏启动。 */
  dryRun: false,
};

/** 归一化并校验配置：非法值退回默认值并记一条 note，绝不在激活期抛错。 */
function normalize(config, notes) {
  const cfg = { ...DEFAULTS };
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = config?.[key];
    if (value === undefined) continue;
    if (key === "edges" || key === "qualities" || key === "backends") {
      if (Array.isArray(value) && value.every((item) => typeof item === "number" && item > 0 || typeof item === "string")) cfg[key] = value;
      else notes.push(`config.${key} 非法，已退回默认值`);
      continue;
    }
    if (typeof value !== typeof fallback) {
      notes.push(`config.${key} 类型应为 ${typeof fallback}，已退回默认值`);
      continue;
    }
    cfg[key] = value;
  }
  if (!(cfg.maxImageBytes > 0)) {
    notes.push("config.maxImageBytes 必须为正数，已退回默认值");
    cfg.maxImageBytes = DEFAULTS.maxImageBytes;
  }
  return cfg;
}

/**
 * 挂载三个钩子。
 * @param ctx - 插件上下文（cordis）。
 * @param config - 见 {@link DEFAULTS}。
 */
export function apply(ctx, config = {}) {
  const notes = [];
  const cfg = normalize(config, notes);
  const stats = {
    gated: 0,
    replaced: 0,
    annotated: 0,
    rescuedSummary: 0,
    rescuedRequest: 0,
    skippedNoProjection: 0,
    bytesSaved: 0,
    notes,
    backends: () => describeBackends(cfg),
  };
  const note = (line) => {
    if (stats.notes.length < 50 && !stats.notes.includes(line)) stats.notes.push(line);
  };
  REGISTRY.set(++ordinal, stats);
  ctx.logger?.info?.(`image-budget: 已挂载（maxImageBytes=${cfg.maxImageBytes}, mode=${cfg.mode}, dryRun=${cfg.dryRun}）`);
  for (const line of notes) note(line);

  /** `image/offload` 投影是否可用：不可用时救援降级，避免写出无法重放的会话事件。 */
  const offloadAvailable = () => {
    try {
      const projections = ctx.get?.("sessions")?.messageProjections;
      if (!Array.isArray(projections)) return true; // 无法确认时按可用处理，append 仍包在 try 里
      return projections.some((projection) => projection?.type === "image/offload");
    } catch {
      return true;
    }
  };

  /** 尝试写一次淘汰记录；返回是否真的写了。 */
  const commitOffload = (session, targets) => {
    if (!offloadAvailable()) {
      stats.skippedNoProjection += 1;
      note("image/offload 投影未挂载，跳过救援（守门仍然生效）");
      return false;
    }
    session.append("image/offload", { targets });
    return true;
  };

  // ── 1. 事前守门 ───────────────────────────────────────────────────────────
  onWaterfall(
    ctx,
    "tools/post-execute",
    async (exec, result, next) => {
      const decision = await next();
      try {
        if (cfg.dryRun) return undefined; // 弃权：包装器会把链交回下游
        if (exec?.name !== "read_image") return undefined;
        if (result?.isError === true) return undefined;
        if (decision?.kind !== undefined && decision.kind !== "accept") return undefined;

        // 内容在**结果**里，不在决策里。宿主的默认决策只是 `{kind:"accept"}`，
        // 图片块由工具结果携带；只有前面的监听器主动改写时 decision.content 才存在。
        // 读错地方会让守门静默失效 —— 这正是实测（真机 runner）抓到的问题。
        const current = Array.isArray(decision?.content) ? decision.content : result?.content;
        if (!Array.isArray(current)) return undefined;

        const images = current.filter((block) => block?.type === "image");
        if (images.length === 0) return undefined;
        const over = images.filter((block) => Number(block.attachment?.bytes ?? 0) > cfg.maxImageBytes);
        if (over.length === 0) return undefined;

        const path = typeof result?.value?.path === "string" ? result.value.path : "";
        const biggest = over.reduce(
          (max, block) => (Number(block.attachment.bytes) > Number(max.attachment.bytes) ? block : max),
          over[0],
        );
        const originalBytes = Number(biggest.attachment.bytes);
        stats.gated += 1;
        const head =
          `[image-budget] ${basename(path || "image")} ${originalBytes} B ≈ ${human(estimateTokens(originalBytes, cfg.tokensPerByte))} token，` +
          `超过单图预算 ${cfg.maxImageBytes} B（≈${human(estimateTokens(cfg.maxImageBytes, cfg.tokensPerByte))} token）。`;

        // 只有一张超预算时先处理它；多张时宿主会在此后各自再触发一次读取。
        if (cfg.mode === "compress" && path.length > 0) {
          const replacement = await buildReplacement(ctx, path, cfg, head, note);
          if (replacement !== undefined) {
            stats.replaced += 1;
            stats.bytesSaved += Math.max(0, originalBytes - replacement.bytes);
            return {
              kind: "accept",
              content: replacement.content,
              ...(decision?.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts }),
            };
          }
        }

        // 压不动 / 没有可用后端 / mode=annotate：拦下图片，只留可执行的指引。
        stats.annotated += 1;
        stats.bytesSaved += originalBytes;
        return {
          kind: "accept",
          content: annotate(current, head, path, cfg),
          ...(decision?.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts }),
        };
      } catch (error) {
        note(`gate error: ${String(error?.message ?? error)}`);
        return undefined; // 插件出错绝不改变宿主决策
      }
    },
    { prepend: true },
  );

  // ── 2. 摘要救援 ───────────────────────────────────────────────────────────
  const summaryRescues = new WeakMap();
  onWaterfall(
    ctx,
    "compaction/summary-error",
    (payload, next) => {
      if (cfg.dryRun || cfg.rescueSummary !== true) return undefined;
      try {
        const { session, sourceEventSeqs, error, signal } = payload ?? {};
        if (signal?.aborted) return undefined;
        if (session === undefined || !Array.isArray(sourceEventSeqs)) return undefined;
        if (!looksLikeOverflow(error)) return undefined;
        const used = summaryRescues.get(session) ?? 0;
        if (used >= cfg.maxRescuesPerSession) return undefined;
        const plan = planOffload(session, sourceEventSeqs, cfg.summaryKeepImageBytes);
        if (plan.targets.length === 0) return undefined;
        if (!commitOffload(session, plan.targets)) return undefined;
        summaryRescues.set(session, used + 1);
        stats.rescuedSummary += 1;
        stats.bytesSaved += plan.freed;
        note(`summary rescue: offloaded ${human(plan.freed)} B of ${human(plan.total)} B images`);
        return true; // 让宿主带占位符重跑摘要
      } catch (error) {
        note(`summary rescue error: ${String(error?.message ?? error)}`);
        return undefined;
      }
    },
    { prepend: true },
  );

  // ── 3. 请求救援 ───────────────────────────────────────────────────────────
  // 每 (agent, step) 计数：从 payload 的 step 派生，不额外订阅 agent/pre-step
  // （那个事件是 waterfall，订阅它就要正确地 return next()，得不偿失）。
  const requestRescues = new WeakMap();
  onWaterfall(
    ctx,
    "agent/request-error",
    (payload, next) => {
      if (cfg.dryRun || cfg.rescueRequest !== true) return undefined;
      try {
        const { agent, failure, signal, step } = payload ?? {};
        if (signal?.aborted) return undefined;
        const session = agent?.session;
        if (session === undefined) return undefined;
        if (!looksLikeOverflow(failure)) return undefined;

        const record = requestRescues.get(agent);
        const used = record !== undefined && record.step === step ? record.count : 0;
        if (used >= cfg.maxRescuesPerStep) return undefined;

        const seqs = Array.isArray(session.surface?.nodes) ? session.surface.nodes : [];
        const plan = planOffload(session, seqs, cfg.summaryKeepImageBytes);
        if (plan.targets.length === 0) return undefined;
        if (!commitOffload(session, plan.targets)) return undefined;

        requestRescues.set(agent, { step, count: used + 1 });
        stats.rescuedRequest += 1;
        stats.bytesSaved += plan.freed;
        note(`request rescue: offloaded ${human(plan.freed)} B, retrying`);
        return { kind: "retry" }; // 宿主据此重发本次请求
      } catch (error) {
        note(`request rescue error: ${String(error?.message ?? error)}`);
        return undefined;
      }
    },
    { prepend: true },
  );
}

/** 压一张图并做成可用的替换内容；任何一步不满足就返回 undefined，交给拦截路径。 */
async function buildReplacement(ctx, path, cfg, head, note) {
  let raw;
  try {
    raw = await readFile(path);
  } catch (error) {
    note(`read source failed for ${path}: ${String(error?.message ?? error)}`);
    return undefined;
  }

  const small = await compressToBudget(raw, cfg);
  if (small === undefined) return undefined;

  const attachments = ctx.get?.("attachments");
  if (attachments === undefined || typeof attachments.saveImage !== "function") return undefined;

  let ref;
  try {
    // 按实际字节声明类型：任一后端万一吐出 PNG/WebP，也不会被仓储判为类型不符。
    const mediaType = sniffMediaType(small.data);
    if (mediaType === undefined) {
      note(`compressed output of ${path} is not a recognizable image; falling back to annotate`);
      return undefined;
    }
    const extension = mediaType === "image/jpeg" ? "jpg" : mediaType.split("/")[1];
    ref = await attachments.saveImage({
      data: small.data,
      mediaType,
      name: `${basename(path).replace(/\.[^.]+$/u, "")}-budget.${extension}`,
    });
  } catch (error) {
    note(`saveImage failed: ${String(error?.message ?? error)}`);
    return undefined;
  }
  // 仓储可能按自己的策略重编码；以最终落盘的字节为准，保证承诺不破。
  const finalBytes = Number(ref?.bytes ?? small.bytes);
  if (!Number.isFinite(finalBytes) || finalBytes > cfg.maxImageBytes) {
    note(`attachment kept ${finalBytes} B > ${cfg.maxImageBytes} B; falling back to annotate`);
    return undefined;
  }

  const dims = small.width > 0 && small.height > 0 ? `${small.width}x${small.height} px` : "";
  const text =
    `<path>${path}</path>\n<type>image</type>\n<content>\n` +
    `${ref.mediaType} image${dims.length > 0 ? `, ${dims}` : ""}, ${finalBytes} bytes\n</content>\n\n` +
    `${head}已降采样为 ${finalBytes} B ≈ ${human(estimateTokens(finalBytes, cfg.tokensPerByte))} token` +
    `（长边 ${small.edge}px、JPEG q${small.quality}、${small.backend}）。` +
    `版面与标题可辨；正文要逐字核对请裁剪局部后重读，不要重读原图。`;

  return {
    bytes: finalBytes,
    content: [
      { type: "text", text },
      {
        type: "image",
        attachment: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
        },
      },
    ],
  };
}

/** 拦下图片，换成可执行的指引（永远不把超预算的图留在内容里）。 */
function annotate(content, head, path, cfg) {
  const target = path.length > 0 ? path : "<该文件>";
  const command =
    process.platform === "win32"
      ? `magick "${target}" -resize 900x900\\> -quality 55 "%TEMP%\\small.jpg"   # 需要 ImageMagick；或 pip install pillow`
      : `sips -Z 900 -s format jpeg -s formatOptions 55 "${target}" --out /tmp/small.jpg   # Linux 换 magick/convert`;
  const text =
    `${head}\n` +
    `这次读取已被拦截（原图未进入上下文）。请先生成合规副本再读：\n` +
    `  ${command}\n` +
    `要看细节请裁剪局部（只读取要看的那块），或把整页图交子代理读、只回文字结论。`;
  const next = content.filter((block) => block?.type !== "image");
  if (next.length === 0) return [{ type: "text", text }];
  const last = next[next.length - 1];
  next[next.length - 1] = { type: "text", text: `${last?.text ?? ""}\n\n${text}` };
  return next;
}

export { compressToBudget, describeBackends, estimateTokens, looksLikeOverflow, planOffload, sniffMediaType };
export { onWaterfall, onNotify } from "./hooks.js";
