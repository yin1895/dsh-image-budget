#!/usr/bin/env node
/**
 * **本地集成测试**：把插件接到宿主**真实的**附件仓储
 * （`@deepseek-ai/dsh-attachment-local`）上，跑一遍守门的最短真实链路。
 *
 *   DSH_PACKAGES_DIR=/path/to/dsh/node_modules node test/attachment-local.mjs
 *
 * 这一层回答契约测试回答不了的问题：`attachments.saveImage()` 到底收不收我这份
 * `{data, mediaType, name}`，落盘后的引用是不是真的能读回来。
 *
 * 宿主的 DSH 包不在 npm 上（npm 上是 0.0.1 占位版本），所以这个测试**只能在
 * 装了 DSH 的机器上跑**；找不到包时以退出码 3 明确跳过，绝不静默通过。
 * CI 跑契约测试（真 cordis，npm 可得）；这个集成测试在本地跑。
 */

import { mkdtemp, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Context, HOST, boot, createReporter } from "./harness.mjs";
import * as plugin from "../lib/index.js";
import { compressToBudget } from "../lib/image.js";
import { describeBackends, resolveSharp } from "../lib/image.js";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, "..");
const { check, group, finish } = createReporter();

/** 找到 DSH 的包根（含 `@deepseek-ai/dsh-attachment-local`）。 */
function findPackagesDir() {
  const candidates = [process.env.DSH_PACKAGES_DIR, join(pluginDir, "node_modules")].filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "@deepseek-ai", "dsh-attachment-local", "lib", "index.js"))) return candidate;
  }
  return undefined;
}

const packagesDir = findPackagesDir();
if (packagesDir === undefined) {
  console.error(
    "SKIP：找不到 DSH 的包根（需要 @deepseek-ai/dsh-attachment-local）。\n" +
      "用法：DSH_PACKAGES_DIR=<DSH 的 node_modules> node test/attachment-local.mjs\n" +
      "例如把 app.asar 里的 dsh/node_modules 抽出来，或指向源码 checkout 的 node_modules。",
  );
  process.exit(3);
}

const storeModule = await import(pathToFileURL(join(packagesDir, "@deepseek-ai", "dsh-attachment-local", "lib", "index.js")).href);
const LocalAttachmentStore = storeModule.LocalAttachmentStore ?? storeModule.default;

/** 建一个临时 dshHome，起一个真实的附件仓储。 */
function bootStore() {
  const ctx = new Context();
  const dshHome = process.env.DSH_TEST_HOME;
  const store = new LocalAttachmentStore(ctx, { dshHome: dshHome ?? tmpdir(), imageCompressionConcurrency: 2 });
  return { ctx, store, dshHome };
}

/** 生成一张"截图感"的大 PNG（与 run.mjs 的夹具同源，保证足够大）。 */
async function makeFixture() {
  const sharp = resolveSharp({});
  if (sharp === undefined) return undefined;
  const width = 1400;
  const height = 980;
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels, 0xff);
  let state = 20261108 >>> 0;
  const random = () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
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

const fixture = await makeFixture();
if (fixture === undefined) {
  console.error("SKIP：本机没有可用的图片编码器（sharp），无法生成夹具。");
  process.exit(3);
}
console.log(`后端：${JSON.stringify(describeBackends())}`);

const workdir = await mkdtemp(join(tmpdir(), "dsh-image-budget-att-"));
process.env.DSH_TEST_HOME = workdir;

const BUDGET = 120_000;

// ── 1. 真实仓储收不收我这份输入 ─────────────────────────────────────────────
group("真实 attachments.saveImage()");
const { store } = bootStore();
const compressed = await compressToBudget(fixture, { maxImageBytes: BUDGET });
check(compressed !== undefined, "先压到预算内", compressed === undefined ? "" : `${compressed.bytes} B`);

