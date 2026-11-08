#!/usr/bin/env node
/**
 * 回归测试：不启动 DSH，只用假的 ctx / session 覆盖三类行为。
 *
 *   node test/run.mjs            # 跑全部断言
 *   node test/run.mjs --report   # 额外打印本机后端探测结果
 *
 * 覆盖：
 *   1. plan 纯函数（溢出识别、图片索引、淘汰计划）
 *   2. 图片压缩（sharp 或任一外部命令），并验证产物是合法 JPEG
 *   3. 三个钩子的接线与语义（prepend、放行、拦截、救援）
 *
 * 测试自己在进程内生成图片，不依赖仓库里的二进制夹具，所以在
 * macOS / Linux / Windows 上跑的是同一份断言。
 */

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply, DEFAULTS } from "../lib/index.js";
import { compressToBudget, describeBackends, resetSharpCache, resolveSharp } from "../lib/image.js";
import { estimateTokens, imagesOf, looksLikeOverflow, planOffload } from "../lib/plan.js";

const REPORT = process.argv.includes("--report");
/** CI 的"无 sharp"作业用它：没有图片编码器时跳过硬采样断言，但仍验证拦截保证。 */
const ALLOW_NO_BACKEND = process.argv.includes("--no-backend-ok");
let failures = 0;
const results = [];

function check(ok, label, extra = "") {
  results.push({ ok, label, extra });
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
}

function group(title) {
  console.log(`\n${title}`);
}

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
 * 生成一张"截图感"的大 PNG：白底 + 稀疏黑块（像文字行），既足够大又压得动。
 * @returns 图片字节，或 undefined（本机拿不到图片编码器时）。
 */
async function makeFixture() {
  const sharp = resolveSharp({});
  if (sharp === undefined) return undefined;
  const width = 1400;
  const height = 980;
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels, 0xff);
  const random = lcg(20261108);
  // 先铺"文字行"（深色横条），再撒 12% 的灰噪点：PNG 压不动 → 夹具足够大，
  // 但整体仍是"白底黑字"，JPEG 能压到预算内，和真实截图的行为一致。
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
  const png = await sharp(raw, { raw: { width, height, channels } }).png({ compressionLevel: 6 }).toBuffer();
  return png;
}

/** 让 sharp 认得出产物是 JPEG，并取回尺寸。 */
async function probe(data) {
  const sharp = resolveSharp({});
  if (sharp === undefined) return { format: "unknown", width: 0, height: 0 };
  const meta = await sharp(data).metadata();
  return { format: meta.format, width: meta.width ?? 0, height: meta.height ?? 0 };
}

// ── 假 ctx / session ────────────────────────────────────────────────────────

function makeCtx(services = {}) {
  const handlers = new Map();
  const store = new Map(Object.entries(services));
  return {
    ctx: {
      on(event, handler, options) {
        const list = handlers.get(event) ?? [];
        list.push({ handler, options });
        handlers.set(event, list);
      },
      get(name) {
        return store.get(name);
      },
      set(name, value) {
        store.set(name, value);
        return value;
      },
    },
    handlers,
    hook(event) {
      return handlers.get(event)?.[0];
    },
  };
}

function makeSession(events) {
  const appended = [];
  return {
    appended,
    surface: { nodes: events.map((event) => event.seq) },
    eventAt(seq) {
      return events.find((event) => event.seq === seq);
    },
    deriveEventMessage(event) {
      return event.data.message ?? event.data;
    },
    append(type, data) {
      appended.push({ type, data });
    },
  };
}

const imageEvent = (seq, bytes, extra = []) => ({
  seq,
  type: "user/message",
  data: { message: { content: [{ type: "image", attachment: { bytes } }, ...extra] } },
});

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
  const message = {
    content: [
      { type: "text", text: "a" },
      { type: "image", attachment: { bytes: 10 } },
      { type: "text", text: "b" },
      { type: "image", attachment: { bytes: 20 }, offloaded: true },
      { type: "image", attachment: { bytes: 30 } },
    ],
  };
  const found = imagesOf(message);
  check(found.length === 2, "跳过已淘汰的图片", JSON.stringify(found));
  check(found[1].imageIndex === 2, "索引只数 image 块（含已淘汰的）", String(found[1].imageIndex));
}

group("plan：淘汰计划");
{
  const session = makeSession([imageEvent(1, 538_463), imageEvent(2, 655_858), imageEvent(3, 1_000)]);
  const plan = planOffload(session, [1, 2, 3], 100_000);
  check(plan.targets.length === 2, "两张都淘汰", JSON.stringify(plan.targets));
  check(plan.freed === 538_463 + 655_858, "freed 等于两张之和", String(plan.freed));

  const partial = planOffload(session, [1, 2, 3], 600_000);
  check(partial.targets.length === 1 && partial.targets[0].seq === 2, "只淘汰最大的一张就够", JSON.stringify(partial.targets));

  const none = planOffload(session, [3], 100_000);
  check(none.targets.length === 0, "已在预算内则不动");

  const empty = planOffload(makeSession([]), [], 1);
  check(empty.targets.length === 0 && empty.total === 0, "空会话安全");
  check(estimateTokens(538_463) === 490_540, "token 估算 = 0.911×字节", String(estimateTokens(538_463)));
}

