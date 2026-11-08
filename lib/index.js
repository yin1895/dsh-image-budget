/**
 * `dsh-image-budget` —— 上下文里的图片预算守卫。
 *
 * ## 它解决什么
 *
 * `read_image` 把图片以 data URL（base64）写进消息，上游按**文本**计 token：
 * 实测 `token ≈ 0.911 × 文件字节`（约 1.46 char/token）。一张 538 KB 的
 * 1790×1258 拼图就是 490,502 token，两张足够把 1M 窗口顶穿。
 *
 * 而 `dsh-token-meter` 对 `image` 块只按**附件引用 JSON** 计价（同一张图记 45 token），
 * 因为第三方网关线路没有声明 `imageRequestPricing`。两者相差四个数量级，于是：
 *
 *   1. 压力读数说"还有余量"→ 自动压缩不触发；
 *   2. 请求被上游 `400 内容太长了` 拒绝；
 *   3. 溢出兜底与手动 `/compact` 把整面（含这两张图）重新塞进摘要请求 →
 *      摘要自己就超窗 → **永远做不出摘要**，会话进入"每轮必 400"的死状态。
 *
 * 压缩只保留最新节点，而图就在最新节点里 —— **压缩在结构上永远删不掉它们**。
 * 所以必须在"进上下文之前"就守住，再给已经中毒的会话留一条命。
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
 * ## 为什么挂在 profile 根而不是 preset 里
 *
 * 创造模式（preset `cordis`）把 `compaction` 关在 `isolate: {compaction:true}`
 * 的组里，preset 树里的服务只能在该 realm 内解析
 * （`dsh-agent-preset-registry.mountPreset` 拒绝把服务泄漏到 root）。
 * 本插件**不发布任何服务**，只挂全局事件 —— 事件跨 realm 传播，
 * 所以在根平面就能同时覆盖 agent 与 compaction 两条路径。
 *
 * 所有钩子都**失败即放行**（原样返回上游决策），绝不因为插件自身出错而
 * 让一次工具调用或一次压缩崩掉。
 *
 * @module dsh-image-budget
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { compressToBudget, describeBackends, resolveSharp } from "./image.js";
import { estimateTokens, human, looksLikeOverflow, planOffload } from "./plan.js";

/** 插件名（日志用）。 */
export const name = "image-budget";

/** 只依赖会话注册表：淘汰图片要走 `image/offload` 投影。 */
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
  /** 单个 step 内的救援次数上限（防活锁）。 */
  maxRescuesPerStep: 2,
  /** 只加载不动作，用于确认插件不破坏启动。 */
  dryRun: false,
};