let ref;
let thrown;
try {
  ref = await store.saveImage({ data: compressed.data, mediaType: "image/jpeg", name: "clip-budget.jpg" });
} catch (error) {
  thrown = error;
}
check(thrown === undefined, "saveImage({data, mediaType, name}) 被接受", thrown?.message ?? "");
if (ref !== undefined) {
  check(Number(ref.bytes) <= BUDGET, "落盘后的 bytes ≤ 预算", String(ref.bytes));
  check(ref.mediaType === "image/jpeg", "mediaType 保持 jpeg", String(ref.mediaType));
  check(typeof ref.attachmentId === "string" && ref.attachmentId.length > 0, "返回可用的 attachmentId", ref.attachmentId);

  const back = await store.readImage(ref);
  const bytes = back?.data ?? back;
  check(Number(bytes?.byteLength ?? bytes?.length) > 0, "readImage 能读回内容", String(bytes?.byteLength ?? bytes?.length));
  check(Number(bytes?.byteLength ?? bytes?.length) === Number(ref.bytes), "读回的字节数与引用一致");
}

// ── 2. 声明的 mediaType 与字节不符时必须被拒（证明"压不成 JPEG 就拦截"这条退路有意义）
group("真实仓储的校验（我的降级路径需要它）");
{
  let mismatch;
  try {
    await store.saveImage({ data: compressed.data, mediaType: "image/png", name: "wrong.png" });
  } catch (error) {
    mismatch = error;
  }
  check(mismatch !== undefined, "JPEG 字节声明成 image/png 会被拒绝", mismatch?.code ?? "");
}
{
  let tooLarge;
  try {
    await store.saveImage({ data: fixture, mediaType: "image/png", name: "big.png" });
  } catch (error) {
    tooLarge = error;
  }
  // 仓储的上限是 50MB，所以这张不该被它拒；这条断言反过来确认"仓储不会替我们
  // 挡住 token 意义上的大图"——那正是本插件存在的理由。
  check(tooLarge === undefined, "50MB 以内的图仓储照收（仓储不管 token 预算）", tooLarge?.code ?? "");
}

// ── 3. 端到端最短链路：真 cordis + 真仓储 + 本插件 ──────────────────────────
group("守门 × 真仓储（真 cordis 派发）");
{
  const ctx = boot(plugin, { maxImageBytes: BUDGET }, { attachments: store });
  const file = join(workdir, "bigshot.png");
  await (await import("node:fs/promises")).writeFile(file, fixture);
  const originalBytes = (await stat(file)).size;

  // 内容在 result 里（宿主的真实契约）；HOST.postExecute 返回宿主应用决策后的最终结果。
  const original = {
    isError: false,
    value: { path: file },
    content: [
      { type: "text", text: `<path>${file}</path>` },
      { type: "image", attachment: { attachmentId: "original", mediaType: "image/png", bytes: originalBytes, width: 1400, height: 980 } },
    ],
  };
  const final = await HOST.postExecute(ctx, { name: "read_image", agent: { id: "a" } }, original);
  const image = final?.content?.find((block) => block?.type === "image");
  check(image !== undefined, "结果里仍有图片块（是压缩后的副本，不是原图）");
  check(Number(image?.attachment?.bytes) <= BUDGET, "替换后的引用 ≤ 预算", String(image?.attachment?.bytes));
  check(image?.attachment?.attachmentId !== "original", "指向新附件", String(image?.attachment?.attachmentId));

  // 关键：这个引用必须是真实仓储里能读回来的对象
  let readable;
  let readError;
  try {
    readable = await store.readImage(image.attachment);
  } catch (error) {
    readError = error;
  }
  check(readError === undefined, "替换后的引用能被真实仓储读回（不是伪造引用）", readError?.message ?? "");
  check(Number(readable?.data?.byteLength ?? 0) > 0, "读回内容非空", String(readable?.data?.byteLength));
  const stats = plugin.getStats().at(-1);
  check(stats?.replaced === 1 && stats?.gated === 1, "统计记录了这次替换", JSON.stringify({ gated: stats?.gated, replaced: stats?.replaced }));

  // 真实节省：原图 vs 替换副本
  const sharp = resolveSharp({});
  const originalMeta = await sharp(fixture).metadata();
  const smallMeta = await sharp(readable.data).metadata();
  console.log(
    `  信息 ${originalBytes} B ${originalMeta.width}x${originalMeta.height} → ${readable.data.byteLength} B ` +
      `${smallMeta.width}x${smallMeta.height}（≈${(originalBytes / readable.data.byteLength).toFixed(1)}× 缩小）`,
  );
}

await rm(workdir, { recursive: true, force: true }).catch(() => {});
process.exit(finish() === 0 ? 0 : 1);