// ── 2. 压缩后端 ─────────────────────────────────────────────────────────────

group("image：后端与压缩");
const fixture = await makeFixture();
if (fixture === undefined && ALLOW_NO_BACKEND) {
  console.log("  skip 没有 sharp，跳过硬采样断言（--no-backend-ok）");
} else {
  check(fixture !== undefined, "本机有可用的图片编码器（sharp）");
}
if (fixture !== undefined) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-image-budget-test-"));
  const file = join(dir, "big.png");
  await writeFile(file, fixture);
  const size = (await stat(file)).size;
  check(size > 100_000, "夹具足够大（>100KB）", `${size} B`);

  resetSharpCache();
  const budget = 120_000;
  const small = await compressToBudget(fixture, { ...DEFAULTS, maxImageBytes: budget });
  check(small !== undefined, "压到预算内");
  if (small !== undefined) {
    check(small.bytes <= budget, "产物 ≤ 预算", `${small.bytes} B`);
    check(small.backend.length > 0, "报告了实际后端", small.backend);
    const meta = await probe(small.data);
    check(meta.format === "jpeg", "产物是合法 JPEG", `${meta.format} ${meta.width}x${meta.height}`);
    check(meta.width > 0 && meta.width <= 900, "长边不超过梯子首档", String(meta.width));
  }

  const impossible = await compressToBudget(fixture, { ...DEFAULTS, maxImageBytes: 200, backends: ["none"] });
  check(impossible === undefined, "无可用后端时返回 undefined（调用方转拦截）");

  // 外部命令链：如果本机有 magick/sips/ffmpeg，关掉 sharp 也必须能压出来。
  for (const name of ["sips", "magick", "convert", "ffmpeg"]) {
    const only = await compressToBudget(fixture, { ...DEFAULTS, maxImageBytes: budget, backends: [name] });
    if (only === undefined) {
      check(true, `外部后端 ${name} 不可用（跳过）`);
    } else {
      check(only.bytes <= budget && only.backend === name, `外部后端 ${name} 单独可用`, `${only.bytes} B`);
    }
  }
  await rm(dir, { recursive: true, force: true });
}

// ── 3. 钩子 ─────────────────────────────────────────────────────────────────

group("hooks：接线");
{
  const { handlers } = makeCtx();
  apply(makeCtx().ctx, {});
  const ctx2 = makeCtx();
  apply(ctx2.ctx, {});
  check(ctx2.hook("tools/post-execute")?.options?.prepend === true, "post-execute prepend");
  check(ctx2.hook("compaction/summary-error")?.options?.prepend === true, "summary-error prepend");
  check(ctx2.hook("agent/request-error")?.options?.prepend === true, "request-error prepend");
  check(handlers.size === 0, "未注册任何多余事件");
}

group("hooks：守门");
if (fixture !== undefined) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-image-budget-gate-"));
  const file = join(dir, "big.png");
  await writeFile(file, fixture);
  const size = (await stat(file)).size;
  const decision = {
    kind: "accept",
    content: [
      { type: "text", text: `<path>${file}</path>` },
      { type: "image", attachment: { attachmentId: "old", mediaType: "image/png", bytes: size, width: 1400, height: 980 } },
    ],
  };

  // 超预算 → 替换
  {
    const { ctx, hook } = makeCtx({
      attachments: {
        async saveImage({ data, mediaType }) {
          return { attachmentId: "new", mediaType, bytes: data.byteLength, width: 900, height: 630, name: "x.jpg" };
        },
      },
    });
    apply(ctx, { maxImageBytes: 120_000 });
    const out = await hook("tools/post-execute").handler(
      { name: "read_image" },
      { isError: false, value: { path: file } },
      async () => decision,
    );
    const image = out.content.find((block) => block.type === "image");
    check(out.kind === "accept", "决策仍是 accept");
    check(image !== undefined && image.attachment.bytes <= 120_000, "替换后 ≤ 预算", `${image?.attachment?.bytes} B`);
    check(image?.attachment?.attachmentId === "new", "指向新附件");
    check(/已降采样/u.test(out.content[0].text), "文字给出换算说明");
  }

  // 无后端 → 拦截
  {
    const { ctx, hook } = makeCtx({
      attachments: { async saveImage() { throw new Error("should not be called"); } },
    });
    apply(ctx, { maxImageBytes: 120_000, backends: ["none"] });
    const out = await hook("tools/post-execute").handler(
      { name: "read_image" },
      { isError: false, value: { path: file } },
      async () => decision,
    );
    check(out.content.every((block) => block.type !== "image"), "图片块被移除");
    check(/read_image|--resize|sips -Z|magick/u.test(JSON.stringify(out.content)), "给出可执行指引");
  }

  // 仓储不听话（返回的字节仍超预算）→ 也要拦截
  {
    const { ctx, hook } = makeCtx({
      attachments: {
        async saveImage({ data, mediaType }) {
          return { attachmentId: "bad", mediaType, bytes: data.byteLength * 100, width: 900, height: 630 };
        },
      },
    });
    apply(ctx, { maxImageBytes: 120_000 });
    const out = await hook("tools/post-execute").handler(
      { name: "read_image" },
      { isError: false, value: { path: file } },
      async () => decision,
    );
    check(out.content.every((block) => block.type !== "image"), "仓储超限时降级为拦截");
  }

  // 已达标 → 原样放行
  {
    const { ctx, hook } = makeCtx();
    apply(ctx, { maxImageBytes: 10_000_000 });
    const out = await hook("tools/post-execute").handler(
      { name: "read_image" },
      { isError: false, value: { path: file } },
      async () => decision,
    );
    check(out === decision, "未超预算原样返回");
  }

  // 非 read_image 工具 → 不碰
  {
    const { ctx, hook } = makeCtx();
    apply(ctx, { maxImageBytes: 1 });
    const out = await hook("tools/post-execute").handler(
      { name: "read" },
      { isError: false, value: { path: file } },
      async () => decision,
    );
    check(out === decision, "其它工具不插手");
  }

  // dryRun → 不动作
  {
    const { ctx, hook } = makeCtx();
    apply(ctx, { dryRun: true, maxImageBytes: 1 });
    const out = await hook("tools/post-execute").handler(
      { name: "read_image" },
      { isError: false, value: { path: file } },
      async () => decision,
    );
    check(out === decision, "dryRun 全惰性");
  }
  await rm(dir, { recursive: true, force: true });
}

