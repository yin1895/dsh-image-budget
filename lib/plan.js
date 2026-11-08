/**
 * 纯函数部分：识别"内容太长"错误、列出消息里的图片、规划要淘汰哪些图片。
 *
 * 这里不碰 Node API，也不碰 DSH 运行时，所以能在任何平台、任何 DSH 版本上
 * 单独测试（`node --test` / 自带的 test/run.mjs 都行）。
 *
 * @module dsh-image-budget/plan
 */

/**
 * 判断一个失败是否属于"上下文太长"。
 *
 * 不同供应商的措辞差别很大，而且第三方法务网关经常原样透传中文错误：
 *   - OpenAI 系：`context_length_exceeded`、`This model's maximum context length is …`
 *   - Anthropic 系：`prompt is too long: 200000 tokens > 199999 maximum`
 *   - 阿里百炼 / DashScope：`内容太长了，请精简输入或开启新对话`
 *   - 其它网关：`input is too long`、`reduce the length`、`too many tokens`
 *
 * 只看文本，不依赖 error.code —— 因为这类错误多半被映射成 `INVALID_REQUEST`，
 * 按 code 判断会漏。
 *
 * @param error - 任意失败对象（Error / 结构化 failure / 裸字符串）。
 * @returns 是否属于上下文溢出。
 */
export function looksLikeOverflow(error) {
  if (error === null || error === undefined) return false;
  if (typeof error === "string") return matchOverflow(error);
  if (typeof error !== "object") return false;
  if (String(error.code ?? "") === "CONTEXT_WINDOW_EXCEEDED") return true;
  const parts = [error.message, error.failure?.message, error.cause?.message, error.detail, error.reason];
  return matchOverflow(parts.filter((part) => typeof part === "string").join(" "));
}

const OVERFLOW_PATTERNS = [
  /内容太长|内容过长|上下文.{0,6}(太长|超长|超限)|请精简输入|精简输入或开启新对话/u,
  /prompt\s+is\s+too\s+long/iu,
  /context[\s_-]*(?:length|window).{0,24}(?:exceed|too\s+long|maximum)/iu,
  /exceed\w*\s+(?:the\s+)?(?:maximum\s+)?(?:context|token)/iu,
  /maximum\s+context\s+length/iu,
  /input\s+is\s+too\s+long/iu,
  /reduce\s+the\s+length/iu,
  /too\s+many\s+tokens/iu,
  /request\s+too\s+large/iu,
];

function matchOverflow(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * 列出一条消息里所有**尚未淘汰**的图片块。
 *
 * `imageIndex` 只对 image 块自增（与 `@deepseek-ai/dsh-compaction-image-offload`
 * 的投影完全一致：索引统计的是 image 出现次数，不是块序号）。
 *
 * @param message - 派生后的消息（`{content: Block[]}`）。
 * @returns `[{imageIndex, bytes}]`，`bytes` 取不到时为 0。
 */
export function imagesOf(message) {
  const found = [];
  let imageIndex = 0;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  for (const block of blocks) {
    if (block?.type !== "image") continue;
    const index = imageIndex++;
    if (block.offloaded === true) continue;
    const bytes = Number(block.attachment?.bytes ?? 0);
    found.push({ imageIndex: index, bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : 0 });
  }
  return found;
}

/**
 * 规划一次图片淘汰：**按字节从大到小**挑，淘汰到剩余图片总字节 ≤ `keepBytes` 为止。
 *
 * 为什么不是"从最老的开始"：内置的 `image/offload` 由 adapter 触发，动机是
 * "图太多"；这里的动机是"图太大"——一张 600KB 的拼图比二十张 20KB 的小图
 * 更能撑爆窗口，所以要先摘大的。
 *
 * 返回的 `targets` 可直接写进 `image/offload` 事件：
 * `session.append("image/offload", { targets })`。
 *
 * @param session - 会话对象，需要 `eventAt(seq)` 与 `deriveEventMessage(event)`。
 * @param seqs - 候选事件序列号（通常来自 `sourceEventSeqs` 或 `surface.nodes`）。
 * @param keepBytes - 淘汰后允许保留的图片总字节。
 * @returns `{targets, freed, total}`；无图或已达标时 `targets` 为空数组。
 */
export function planOffload(session, seqs, keepBytes) {
  const found = [];
  let total = 0;
  for (const seq of seqs ?? []) {
    const event = session?.eventAt?.(seq);
    if (event === undefined || event === null) continue;
    if (event.type !== "user/message" && event.type !== "tool/result") continue;
    let message;
    try {
      message = session.deriveEventMessage(event);
    } catch {
      continue;
    }
    for (const hit of imagesOf(message)) {
      found.push({ seq, ...hit });
      total += hit.bytes;
    }
  }
  if (found.length === 0 || total <= keepBytes) return { targets: [], freed: 0, total };

  found.sort((left, right) => right.bytes - left.bytes || left.seq - right.seq);
  const bySeq = new Map();
  let freed = 0;
  for (const hit of found) {
    if (total - freed <= keepBytes) break;
    const list = bySeq.get(hit.seq) ?? [];
    list.push(hit.imageIndex);
    bySeq.set(hit.seq, list);
    freed += hit.bytes;
  }

  const targets = [];
  for (const [seq, imageIndexes] of bySeq) {
    imageIndexes.sort((left, right) => left - right);
    targets.push({ seq, imageIndexes });
  }
  targets.sort((left, right) => left.seq - right.seq);
  return { targets, freed, total };
}

/** token 估算：实测 `token ≈ 0.911 × 文件字节`（base64 按文本计价）。 */
export function estimateTokens(bytes, tokensPerByte = 0.911) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * tokensPerByte);
}

/** 人类可读的短数字：`490502 → "490.5k"`。 */
export function human(n) {
  const value = Number(n) || 0;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}