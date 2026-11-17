#!/usr/bin/env node
/**
 * 纯函数与图像后端测试：**不需要 ctx，也不需要 cordis**。
 *
 *   node test/run.mjs [--report] [--no-backend-ok]
 *
 * 钩子行为测试在 `test/contracts.mjs` 里跑真 cordis —— 这里刻意不引入任何
 * "假 ctx"，因为 2.0.2 的事故正是假 ctx 掩盖了 waterfall 契约错误。
 */

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULTS } from "../lib/index.js";
import { compressToBudget, describeBackends, resetSharpCache, resolveSharp, sniffMediaType } from "../lib/image.js";
import { estimateTokens, imagesOf, looksLikeOverflow, planOffload } from "../lib/plan.js";
import { createReporter } from "./reporter.mjs";

const REPORT = process.argv.includes("--report");
/** CI 的"无图片编码器"作业用它：跳过硬采样断言，但仍验证拦截保证。 */
const ALLOW_NO_BACKEND = process.argv.includes("--no-backend-ok");
const { check, group, finish } = createReporter();

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 确定性伪随机（不用 crypto，保证跨机可复现）。 */
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * 生成一张"截图感"的大 PNG：白底 + 深色文字行 + 12% 灰噪点。
 * 噪点让 PNG 压不动（夹具足够大），整体仍是白底黑字（JPEG 能压到预算内）。
 */
async function makeFixture() {
  const sharp = resolveSharp({});
  if (sharp === undefined) return undefined;
  const width = 1400;
  const height = 980;
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels, 0xff);
  const random = lcg(20261108);
  for (let y = 40; y < height - 40; y += 14) {
    let x = 60;
    while (x < width - 80) {
      const run = 20 + Math.floor(random() * 90);
      for (let i = x; i < Math.min(x + run, width - 60); i += 1) {
        const offset = (y * width + i) * channels;
        raw[offset] = 20;
        raw[offset + 1] = 20;
        raw[offset + 2] = 20;
      }
      x += run + 12 + Math.floor(random() * 30);
    }
  }
  for (let index = 0; index < raw.length; index += channels) {
    if (random() > 0.12) continue;
    const value = 40 + Math.floor(random() * 180);
    raw[index] = value;
    raw[index + 1] = value;
    raw[index + 2] = value;
  }
  return sharp(raw, { raw: { width, height, channels } }).png({ compressionLevel: 6 }).toBuffer();
}

// ── 1. plan ─────────────────────────────────────────────────────────────────

group("plan：溢出识别");
check(looksLikeOverflow({ message: '400: {"message":"内容太长了，请精简输入或开启新对话"}' }), "识别中文『内容太长』");
check(looksLikeOverflow({ message: "prompt is too long: 200000 tokens > 199999 maximum" }), "识别 Anthropic 文案");
check(looksLikeOverflow({ message: "context_length_exceeded" }), "识别 OpenAI code");
check(looksLikeOverflow({ message: "This model's maximum context length is 128000 tokens" }), "识别 maximum context length");
check(looksLikeOverflow({ code: "CONTEXT_WINDOW_EXCEEDED", message: "x" }), "识别 error.code");
check(!looksLikeOverflow({ message: "rate limited, retry after 3s" }), "不把限流当溢出");
check(!looksLikeOverflow({ message: "invalid api key" }), "不把鉴权当溢出");
check(!looksLikeOverflow(undefined), "undefined 安全");
check(looksLikeOverflow("输入内容太长了"), "裸字符串也能判");

group("plan：图片枚举");
{
  const found = imagesOf({
    content: [
      { type: "text", text: "a" },
      { type: "image", attachment: { bytes: 10 } },
      { type: "text", text: "b" },
      { type: "image", attachment: { bytes: 20 }, offloaded: true },
      { type: "image", attachment: { bytes: 30 } },
    ],
  });
  check(found.length === 2, "跳过已淘汰的图片", JSON.stringify(found));
  check(found[1].imageIndex === 2, "索引只数 image 块（含已淘汰的）", String(found[1].imageIndex));
}