group("hooks：无后端时的核心保证");
{
  const { ctx, hook } = makeCtx();
  apply(ctx, { maxImageBytes: 120_000, backends: ["none"] });
  const decision = {
    kind: "accept",
    content: [
      { type: "text", text: "<path>/tmp/not-there.png</path>" },
      { type: "image", attachment: { attachmentId: "old", mediaType: "image/png", bytes: 538_463, width: 1790, height: 1258 } },
    ],
  };
  const out = await hook("tools/post-execute").handler(
    { name: "read_image" },
    { isError: false, value: { path: "/tmp/not-there.png" } },
    async () => decision,
  );
  check(out.content.every((block) => block.type !== "image"), "没有任何图片后端时也拦下超预算图");
  check(/sips|magick|--resize|read_image/u.test(JSON.stringify(out.content)), "给出跨平台的替代命令");
}

group("hooks：救援");
{
  const { ctx, hook } = makeCtx();
  apply(ctx, { summaryKeepImageBytes: 100_000 });
  const session = makeSession([imageEvent(10, 538_463), imageEvent(11, 655_858)]);
  const returned = await hook("compaction/summary-error").handler(
    { session, sourceEventSeqs: [10, 11], error: { message: "内容太长了，请精简输入或开启新对话" } },
    () => false,
  );
  check(returned === true, "返回 true 让宿主重跑摘要");
  check(session.appended.length === 1 && session.appended[0].type === "image/offload", "写入 image/offload");
  check(session.appended[0]?.data?.targets?.length === 2, "两张都进 targets", JSON.stringify(session.appended[0]?.data?.targets));
}
{
  const { ctx, hook } = makeCtx();
  apply(ctx, {});
  const session = makeSession([imageEvent(10, 538_463)]);
  const returned = await hook("compaction/summary-error").handler(
    { session, sourceEventSeqs: [10], error: { message: "rate limited" } },
    () => false,
  );
  check(returned === false && session.appended.length === 0, "非溢出错误不动手");
}
{
  const { ctx, hook } = makeCtx();
  apply(ctx, { maxRescuesPerStep: 1, summaryKeepImageBytes: 100_000 });
  const session = makeSession([imageEvent(10, 538_463), imageEvent(11, 655_858)]);
  const payload = { session, sourceEventSeqs: [10, 11], error: { message: "内容太长" } };
  check(await hook("compaction/summary-error").handler(payload, () => false) === true, "第一次救援发生");
  check(await hook("compaction/summary-error").handler(payload, () => false) === false, "同一 step 第二次不再救援（防活锁）");
}
{
  const { ctx, hook } = makeCtx();
  apply(ctx, { resumeSummary: false });
  const session = makeSession([imageEvent(10, 538_463)]);
  const returned = await hook("agent/request-error").handler(
    { agent: { session }, failure: { message: "prompt is too long" } },
    () => undefined,
  );
  check(returned?.kind === "retry", "主请求溢出后返回 retry");
  check(session.appended.length === 1, "写入了淘汰事件");
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

if (REPORT) {
  group("本机后端");
  console.log(JSON.stringify(describeBackends(), null, 2));
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed${failures === 0 ? "" : `, ${failures} failing`}`);
process.exit(failures === 0 ? 0 : 1);