/**
 * 跨平台图片压缩：把一张超预算的图片压到指定字节数以内。
 *
 * 为什么不能只调一个命令：`sips` 只有 macOS 有，`magick` 要用户自己装，
 * `ffmpeg` 不一定在 PATH，Windows 默认没有 Python。**唯一在所有 DSH 安装里
 * 都存在的图像能力是 DSH 自己带的 `sharp`**（`@deepseek-ai/dsh-attachment-local`
 * 用它做准入规范化），所以解析顺序是：
 *
 *   1. `sharpModule`（显式配置，插件作者/用户指定）
 *   2. **从宿主进程参数里找 DSH 安装根**（桌面端固定把 `<appRoot>` 放在 argv 里），
 *      再从那里 `createRequire(...)("sharp")` —— 这条在本机与其它机器上都成立；
 *   3. `import("sharp")`（插件旁边自己装了 sharp 的情况）；
 *   4. 环境变量 `DSH_APP_ROOT` / `DSH_RUNTIME_ROOT`；
 *   5. 外部命令链：`sips`（macOS）→ `magick` → `convert`（IM6）→ `ffmpeg`
 *      → `python`/`python3`/`py` + Pillow；
 *   6. 全部不可用 → 返回 `undefined`，由调用方"拦下图片 + 给指引"
 *      （**核心保证不变：超预算的图不会进入上下文**）。
 *
 * 所有子进程都用 `execFile` + argv 数组调用，不经过 shell —— Windows 上没有
 * 引号/转义差异，路径里有空格也不会散架。
 *
 * @module dsh-image-budget/image
 */

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/** 逐级尝试的顺序：先保清晰度，再保体积。 */
export const DEFAULT_EDGES = [900, 800, 700, 620, 540, 480];
export const DEFAULT_QUALITIES = [55, 45, 38, 30];

// ── sharp 解析 ──────────────────────────────────────────────────────────────

let sharpState; // undefined = 未尝试；null = 找不到；其余为模块

/**
 * 在给定基点解析一个 CJS 模块（sharp 是 CJS 导出函数）。
 * @param base - 解析基点：目录或文件路径。
 * @param spec - 模块名。
 */
function requireFrom(base, spec) {
  try {
    const require = createRequire(base);
    const resolved = require.resolve(spec);
    const loaded = require(resolved);
    const fn = typeof loaded === "function" ? loaded : loaded?.default;
    return typeof fn === "function" ? fn : undefined;
  } catch {
    return undefined;
  }
}

function asBase(pathLike) {
  if (typeof pathLike !== "string" || pathLike.length === 0) return undefined;
  try {
    const absolute = resolve(pathLike);
    if (existsSync(absolute) && statSync(absolute).isDirectory()) return join(absolute, "__resolve__.js");
    if (isAbsolute(absolute)) return absolute;
  } catch {
    /* 忽略非法路径 */
  }
  return undefined;
}

/**
 * 找到 sharp。结果按进程缓存（找不到也缓存，避免每张图都重试）。
 *
 * @param config - `{sharpModule?: string}`。
 * @returns sharp 的可调用导出，或 undefined。
 */
export function resolveSharp(config = {}) {
  if (sharpState !== undefined) return sharpState ?? undefined;

  const tries = [];
  if (typeof config.sharpModule === "string" && config.sharpModule.length > 0) {
    const direct = config.sharpModule === "sharp" ? undefined : asBase(config.sharpModule);
    if (direct !== undefined) tries.push(direct);
    // `sharpModule: "sharp"` 与显式路径都走"从该基点解析"
  }

  // 宿主进程参数：DSH 桌面端是 `<appRoot> <profileRoot>`，其它形态也常见。
  for (const arg of process.argv.slice(1)) {
    const base = asBase(arg);
    if (base !== undefined) tries.push(base);
  }

  // 插件自身位置（用户把 sharp 装在插件旁边时）。
  tries.push(join(dirname(fileURLToPath(import.meta.url)), "__resolve__.js"));

  for (const key of ["DSH_APP_ROOT", "DSH_RUNTIME_ROOT", "DSH_HOME"]) {
    const base = asBase(process.env[key]);
    if (base !== undefined) tries.push(base);
  }

  for (const base of tries) {
    const sharp = requireFrom(base, "sharp");
    if (sharp !== undefined) {
      sharpState = sharp;
      return sharp;
    }
  }
  sharpState = null;
  return undefined;
}

/** 本轮实际用到的后端，供诊断。 */
export const backendReport = { sharp: false, cli: [], failed: [] };

// ── 外部命令后端 ────────────────────────────────────────────────────────────

/** 把 JPEG 质量（0-100，越大越好）映射成 ffmpeg 的 `-q:v`（2-31，越小越好）。 */
function ffmpegQ(quality) {
  return String(Math.max(2, Math.min(31, Math.round(31 - (quality / 100) * 29))));
}

/**
 * 构造外部命令候选。每个候选给出 `{id, cmd, args(outPath)}`；
 * 命令不存在时由调用方按 ENOENT 直接淘汰（不预先探测，省掉一轮子进程）。
 */