group("plan：淘汰计划");
{
  const event = (seq, bytes) => ({ seq, type: "user/message", data: { message: { content: [{ type: "image", attachment: { bytes } }] } } });
  const session = {
    eventAt: (seq) => [event(1, 538_463), event(2, 655_858), event(3, 1_000)].find((item) => item.seq === seq),
    deriveEventMessage: (item) => item.data.message,
  };
  const plan = planOffload(session, [1, 2, 3], 100_000);
  check(plan.targets.length === 2, "两张都淘汰", JSON.stringify(plan.targets));
  check(plan.freed === 538_463 + 655_858, "freed 等于两张之和", String(plan.freed));
  const partial = planOffload(session, [1, 2, 3], 600_000);
  check(partial.targets.length === 1 && partial.targets[0].seq === 2, "只淘汰最大的一张就够", JSON.stringify(partial.targets));
  check(planOffload(session, [3], 100_000).targets.length === 0, "已在预算内则不动");
  const empty = planOffload({ eventAt: () => undefined, deriveEventMessage: () => ({ content: [] }) }, [], 1);
  check(empty.targets.length === 0 && empty.total === 0, "空序列安全");
  check(estimateTokens(538_463) === 490_540, "token 估算 = 0.911×字节", String(estimateTokens(538_463)));
}

// ── 2. 压缩后端 ─────────────────────────────────────────────────────────────

group("image：后端与压缩");
const fixture = await makeFixture();
if (fixture === undefined && ALLOW_NO_BACKEND) {
  console.log("  skip 没有 sharp，跳过硬采样断言（--no-backend-ok）");
} else {
  check(fixture !== undefined, "本机有可用的图片编码器（sharp）");
  if (fixture !== undefined) {
    const dir = await mkdtemp(join(tmpdir(), "dsh-image-budget-test-"));
    const file = join(dir, "big.png");
    await writeFile(file, fixture);
    check((await stat(file)).size > 100_000, "夹具足够大（>100KB）", `${(await stat(file)).size} B`);

    resetSharpCache();
    const budget = 120_000;
    const small = await compressToBudget(fixture, { ...DEFAULTS, maxImageBytes: budget });
    check(small !== undefined, "压到预算内");
    if (small !== undefined) {
      check(small.bytes <= budget, "产物 ≤ 预算", `${small.bytes} B`);
      check(typeof small.backend === "string" && small.backend.length > 0, "报告了实际后端", small.backend);
      const sharp = resolveSharp({});
      const meta = await sharp(small.data).metadata();
      check(meta.format === "jpeg", "产物是合法 JPEG", `${meta.format} ${meta.width}x${meta.height}`);
      check(meta.width > 0 && meta.width <= 900, "长边不超过梯子首档", String(meta.width));
    }

    const impossible = await compressToBudget(fixture, { ...DEFAULTS, maxImageBytes: 200, backends: ["none"] });
    check(impossible === undefined, "无可用后端时返回 undefined（调用方转拦截）");

    // 外部命令链：本机有哪个就单独验哪个
    for (const name of ["sips", "magick", "convert", "ffmpeg"]) {
      const only = await compressToBudget(fixture, { ...DEFAULTS, maxImageBytes: budget, backends: [name] });
      if (only === undefined) check(true, `外部后端 ${name} 不可用（跳过）`);
      else check(only.bytes <= budget && only.backend === name, `外部后端 ${name} 单独可用`, `${only.bytes} B`);
    }
    await rm(dir, { recursive: true, force: true });
  }
}

group("媒体类型嗅探（声明类型必须与字节一致）");
check(sniffMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])) === "image/jpeg", "JPEG SOI");
check(sniffMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) === "image/png", "PNG");
check(sniffMediaType(Buffer.from("RIFF....WEBPVP8 ")) === "image/webp", "WebP");
check(sniffMediaType(Buffer.from("GIF89a")) === "image/gif", "GIF");
check(sniffMediaType(Buffer.from("not an image")) === undefined, "无法识别返回 undefined");

if (REPORT) {
  group("本机后端");
  console.log(JSON.stringify(describeBackends(), null, 2));
}

process.exit(finish() === 0 ? 0 : 1);