/**
 * 挂载三个钩子。
 * @param ctx - 插件上下文（cordis）。
 * @param config - 见 {@link DEFAULTS}。
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) };
  const stats = {
    gated: 0,
    replaced: 0,
    annotated: 0,
    rescuedSummary: 0,
    rescuedRequest: 0,
    bytesSaved: 0,
    notes: [],
    backends: () => describeBackends(cfg),
  };
  const note = (line) => {
    if (stats.notes.length < 50) stats.notes.push(line);
  };
  ctx.set?.("imageBudget", stats);

  // ── 1. 事前守门 ───────────────────────────────────────────────────────────
  ctx.on(
    "tools/post-execute",
    async (exec, result, next) => {
      const decision = await next();
      try {
        if (cfg.dryRun) return decision;
        if (exec?.name !== "read_image") return decision;
        if (result?.isError === true) return decision;
        if (decision?.kind !== "accept" || !Array.isArray(decision.content)) return decision;

        const images = decision.content.filter((block) => block?.type === "image");
        if (images.length === 0) return decision;
        const over = images.filter((block) => Number(block.attachment?.bytes ?? 0) > cfg.maxImageBytes);
        if (over.length === 0) return decision;

        const biggest = over.reduce(
          (max, block) => (Number(block.attachment.bytes) > Number(max.attachment.bytes) ? block : max),
          over[0],
        );
        const originalBytes = Number(biggest.attachment.bytes);
        const path = typeof result?.value?.path === "string" ? result.value.path : "";
        stats.gated += 1;
        const head =
          `[image-budget] ${basename(path || "image")} ${originalBytes} B ≈ ${human(estimateTokens(originalBytes, cfg.tokensPerByte))} token，` +
          `超过单图预算 ${cfg.maxImageBytes} B（≈${human(estimateTokens(cfg.maxImageBytes, cfg.tokensPerByte))} token）。`;

        let replacement;
        if (cfg.mode === "compress" && path.length > 0) {
          replacement = await buildReplacement(ctx, path, originalBytes, cfg, head, note);
        }
        if (replacement !== undefined) {
          stats.replaced += 1;
          stats.bytesSaved += Math.max(0, originalBytes - replacement.bytes);
          return {
            kind: "accept",
            content: replacement.content,
            ...(decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts }),
          };
        }

        // 压不动 / 没有可用后端：拦下图片，只留可执行的指引。
        stats.annotated += 1;
        stats.bytesSaved += originalBytes;
        return {
          kind: "accept",
          content: annotate(decision.content, head, path, cfg),
          ...(decision.additionalContexts === undefined ? {} : { additionalContexts: decision.additionalContexts }),
        };
      } catch (error) {
        note(`gate error: ${String(error?.message ?? error)}`);
        return decision;
      }
    },
    { prepend: true },
  );

  // ── 2. 摘要救援 ───────────────────────────────────────────────────────────
  const rescues = new WeakMap();
  const used = (key) => rescues.get(key) ?? 0;

  ctx.on(
    "compaction/summary-error",
    (payload, next) => {
      if (cfg.dryRun || cfg.rescueSummary !== true) return next();
      try {
        const { session, sourceEventSeqs, error, signal } = payload ?? {};
        if (signal?.aborted) return next();
        if (session === undefined || !Array.isArray(sourceEventSeqs)) return next();
        if (!looksLikeOverflow(error)) return next();
        if (used(session) >= cfg.maxRescuesPerStep) return next();
        const plan = planOffload(session, sourceEventSeqs, cfg.summaryKeepImageBytes);
        if (plan.targets.length === 0) return next();
        session.append("image/offload", { targets: plan.targets });
        rescues.set(session, used(session) + 1);
        stats.rescuedSummary += 1;
        stats.bytesSaved += plan.freed;
        note(`summary rescue: offloaded ${human(plan.freed)} B of ${human(plan.total)} B images`);
        return true;
      } catch (error) {
        note(`summary rescue error: ${String(error?.message ?? error)}`);
        return next();
      }
    },
    { prepend: true },
  );

  // ── 3. 请求救援 ───────────────────────────────────────────────────────────
  ctx.on(
    "agent/request-error",
    (payload, next) => {
      if (cfg.dryRun || cfg.rescueRequest !== true) return next();
      try {
        const { agent, failure, signal } = payload ?? {};
        if (signal?.aborted) return next();
        const session = agent?.session;
        if (session === undefined) return next();
        if (!looksLikeOverflow(failure)) return next();
        if (used(agent) >= cfg.maxRescuesPerStep) return next();
        const seqs = Array.isArray(session.surface?.nodes) ? session.surface.nodes : [];
        const plan = planOffload(session, seqs, cfg.summaryKeepImageBytes);
        if (plan.targets.length === 0) return next();
        session.append("image/offload", { targets: plan.targets });
        rescues.set(agent, used(agent) + 1);
        stats.rescuedRequest += 1;
        stats.bytesSaved += plan.freed;
        note(`request rescue: offloaded ${human(plan.freed)} B, retrying`);
        return Promise.resolve({ kind: "retry" });
      } catch (error) {
        note(`request rescue error: ${String(error?.message ?? error)}`);
        return next();
      }
    },
    { prepend: true },
  );

  // 每个 step 重置救援预算：一次请求内的重试有界，跨 step 不累积。
  ctx.on("agent/pre-step", ({ agent } = {}) => {
    if (agent !== undefined) rescues.set(agent, 0);
  });
}

/** 压一张图并做成可用的替换内容；任何一步不满足就返回 undefined，交给拦截路径。 */
async function buildReplacement(ctx, path, originalBytes, cfg, head, note) {
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
    ref = await attachments.saveImage({
      data: small.data,
      mediaType: "image/jpeg",
      name: `${basename(path).replace(/\.[^.]+$/u, "")}-budget.jpg`,
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
    `image/jpeg image${dims.length > 0 ? `, ${dims}` : ""}, ${finalBytes} bytes\n</content>\n\n` +
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
      ? `magick "${target}" -resize 900x900\\> -quality 55 "%TEMP%\\small.jpg"   # 需要安装 ImageMagick；或 pip install pillow 后用 python -c`
      : `sips -Z 900 -s format jpeg -s formatOptions 55 "${target}" --out /tmp/small.jpg   # macOS；Linux 换 magick/convert`;
  const text =
    `${head}\n` +
    `这次读取已被拦截（原图未进入上下文）。请先生成合规副本再读：\n` +
    `  ${command}\n` +
    `  或直接用本插件的后端探测：node -e "import('dsh-image-budget').then(m=>console.log(m.describeBackends()))"\n` +
    `要看细节请裁剪局部（只读取要看的那块），或把整页图交子代理读、只回文字结论。`;
  const next = content.filter((block) => block?.type !== "image");
  if (next.length === 0) return [{ type: "text", text }];
  const last = next[next.length - 1];
  next[next.length - 1] = { type: "text", text: `${last?.text ?? ""}\n\n${text}` };
  return next;
}

export { compressToBudget, describeBackends, estimateTokens, looksLikeOverflow, planOffload, resolveSharp };