function candidates({ edge, quality, input }) {
  const scale = `scale=${edge}:${edge}:force_original_aspect_ratio=decrease`;
  const list = [];

  if (process.platform === "darwin") {
    list.push({
      id: "sips",
      cmd: "sips",
      args: (out) => ["-s", "format", "jpeg", "-s", "formatOptions", String(quality), "-Z", String(edge), input, "--out", out],
    });
  }
  list.push({
    id: "magick",
    cmd: "magick",
    args: (out) => [input, "-auto-orient", "-resize", `${edge}x${edge}>`, "-quality", String(quality), out],
  });
  list.push({
    id: "convert",
    cmd: "convert",
    args: (out) => [input, "-auto-orient", "-resize", `${edge}x${edge}>`, "-quality", String(quality), out],
  });
  list.push({
    id: "ffmpeg",
    cmd: "ffmpeg",
    args: (out) => ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-vf", scale, "-q:v", ffmpegQ(quality), out],
  });
  const pillow = [
    "-c",
    "import sys;from PIL import Image;im=Image.open(sys.argv[1]);im.thumbnail((int(sys.argv[2]),int(sys.argv[2])));im.convert('RGB').save(sys.argv[3],'JPEG',quality=int(sys.argv[4]),optimize=True)",
  ];
  for (const python of ["python3", "python", "py"]) {
    list.push({
      id: pillowId(python),
      cmd: python,
      args: (out) => [...(python === "py" ? ["-3"] : []), ...pillow, input, String(edge), out, String(quality)],
    });
  }
  return list;
}

function pillowId(python) {
  return `pillow:${python}`;
}

// ── 压缩主流程 ──────────────────────────────────────────────────────────────

/**
 * 把图片压到 `cfg.maxImageBytes` 以内。
 *
 * @param bytes - 原始图片字节。
 * @param cfg - `{maxImageBytes, edges, qualities, sharpModule, backends}`。
 * @returns `{data, bytes, width, height, backend, edge, quality}`，压不进预算时 undefined。
 */
export async function compressToBudget(bytes, cfg) {
  const maxBytes = Number(cfg.maxImageBytes);
  const edges = Array.isArray(cfg.edges) && cfg.edges.length > 0 ? cfg.edges : DEFAULT_EDGES;
  const qualities = Array.isArray(cfg.qualities) && cfg.qualities.length > 0 ? cfg.qualities : DEFAULT_QUALITIES;

  const sharp = allowSharp(cfg) ? resolveSharp(cfg) : undefined;
  if (sharp !== undefined) {
    const result = await compressWithSharp(sharp, bytes, { maxBytes, edges, qualities });
    if (result !== undefined) {
      backendReport.sharp = true;
      return result;
    }
  }
  return compressWithCli(bytes, { maxBytes, edges, qualities, backends: cfg.backends });
}

/** 配置里可以显式关掉某个后端：`backends: ["sharp"]` 只允许 sharp。 */
function allowSharp(cfg) {
  const list = cfg.backends;
  if (!Array.isArray(list) || list.length === 0) return true;
  return list.includes("sharp");
}

async function compressWithSharp(sharp, bytes, { maxBytes, edges, qualities }) {
  let best;
  for (const edge of edges) {
    for (const quality of qualities) {
      let output;
      try {
        output = await sharp(bytes, { failOn: "error", limitInputPixels: false })
          .rotate()
          .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality, mozjpeg: true, chromaSubsampling: "4:2:0" })
          .toBuffer({ resolveWithObject: true });
      } catch (error) {
        backendReport.failed.push(`sharp: ${String(error?.message ?? error)}`);
        return undefined;
      }
      const data = output.data;
      const size = data.byteLength;
      if (size <= maxBytes) {
        return { data, bytes: size, width: output.info.width, height: output.info.height, backend: "sharp", edge, quality };
      }
      if (best === undefined || size < best.bytes) {
        best = { data, bytes: size, width: output.info.width, height: output.info.height, backend: "sharp", edge, quality };
      }
    }
  }
  return undefined;
}

async function compressWithCli(bytes, { maxBytes, edges, qualities, backends }) {
  const allowed = Array.isArray(backends) && backends.length > 0 ? backends : undefined;
  const dir = await mkdtemp(join(tmpdir(), "dsh-image-budget-"));
  try {
    const input = join(dir, "in.img");
    await writeFile(input, bytes);
    const dead = new Set();

    for (const edge of edges) {
      for (const quality of qualities) {
        for (const candidate of candidates({ edge, quality, input })) {
          if (dead.has(candidate.id)) continue;
          if (allowed !== undefined && !allowed.some((name) => candidate.id === name || candidate.id.startsWith(`${name}:`))) continue;
          const out = join(dir, `out-${candidate.id.replace(/[^\w.]/gu, "_")}-${edge}-${quality}.jpg`);
          try {
            await run(candidate.cmd, candidate.args(out), { timeout: 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
          } catch (error) {
            if (error?.code === "ENOENT") dead.add(candidate.id);
            else backendReport.failed.push(`${candidate.id}: ${String(error?.message ?? error).slice(0, 200)}`);
            continue;
          }
          let size = 0;
          try {
            size = (await stat(out)).size;
          } catch {
            continue;
          }
          if (size === 0 || size > maxBytes) continue;
          const data = await readFile(out);
          if (!backendReport.cli.includes(candidate.id)) backendReport.cli.push(candidate.id);
          return { data, bytes: size, width: 0, height: 0, backend: candidate.id, edge, quality };
        }
      }
    }
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 仅供测试：清掉 sharp 解析缓存。 */
export function resetSharpCache() {
  sharpState = undefined;
  backendReport.sharp = false;
  backendReport.cli.length = 0;
  backendReport.failed.length = 0;
}

/** 灰盒诊断：当前进程能解析到哪些后端。 */
export function describeBackends(config = {}) {
  const sharp = resolveSharp(config);
  const pathDirs = String(process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const has = (name) => {
    const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
    return pathDirs.some((dir) => exts.some((ext) => existsSync(join(dir, name + ext))));
  };
  return {
    sharp: sharp !== undefined,
    platform: process.platform,
    cli: { sips: has("sips"), magick: has("magick"), convert: has("convert"), ffmpeg: has("ffmpeg"), python3: has("python3"), python: has("python"), py: has("py") },
  };
}